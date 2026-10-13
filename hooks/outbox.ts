import type { Timer } from 'claude-code'
import type { OutboxCarry } from '../types'
import type { Config } from './config'
import { type Envelope, type EventData, type EventType, field, isRecord, newBootId, nowMs, parseEnvelope } from './events'
import type { Ports } from './ports'

/** Events held while the host is unreachable; past it the oldest go. */
export const QUEUE_CAP = 1000
/** Events per POST. */
export const BATCH_SIZE = 200
/**
 * How many events a carry holds. A load's own events fill what an earlier
 * load's leave of it, and those past it count as dropped; an earlier load's
 * events are kept even past it.
 */
export const CARRY_LIMIT = BATCH_SIZE
/** How long an emit waits before its batch goes, so a burst shares one POST. */
export const FLUSH_DELAY_MS = 100
export const BACKOFF_START_MS = 250
export const BACKOFF_MAX_MS = 5000

export function authHeaders(config: Config): Record<string, string> {
  return config.token === undefined ? {} : { authorization: `Bearer ${config.token}` }
}

type SendOutcome = 'sent' | 'retry' | 'rejected'

/** Where `boot`'s first event sits in `events`, or the end when it has none there. */
function indexOfBoot(events: readonly Envelope[], boot: string): number {
  const at = events.findIndex(event => event.boot === boot)
  return at < 0 ? events.length : at
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A carry as read back, its events checked as envelopes. */
export type Carry = Omit<OutboxCarry, 'events'> & { readonly events: readonly Envelope[] }

/**
 * A carry read back from `$.state`, or undefined when it is not one. The load
 * that wrote it may have been another version of the mod.
 */
export function parseOutboxCarry(raw: unknown): Carry | undefined {
  if (!isRecord(raw)) return undefined
  const boot = field(raw, 'boot')
  const rawEvents = field(raw, 'events')
  const dropped = field(raw, 'dropped')
  const noticeSeq = field(raw, 'noticeSeq')
  if (typeof boot !== 'string' || boot === '' || !Array.isArray(rawEvents) || !isCount(dropped)) return undefined
  if (dropped > 0 ? !isCount(noticeSeq) || noticeSeq === 0 : noticeSeq !== null) return undefined
  const events: Envelope[] = []
  for (const rawEvent of rawEvents) {
    const event = parseEnvelope(rawEvent)
    if (event === undefined) return undefined
    events.push(event)
  }
  return { boot, events, dropped, noticeSeq: dropped > 0 ? (noticeSeq as number) : null }
}

/**
 * Holds events and POSTs them to the host in batches.
 *
 * It starts `pending` and queues what it is given, since events can arrive
 * before the config is read. `start` turns it on and sends what is queued;
 * `disable` drops the queue and ignores every later emit.
 *
 * A hot reload starts a fresh copy, so once on it keeps what the host has not
 * acknowledged in `$.state`, through `ports.carryOutbox`: the events up to
 * CARRY_LIMIT and a count of the rest. The copy the reload starts is handed
 * that carry and sends it first, each event under its own boot and seq.
 */
export class Outbox {
  private readonly boot = newBootId()
  private queue: Envelope[] = []
  /** The POST in flight, as sent: unacknowledged until it lands. */
  private sending: Envelope[] = []
  /** The count of the drop notice in that POST, or 0. */
  private sendingNotice = 0
  /** Events of this boot dropped and not yet reported to the host. */
  private dropped = 0
  /** The seq the next drop notice goes out under, kept across retries so a retry opens no gap. */
  private noticeSeq: number | undefined
  private seq = 0
  private state: 'pending' | 'on' | 'off' = 'pending'
  private ports: Ports | undefined
  private config: Config | undefined
  private timer: Timer | undefined
  private inFlight: Promise<SendOutcome> | undefined
  private backoffMs = 0
  private hostDown = false
  private rejectionLogged = false
  private carryPending = false

  /** The session events are stamped with; the hooks keep it current. */
  sessionId: string | undefined

  get isOff(): boolean {
    return this.state === 'off'
  }

  get queued(): number {
    return this.queue.length
  }

  get droppedCount(): number {
    return this.dropped
  }

  /** This load's boot, stamped on its events. */
  get bootId(): string {
    return this.boot
  }

  emit(type: EventType, data: EventData, sessionId: string | undefined = this.sessionId): void {
    if (this.state === 'off') return
    this.queue.push(this.envelope(type, data, sessionId))
    this.trim()
    this.schedule(FLUSH_DELAY_MS)
    this.carrySoon()
  }

  /** Turns the outbox on. `carry` is what an earlier load of the module left unsent. */
  start(ports: Ports, config: Config, carry?: Carry): void {
    if (this.state !== 'pending') return
    this.ports = ports
    this.config = config
    this.state = 'on'
    if (carry !== undefined && carry.boot !== this.boot) this.adopt(carry)
    this.carrySoon()
    if (this.queue.length > 0) this.schedule(0)
  }

  disable(): void {
    this.state = 'off'
    this.queue = []
    this.sending = []
    this.sendingNotice = 0
    this.dropped = 0
    this.noticeSeq = undefined
    this.timer?.cancel()
    this.timer = undefined
  }

  /**
   * Sends what is queued now, for `session.end`. Stops at the first batch the
   * host does not take; the end's own bound aborts a request still in flight.
   */
  async flushNow(): Promise<void> {
    this.timer?.cancel()
    this.timer = undefined
    if (this.state !== 'on') return
    if (this.inFlight !== undefined) await this.inFlight
    while (this.queue.length > 0 || this.dropped > 0) {
      const outcome = await this.sendBatch()
      if (outcome !== 'sent') return
    }
  }

  private envelope(type: EventType, data: EventData, sessionId: string | undefined, seq?: number): Envelope {
    if (seq === undefined) {
      this.seq += 1
      seq = this.seq
    }
    return {
      v: 1,
      boot: this.boot,
      seq,
      ts: nowMs(),
      sessionId,
      // Stamped when the batch goes: events can be queued before the config is read.
      tag: undefined,
      type,
      data,
    }
  }

  /**
   * Puts what an earlier load left unsent ahead of this load's events, with a
   * notice for what that load dropped ahead of its own events.
   */
  private adopt(carry: Carry): void {
    const events = [...carry.events]
    if (carry.dropped > 0 && carry.noticeSeq !== null) {
      const at = indexOfBoot(events, carry.boot)
      events.splice(at, 0, {
        v: 1,
        boot: carry.boot,
        seq: carry.noticeSeq,
        ts: nowMs(),
        sessionId: events[at]?.sessionId ?? this.sessionId,
        tag: undefined,
        type: 'outbox.dropped',
        data: { count: carry.dropped },
      })
    }
    this.queue.unshift(...events)
  }

  /**
   * What a load that replaced this one would need. An earlier load's events
   * are kept whole and this load's own fill the rest of CARRY_LIMIT; each one
   * past it counts as dropped, and a notice in flight that is cut counts as
   * the events it reports.
   */
  private carry(): OutboxCarry {
    const pending = [...this.sending, ...this.queue]
    const events = pending.slice(0, Math.max(indexOfBoot(pending, this.boot), CARRY_LIMIT))
    let dropped = this.dropped - this.sendingNotice
    for (const event of pending.slice(events.length)) dropped += event.type === 'outbox.dropped' ? this.sendingNotice : 1
    // A notice in flight keeps its seq for its own count; what is left needs a new one.
    const noticeSeq = this.sendingNotice > 0 || this.noticeSeq === undefined ? this.seq + 1 : this.noticeSeq
    return { boot: this.boot, events, dropped, noticeSeq: dropped > 0 ? noticeSeq : null }
  }

  /** Writes the carry once the change under way is done, so a burst writes it once. */
  private carrySoon(): void {
    if (this.carryPending || this.state !== 'on') return
    this.carryPending = true
    void Promise.resolve().then(() => {
      this.carryPending = false
      if (this.state === 'on') this.ports?.carryOutbox(this.carry())
    })
  }

  private trim(): void {
    const over = this.queue.length - QUEUE_CAP
    if (over <= 0) return
    // An earlier load's events stay, so each boot's drops are reported under that boot.
    this.dropped += this.queue.splice(indexOfBoot(this.queue, this.boot), over).length
  }

  private schedule(delayMs: number): void {
    if (this.state !== 'on' || this.timer !== undefined || this.inFlight !== undefined || this.ports === undefined) return
    this.timer = this.ports.after(delayMs, () => {
      this.timer = undefined
      void this.flush()
    })
  }

  private async flush(): Promise<void> {
    if (this.inFlight !== undefined) return
    const outcome = await this.sendBatch()
    if (outcome === 'retry') {
      this.backoffMs = this.backoffMs === 0 ? BACKOFF_START_MS : Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
      this.schedule(this.backoffMs)
      return
    }
    this.backoffMs = 0
    if (this.queue.length > 0 || this.dropped > 0) this.schedule(0)
  }

  /** POSTs one batch, one at a time. A retryable failure puts the batch back at the front. */
  private sendBatch(): Promise<SendOutcome> {
    const sending = this.post().finally(() => {
      this.inFlight = undefined
      this.carrySoon()
    })
    this.inFlight = sending
    return sending
  }

  private async post(): Promise<SendOutcome> {
    const ports = this.ports
    const config = this.config
    if (ports === undefined || config === undefined) return 'retry'
    // The count is taken now; drops while the POST is out stay counted for the next notice.
    const droppedNow = this.dropped
    // A drop notice takes one of the batch's places, so no POST holds more than BATCH_SIZE.
    const events = this.queue.splice(0, droppedNow > 0 ? BATCH_SIZE - 1 : BATCH_SIZE)
    const batch = [...events]
    if (droppedNow > 0) {
      if (this.noticeSeq === undefined) {
        this.seq += 1
        this.noticeSeq = this.seq
      }
      // Ahead of this boot's own events, behind any an earlier load left.
      const at = indexOfBoot(events, this.boot)
      batch.splice(at, 0, this.envelope('outbox.dropped', { count: droppedNow }, events[at]?.sessionId ?? this.sessionId, this.noticeSeq))
    }
    if (batch.length === 0) return 'sent'
    this.sending = batch
    this.sendingNotice = droppedNow
    this.carrySoon()
    const reported = () => {
      this.dropped -= droppedNow
      if (droppedNow > 0) this.noticeSeq = undefined
    }

    let status: number | undefined
    try {
      const response = await ports.fetch(`${config.url}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(config) },
        body: JSON.stringify({ events: batch.map(event => ({ ...event, tag: config.tag })) }),
      })
      status = response.status
    } catch {
      status = undefined
    }
    // Settled: below, in the same turn of the loop, the batch is counted done or put back.
    this.sending = []
    this.sendingNotice = 0

    if (status !== undefined && status >= 200 && status < 300) {
      if (this.hostDown) {
        this.hostDown = false
        ports.log('host reachable again', 'debug')
      }
      reported()
      return 'sent'
    }

    // 408 and 429 are the host asking us to come back; other 4xx are refusals
    // that a retry would only repeat (a wrong token, a host that does not
    // speak this protocol), so that batch is dropped.
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      if (!this.rejectionLogged) {
        this.rejectionLogged = true
        ports.log(`the host refused events with HTTP ${status}; dropping them`, 'transcript')
      }
      reported()
      return 'rejected'
    }

    if (!this.hostDown) {
      this.hostDown = true
      ports.log(`host unreachable (${status === undefined ? 'no response' : `HTTP ${status}`}); holding up to ${QUEUE_CAP} events`, 'debug')
    }
    // Back to the front without the notice: the count stays in `dropped`
    // and the next batch carries it under the same seq.
    this.queue.unshift(...events)
    this.trim()
    return 'retry'
  }
}
