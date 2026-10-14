import type { HttpInit, HttpResponse, PromptSubmitArgs, SessionVersion } from 'claude-code'
import type { Config } from '../hooks/config'
import type { Envelope } from '../hooks/events'
import type { Ports } from '../hooks/ports'
import type { InboxCarry, OutboxCarry } from '../types'

export const CONFIG: Config = {
  url: 'http://127.0.0.1:47800',
  token: 'secret',
  tag: 'pane-7',
  toolDetail: 'summary',
  hostPermissions: false,
  hostCommands: true,
}

/** What the engine answers `$.session.version()` with in a test session: a development build's. */
export const CLAUDE_CODE_VERSION: SessionVersion = {
  version: '2.1.300-dev.20261001.t090000.sha1a2b3c4',
  base: '2.1.300-dev',
  builtAt: '2026-10-01T09:00:00Z',
}

export type Request = { readonly url: string; readonly init: HttpInit | undefined }

/**
 * Claude Code's own line, in characters, as measured on 2.1.296: a longer
 * request body is refused before it is sent, a longer response is cut to it,
 * and `$.state` refuses a value whose JSON is longer.
 */
export const ENGINE_TEXT_LIMIT = 4 * 1024 * 1024

export type Answer = (request: Request) => HttpResponse | Promise<HttpResponse>

export function reply(status: number, text = ''): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text }
}

type PendingTimer = { at: number; fn: () => void; cancelled: boolean }

/**
 * Ports over a clock that moves only when the test moves it, and a host the
 * test answers. Requests are recorded in order.
 */
export function fakePorts(answer: Answer = () => reply(204)) {
  let now = 0
  let host = answer
  const timers: PendingTimer[] = []
  const requests: Request[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const prompts: PromptSubmitArgs[] = []
  const aborts: string[] = []
  const outboxCarries: OutboxCarry[] = []
  const inboxCarries: InboxCarry[] = []
  let refusedCarries = 0

  const ports: Ports = {
    fetch: async (url, init) => {
      const length = init?.body?.length ?? 0
      if (length > ENGINE_TEXT_LIMIT) {
        throw new Error(`a request body of ${length} characters is over the ${ENGINE_TEXT_LIMIT}-character limit`)
      }
      const request = { url, init }
      requests.push(request)
      const response = await host(request)
      return { ...response, text: response.text.slice(0, ENGINE_TEXT_LIMIT) }
    },
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        },
      }
    },
    now: async () => now,
    log: text => {
      logs.push(text)
    },
    toast: text => {
      toasts.push(text)
    },
    submitPrompt: async args => {
      prompts.push(args)
      return { text: args.text }
    },
    abortTurn: async turnId => {
      aborts.push(turnId)
    },
    carryOutbox: carry => {
      const json = JSON.stringify(carry)
      if (json.length > ENGINE_TEXT_LIMIT) refusedCarries += 1
      else outboxCarries.push(JSON.parse(json) as OutboxCarry)
    },
    carryInbox: carry => {
      inboxCarries.push(carry)
    },
  }

  /** Lets every promise chain started so far run out. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  /** Moves the clock, firing each timer that comes due, earliest first. */
  async function advance(ms: number): Promise<void> {
    const target = now + ms
    await settle()
    for (let fired = 0; ; fired++) {
      if (fired > 10_000) throw new Error('fake clock: more than 10000 timers fired in one advance')
      const due = timers
        .filter(timer => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      due.cancelled = true
      now = Math.max(now, due.at)
      due.fn()
      await settle()
    }
    now = target
  }

  /** The events of every POST to /v1/events so far, in order. */
  function posted(): Envelope[] {
    return requests
      .filter(request => request.url.endsWith('/v1/events'))
      .flatMap(request => (JSON.parse(request.init?.body ?? '{}') as { events: Envelope[] }).events)
  }

  return {
    ports,
    requests,
    logs,
    toasts,
    prompts,
    aborts,
    /** Each carry written, as `$.state` would hold it. */
    outboxCarries,
    inboxCarries,
    /** Carries `$.state` refused for their length. */
    refusedCarries: () => refusedCarries,
    advance,
    settle,
    posted,
    setHost: (next: Answer) => {
      host = next
    },
    pendingTimers: () => timers.filter(timer => !timer.cancelled).length,
  }
}
