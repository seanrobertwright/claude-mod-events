import type { Timer } from 'claude-code'
import type { OutboxCarry } from '../types'
import type { Config } from './config'
import { type Envelope, type EventData, type EventType, field, isRecord, newBootId, nowMs, parseEnvelope, toWire } from './events'
import type { Ports } from './ports'

/** Events held while the host is unreachable; past it the oldest of this boot's go, its `boot.started` aside. */
export const QUEUE_CAP = 1000
/** Events per POST. */
export const BATCH_SIZE = 200
/*
 * Claude Code refuses a request body longer than 4 MiB of characters
 * (4,194,304) before it is sent, and `$.state` a value whose JSON is longer,
 * as measured on 2.1.296. The limits below keep well under that.
 */
/** Characters of JSON per POST, the tag stamped on each event included. */
export const MAX_BATCH_CHARS = 3 * 1024 * 1024
/** Characters of JSON one event may take, `tag` aside; a longer one is cut to summary detail, or dropped if that is not enough. */
export const MAX_EVENT_CHARS = 1024 * 1024
/** Room kept in each POST for the body around the events and a drop notice. */
const BATCH_OVERHEAD_CHARS = 1024
/**
 * How many events a carry holds. A load's own events fill what an earlier
 * load's leave of it and of MAX_CARRY_CHARS, and those past either count as
 * dropped; an earlier load's events, and the load's `boot.started`, are kept
 * even past them.
 */
export const CARRY_LIMIT = BATCH_SIZE
/** Characters of JSON a carry's events may take, likewise. */
export const MAX_CARRY_CHARS = 3 * 1024 * 1024
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

/**
 * Where `boot`'s events after its `boot.started` begin in `events`: its first
 * event, or the one behind that when it is the `boot.started`. A drop notice
 * goes here, and a trim or a carry's limits start here, so nothing else of a
 * boot goes ahead of its `boot.started`.
 */
function indexAfterBootStarted(events: readonly Envelope[], boot: string): number {
  const at = indexOfBoot(events, boot)
  return events[at]?.type === 'boot.started' ? at + 1 : at
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
 * before the config is read. `start` turns it on and sends what is queued,
 * behind the boot's `boot.started`; `disable` drops the queue and ignores
 * every later emit. Nothing drops a `boot.started` to make room, and a drop
 * notice goes behind it, so no other event of its boot arrives ahead of it.
 *
 * A hot reload starts a fresh copy, so once on it keeps what the host has not
 * acknowledged in `$.state`, through `ports.carryOutbox`: the events up to
 * CARRY_LIMIT and MAX_CARRY_CHARS, and a count of the rest. The copy the reload starts is handed
 * that carry and sends it first, each event under its own boot and seq.
 */
export class Outbox {
  private readonly boot = newBootId()
  /** Every event here fits MAX_EVENT_CHARS, so any one of them makes a batch on its own. */
  private queue: Envelope[] = []
  /** The length of each event's JSON, `tag` aside, worked out once. */
  private readonly lengths = new WeakMap<Envelope, number>()
  /** The POST in flight, as sent: unacknowledged until it lands. */
  private sending: Envelope[] = []
  /** The count of the drop notice in that POST, or 0. */
  private sendingNotice = 0
  /** Events of this boot dropped and not yet reported to the host. */
  private dropped = 0
  /** The seq the next drop notice goes out under, kept across retries so a retry opens no gap. */
  private noticeSeq: number | undefined
  /** The last seq taken. Seq 1 is kept for the boot's `boot.started`, which `start` puts ahead of the boot's other events. */
  private seq = 1
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
    const event = this.fit(this.envelope(type, data, sessionId))
    // Too long even when cut: its seq is the gap the drop notice explains.
    if (event === undefined) this.dropped += 1
    else this.queue.push(event)
    this.trim()
    this.schedule(FLUSH_DELAY_MS)
    this.carrySoon()
  }

  /**
   * Turns the outbox on. `bootStarted` is the data of this boot's
   * `boot.started`, which goes under seq 1 ahead of every event queued so far;
   * `carry` is what an earlier load of the module left unsent, which goes
   * ahead of both.
   */
  start(ports: Ports, config: Config, carry?: Carry, bootStarted?: EventData): void {
    if (this.state !== 'pending') return
    this.ports = ports
    this.config = config
    this.state = 'on'
    if (bootStarted !== undefined) this.queue.unshift(this.envelope('boot.started', bootStarted, this.sessionId, 1))
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
    // Each was fitted by the load that queued it. One that another version of
    // the mod carried is fitted here, and left out if it cannot be.
    const events = carry.events.flatMap(event => this.fit(event) ?? [])
    if (carry.dropped > 0 && carry.noticeSeq !== null) {
      const at = indexAfterBootStarted(events, carry.boot)
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
   * and this load's `boot.started` are kept whole, and this load's other
   * events fill the rest of CARRY_LIMIT and MAX_CARRY_CHARS; each one past
   * either counts as dropped, and a notice in flight that is cut counts as
   * the events it reports.
   */
  private carry(): OutboxCarry {
    const pending = [...this.sending, ...this.queue]
    const whole = indexAfterBootStarted(pending, this.boot)
    let kept = 0
    let chars = 0
    for (const event of pending) {
      chars += this.lengthOf(event) + 1
      if (kept >= whole && (kept >= CARRY_LIMIT || chars > MAX_CARRY_CHARS)) break
      kept += 1
    }
    const events = pending.slice(0, kept)
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

  /** The length of `event`'s JSON, `tag` aside. */
  private lengthOf(event: Envelope): number {
    let length = this.lengths.get(event)
    if (length === undefined) {
      length = JSON.stringify(event).length
      this.lengths.set(event, length)
    }
    return length
  }

  /** `event` cut to summary detail when its JSON is longer than MAX_EVENT_CHARS, or undefined when that is not enough. */
  private fit(event: Envelope): Envelope | undefined {
    if (this.lengthOf(event) <= MAX_EVENT_CHARS) return event
    const data = toWire(event.data, 'summary')
    if (!isRecord(data)) return undefined
    // `toWire` gives an object back as an object of JSON values.
    const cut: Envelope = { ...event, data: data as EventData }
    return this.lengthOf(cut) <= MAX_EVENT_CHARS ? cut : undefined
  }

  /**
   * Takes the next batch off the queue: up to `count` events whose JSON, each
   * with the tag it is stamped with, fits MAX_BATCH_CHARS. The first always
   * goes, since every queued event fits on its own.
   */
  private takeBatch(count: number, config: Config): Envelope[] {
    const tagChars = config.tag === undefined ? 0 : ',"tag":'.length + JSON.stringify(config.tag).length
    let chars = BATCH_OVERHEAD_CHARS
    let taken = 0
    for (const event of this.queue) {
      const length = this.lengthOf(event) + tagChars + 1
      if (taken === count || (taken > 0 && chars + length > MAX_BATCH_CHARS)) break
      chars += length
      taken += 1
    }
    return this.queue.splice(0, taken)
  }

  private trim(): void {
    const over = this.queue.length - QUEUE_CAP
    if (over <= 0) return
    // An earlier load's events stay, so each boot's drops are reported under that boot, and so does this boot's boot.started.
    this.dropped += this.queue.splice(indexAfterBootStarted(this.queue, this.boot), over).length
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
    // A drop notice takes one of the batch's places, so no POST holds more than BATCH_SIZE.
    const events = this.takeBatch(this.dropped > 0 ? BATCH_SIZE - 1 : BATCH_SIZE, config)
    // The count is taken now; drops while the POST is out stay counted for the next notice.
    // While this boot's boot.started is still queued behind the batch, the notice waits for it.
    const droppedNow = this.queue.some(event => event.boot === this.boot && event.type === 'boot.started') ? 0 : this.dropped
    const batch = [...events]
    if (droppedNow > 0) {
      if (this.noticeSeq === undefined) {
        this.seq += 1
        this.noticeSeq = this.seq
      }
      // Ahead of this boot's own events but its boot.started, behind any an earlier load left.
      const at = indexAfterBootStarted(events, this.boot)
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
