// The values event-bridge keeps in `$.state`. A contract is self-contained,
// so it spells out the envelope `hooks/events.ts` builds rather than import it.

/** A JSON value, as `$.state` holds it. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

/** One event as it goes on the wire, `tag` aside: that is stamped as a batch goes. */
export type CarriedEnvelope = {
  readonly v: 1
  readonly boot: string
  readonly seq: number
  readonly ts: number
  readonly sessionId?: string
  readonly type: string
  readonly data: { readonly [key: string]: Json }
}

/**
 * What one load of the outbox had not had acknowledged, kept in `$.state` so
 * the load a hot reload starts sends it first. Each event keeps its own boot
 * and seq.
 */
export type OutboxCarry = {
  /** The boot that wrote it. */
  readonly boot: string
  /** The events the host has not acknowledged, in the order they go, a batch in flight included. */
  readonly events: readonly CarriedEnvelope[]
  /** Events of `boot` that were dropped and not yet reported, those past the carry limit included. */
  readonly dropped: number
  /** The seq, within `boot`, that the notice for `dropped` goes out under; null when nothing was dropped. */
  readonly noticeSeq: number | null
}

/** What the inbox keeps in `$.state` for the load a hot reload starts. */
export type InboxCarry = {
  /** The main loop's running turn, the one an `interrupt` aborts. */
  readonly turnId: string | null
  /** The last command received, sent back as `after`. */
  readonly lastId: string | null
}

/**
 * The bridge's variables as the mod read them. It clears them from the
 * environment, so the commands Claude runs never inherit them, and keeps them
 * here for the load a hot reload starts. Null for one that was unset.
 */
export type EnvCarry = {
  readonly url: string | null
  readonly token: string | null
  readonly tag: string | null
  readonly tools: string | null
  readonly permissions: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'event-bridge': { outbox: OutboxCarry; inbox: InboxCarry; env: EnvCarry }
  }
}
