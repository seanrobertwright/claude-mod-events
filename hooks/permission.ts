import type { Config } from './config'
import { toWire } from './events'
import { authHeaders } from './outbox'
import { type Ports, fetchWithin } from './ports'

/** How long the host has to decide before the person's own dialog shows. */
export const PERMISSION_TIMEOUT_MS = 30_000
export const MAX_REASON_LENGTH = 1000

export type HostDecision = { readonly decision: 'allow' | 'deny'; readonly reason: string | undefined }

/**
 * The host's answer to `/v1/permission`, or undefined when it defers
 * (`ask`) or answers something this mod does not understand.
 */
export function parseDecision(body: string): HostDecision | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const decision = Object.hasOwn(parsed, 'decision') ? (parsed as { decision: unknown }).decision : undefined
  if (decision !== 'allow' && decision !== 'deny') return undefined
  const rawReason = Object.hasOwn(parsed, 'reason') ? (parsed as { reason: unknown }).reason : undefined
  const reason = typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason.slice(0, MAX_REASON_LENGTH) : undefined
  return { decision, reason }
}

export type PermissionAsk = {
  readonly requestId: string
  readonly sessionId: string | undefined
  readonly tool: string
  readonly input: unknown
  readonly agentId: string | undefined
  readonly reason: string | undefined
}

/**
 * Asks the host to decide a tool call. Resolves undefined when the host
 * defers, fails, refuses, or takes longer than `timeoutMs`.
 */
export function askHost(
  ports: Ports,
  config: Config,
  ask: PermissionAsk,
  timeoutMs: number = PERMISSION_TIMEOUT_MS,
): Promise<HostDecision | undefined> {
  return fetchWithin(ports, timeoutMs, `${config.url}/v1/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(config) },
    body: JSON.stringify({
      requestId: ask.requestId,
      sessionId: ask.sessionId ?? null,
      tag: config.tag ?? null,
      tool: ask.tool,
      input: toWire(ask.input, config.toolDetail),
      agentId: ask.agentId ?? null,
      reason: ask.reason ?? null,
    }),
  }).then(response => (response?.ok === true ? parseDecision(response.text) : undefined))
}
