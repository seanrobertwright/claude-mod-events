import type { Timer } from 'claude-code'
import type { InboxCarry } from '../types'
import type { Config } from './config'
import { field, isRecord } from './events'
import { type Outbox, authHeaders } from './outbox'
import type { Ports } from './ports'

/** A poll that came back sooner than this with nothing waits out the rest, so a host that does not hold the request is not hammered. */
export const MIN_POLL_INTERVAL_MS = 1000
export const POLL_BACKOFF_MAX_MS = 5000
/** After the host refuses a poll outright (a wrong token), try again this rarely. */
export const REFUSED_RETRY_MS = 30_000

export const MAX_ID_LENGTH = 256
export const MAX_PROMPT_LENGTH = 100_000
export const MAX_TOAST_LENGTH = 2000
export const MAX_COMMANDS_PER_POLL = 50

export type Command =
  | { readonly id: string; readonly type: 'prompt'; readonly text: string; readonly asUser: boolean }
  | { readonly id: string; readonly type: 'interrupt' }
  | { readonly id: string; readonly type: 'toast'; readonly text: string }

export type CommandRejection = { readonly id: string | undefined; readonly error: string }

/** One command from the host, or why it is refused. */
export function parseCommand(raw: unknown): { ok: true; command: Command } | { ok: false; rejection: CommandRejection } {
  if (!isRecord(raw)) return { ok: false, rejection: { id: undefined, error: 'a command must be an object' } }
  const id = field(raw, 'id')
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
    return { ok: false, rejection: { id: undefined, error: `a command needs an id of 1 to ${MAX_ID_LENGTH} characters` } }
  }
  const reject = (error: string) => ({ ok: false as const, rejection: { id, error } })
  const type = field(raw, 'type')
  switch (type) {
    case 'prompt': {
      const text = field(raw, 'text')
      if (typeof text !== 'string' || text.trim() === '') return reject('prompt needs a non-empty text')
      if (text.length > MAX_PROMPT_LENGTH) return reject(`prompt text is longer than ${MAX_PROMPT_LENGTH} characters`)
      const asUser = field(raw, 'asUser')
      if (asUser !== undefined && typeof asUser !== 'boolean') return reject('asUser must be a boolean')
      return { ok: true, command: { id, type, text, asUser: asUser === true } }
    }
    case 'interrupt':
      return { ok: true, command: { id, type } }
    case 'toast': {
      const text = field(raw, 'text')
      if (typeof text !== 'string' || text.trim() === '') return reject('toast needs a non-empty text')
      if (text.length > MAX_TOAST_LENGTH) return reject(`toast text is longer than ${MAX_TOAST_LENGTH} characters`)
      return { ok: true, command: { id, type, text } }
    }
    default:
      return reject(`unknown command type ${JSON.stringify(type)}`)
  }
}

/** The body of a 200 from `/v1/commands`: `{ commands: [...] }`. */
export function parseCommands(body: string): { commands: Command[]; rejections: CommandRejection[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { commands: [], rejections: [{ id: undefined, error: 'the command response is not JSON' }] }
  }
  const list = isRecord(parsed) ? field(parsed, 'commands') : undefined
  if (!Array.isArray(list)) {
    return { commands: [], rejections: [{ id: undefined, error: 'the command response has no commands array' }] }
  }
  const commands: Command[] = []
  const rejections: CommandRejection[] = []
  for (const raw of list.slice(0, MAX_COMMANDS_PER_POLL)) {
    const result = parseCommand(raw)
    if (result.ok) commands.push(result.command)
    else rejections.push(result.rejection)
  }
  if (list.length > MAX_COMMANDS_PER_POLL) {
    rejections.push({ id: undefined, error: `only the first ${MAX_COMMANDS_PER_POLL} commands of a poll are run` })
  }
  return { commands, rejections }
}

function isIdOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH)
}

/** A carry read back from `$.state`, or undefined when it is not one. */
export function parseInboxCarry(raw: unknown): InboxCarry | undefined {
  if (!isRecord(raw)) return undefined
  const turnId = field(raw, 'turnId')
  const lastId = field(raw, 'lastId')
  if (!isIdOrNull(turnId) || !isIdOrNull(lastId)) return undefined
  return { turnId, lastId }
}

/**
 * Long-polls the host for commands and runs them. Each poll's timer starts
 * the next, so the loop outlives any one hook. It runs only with a token.
 *
 * While it runs it keeps the running turn and the last command id in
 * `$.state`, through `ports.carryInbox`, so the copy a hot reload starts can
 * still interrupt that turn and poll from that command.
 */
export class Inbox {
  private ports: Ports | undefined
  private config: Config | undefined
  private timer: Timer | undefined
  private running = false
  private lastId: string | undefined
  private backoffMs = 0
  private turnId: string | undefined
  /** Whether this load saw a turn start or end, which outranks what an earlier load left. */
  private turnSeen = false

  constructor(private readonly outbox: Outbox) {}

  get isRunning(): boolean {
    return this.running
  }

  /** The main loop's running turn, set by `turn.start` and cleared by its `turn.complete`. */
  get currentTurnId(): string | undefined {
    return this.turnId
  }

  set currentTurnId(turnId: string | undefined) {
    this.turnId = turnId
    this.turnSeen = true
    this.carry()
  }

  /** Starts polling. `carry` is what an earlier load of the module left. */
  start(ports: Ports, config: Config, carry?: InboxCarry): void {
    if (this.running || config.token === undefined) return
    this.ports = ports
    this.config = config
    this.running = true
    if (carry !== undefined) {
      if (!this.turnSeen) this.turnId = carry.turnId ?? undefined
      this.lastId ??= carry.lastId ?? undefined
    }
    this.carry()
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    this.timer?.cancel()
    this.timer = undefined
  }

  private carry(): void {
    if (this.running) this.ports?.carryInbox({ turnId: this.turnId ?? null, lastId: this.lastId ?? null })
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.ports === undefined) return
    this.timer = this.ports.after(delayMs, () => {
      this.timer = undefined
      void this.poll()
    })
  }

  private async poll(): Promise<void> {
    const ports = this.ports
    const config = this.config
    if (!this.running || ports === undefined || config === undefined) return

    const params = new URLSearchParams()
    if (this.outbox.sessionId !== undefined) params.set('session', this.outbox.sessionId)
    if (config.tag !== undefined) params.set('tag', config.tag)
    params.set('boot', this.outbox.bootId)
    if (this.lastId !== undefined) params.set('after', this.lastId)

    const startedAt = await ports.now()
    let status: number | undefined
    let body = ''
    try {
      const response = await ports.fetch(`${config.url}/v1/commands?${params.toString()}`, {
        headers: authHeaders(config),
      })
      status = response.status
      body = response.text
    } catch {
      status = undefined
    }
    if (!this.running) return

    if (status !== undefined && status >= 200 && status < 300 && status !== 204) {
      this.backoffMs = 0
      const { commands, rejections } = parseCommands(body)
      for (const rejection of rejections) {
        this.outbox.emit('command.result', { id: rejection.id ?? null, ok: false, error: rejection.error })
      }
      for (const command of commands) {
        this.lastId = command.id
        this.run(ports, command)
      }
      if (commands.length > 0) this.carry()
      const elapsed = (await ports.now()) - startedAt
      this.schedule(commands.length === 0 && elapsed < MIN_POLL_INTERVAL_MS ? MIN_POLL_INTERVAL_MS - elapsed : 0)
      return
    }

    if (status === 204) {
      this.backoffMs = 0
      const elapsed = (await ports.now()) - startedAt
      this.schedule(elapsed < MIN_POLL_INTERVAL_MS ? MIN_POLL_INTERVAL_MS - elapsed : 0)
      return
    }

    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      ports.log(`the host refused the command poll with HTTP ${status}`, 'debug')
      this.schedule(REFUSED_RETRY_MS)
      return
    }

    this.backoffMs = this.backoffMs === 0 ? MIN_POLL_INTERVAL_MS : Math.min(this.backoffMs * 2, POLL_BACKOFF_MAX_MS)
    this.schedule(this.backoffMs)
  }

  /**
   * Runs one command without holding the poll: a prompt resolves only when
   * its turn starts, which can be minutes away while a turn runs.
   */
  private run(ports: Ports, command: Command): void {
    const done = (error?: string) =>
      this.outbox.emit('command.result', error === undefined ? { id: command.id, ok: true } : { id: command.id, ok: false, error })
    const failed = (error: unknown) => done(error instanceof Error ? error.message : String(error))

    switch (command.type) {
      case 'prompt':
        ports
          .submitPrompt(command.asUser ? { text: command.text, asUser: true } : { text: command.text })
          .then(result => done(result.drop === undefined ? undefined : `a hook dropped the prompt: ${result.drop}`), failed)
        return
      case 'interrupt': {
        const turnId = this.currentTurnId
        if (turnId === undefined) {
          done('no turn is running')
          return
        }
        ports.abortTurn(turnId).then(() => done(), failed)
        return
      }
      case 'toast':
        ports.toast(command.text)
        done()
        return
    }
  }
}
