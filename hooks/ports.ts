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
