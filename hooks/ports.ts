import type { HttpInit, HttpResponse, PromptSubmitArgs, PromptSubmitResult, Timer, UiLogSink } from 'claude-code'

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
}
