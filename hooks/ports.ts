import type { HttpInit, HttpResponse, PromptSubmitArgs, PromptSubmitResult, Timer, UiLogSink } from 'claude-code'
import type { InboxCarry, OutboxCarry } from '../types'

/**
 * The engine calls the outbox, inbox and permission ask make, as plain
 * functions. `register.ts` builds them from a hook's `$`, so every call on
 * `$` stays in that one file where `claude plugin validate` reads it, and
 * the classes can be driven by a test with fakes.
 */
export type Ports = {
  readonly fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  readonly after: (ms: number, fn: () => void) => Timer
  readonly now: () => Promise<number>
  /** One line, prefixed with the plugin's name. */
  readonly log: (text: string, to: UiLogSink) => void
  readonly toast: (text: string) => void
  readonly submitPrompt: (args: PromptSubmitArgs) => Promise<PromptSubmitResult>
  readonly abortTurn: (turnId: string) => Promise<void>
  /** Keeps what the outbox has not had acknowledged in `$.state`, for the load a hot reload starts. */
  readonly carryOutbox: (carry: OutboxCarry) => void
  /** Keeps the running turn and the last command id in `$.state`, likewise. */
  readonly carryInbox: (carry: InboxCarry) => void
}

/**
 * `ports.fetch`, given up on after `timeoutMs`: resolves the response, or
 * undefined when the request fails or the time runs out first. `$.http.fetch`
 * takes no signal, so a request given up on still runs to its end, unread.
 */
export function fetchWithin(ports: Ports, timeoutMs: number, url: string, init?: HttpInit): Promise<HttpResponse | undefined> {
  return new Promise(resolve => {
    let settled = false
    const settle = (response: HttpResponse | undefined) => {
      if (settled) return
      settled = true
      timer.cancel()
      resolve(response)
    }
    const timer = ports.after(timeoutMs, () => settle(undefined))
    ports.fetch(url, init).then(settle, () => settle(undefined))
  })
}
