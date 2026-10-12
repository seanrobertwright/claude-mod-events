import type { Timer } from 'claude-code'
import type { Config } from './config'
import { type Envelope, type EventData, type EventType, newBootId, nowMs } from './events'
import type { Ports } from './ports'

/** Events held while the host is unreachable; past it the oldest go. */
export const QUEUE_CAP = 1000
/** Events per POST. */
export const BATCH_SIZE = 200
/** How long an emit waits before its batch goes, so a burst shares one POST. */
export const FLUSH_DELAY_MS = 100
export const BACKOFF_START_MS = 250
export const BACKOFF_MAX_MS = 5000

export function authHeaders(config: Config): Record<string, string> {
  return config.token === undefined ? {} : { authorization: `Bearer ${config.token}` }
}

type SendOutcome = 'sent' | 'retry' | 'rejected'

/**
 * Holds events and POSTs them to the host in batches.
 *
 * It starts `pending` and queues what it is given, since events can arrive
 * before the config is read. `start` turns it on and sends what is queued;
 * `disable` drops the queue and ignores every later emit.
 */
export class Outbox {
  private readonly boot = newBootId()
  private queue: Envelope[] = []
  /** Events dropped and not yet reported to the host. */
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

  emit(type: EventType, data: EventData, sessionId: string | undefined = this.sessionId): void {
    if (this.state === 'off') return
    this.queue.push(this.envelope(type, data, sessionId))
    this.trim()
    this.schedule(FLUSH_DELAY_MS)
  }

  start(ports: Ports, config: Config): void {
    if (this.state !== 'pending') return
    this.ports = ports
    this.config = config
    this.state = 'on'
    if (this.queue.length > 0) this.schedule(0)
  }

  disable(): void {
    this.state = 'off'
    this.queue = []
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

  private trim(): void {
    const over = this.queue.length - QUEUE_CAP
    if (over > 0) {
      this.queue.splice(0, over)
      this.dropped += over
    }
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
    const batch = this.queue.splice(0, droppedNow > 0 ? BATCH_SIZE - 1 : BATCH_SIZE)
    if (droppedNow > 0) {
      if (this.noticeSeq === undefined) {
        this.seq += 1
        this.noticeSeq = this.seq
      }
      batch.unshift(this.envelope('outbox.dropped', { count: droppedNow }, batch[0]?.sessionId ?? this.sessionId, this.noticeSeq))
    }
    if (batch.length === 0) return 'sent'
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
    this.queue.unshift(...(droppedNow > 0 ? batch.slice(1) : batch))
    this.trim()
    return 'retry'
  }
}
