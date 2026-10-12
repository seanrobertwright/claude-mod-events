import type { HttpInit, HttpResponse, PromptSubmitArgs } from 'claude-code'
import type { Config } from '../hooks/config'
import type { Envelope } from '../hooks/events'
import type { Ports } from '../hooks/ports'

export const CONFIG: Config = {
  url: 'http://127.0.0.1:47800',
  token: 'secret',
  tag: 'pane-7',
  toolDetail: 'summary',
  hostPermissions: false,
}

export type Request = { readonly url: string; readonly init: HttpInit | undefined }

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

  const ports: Ports = {
    fetch: async (url, init) => {
      const request = { url, init }
      requests.push(request)
      return host(request)
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
    advance,
    settle,
    posted,
    setHost: (next: Answer) => {
      host = next
    },
    pendingTimers: () => timers.filter(timer => !timer.cancelled).length,
  }
}
