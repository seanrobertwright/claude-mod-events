import type { JsonValue } from 'claude-code'
import type { ToolDetail } from './config'

/**
 * The mod's own version, as `.claude-plugin/plugin.json` states it: held here
 * so the mod reads no file to learn it. `scripts/check.sh` fails when they differ.
 */
export const MOD_VERSION = '0.1.0'

export const EVENT_TYPES = [
  'boot.started',
  'session.started',
  'session.ended',
  'turn.started',
  'turn.completed',
  'attention.notification',
  'permission.requested',
  'tool.started',
  'tool.finished',
  'command.result',
  'outbox.dropped',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export type EventData = { readonly [key: string]: JsonValue }

/** One event on the wire. `seq` counts up within one `boot`. */
export type Envelope = {
  readonly v: 1
  readonly boot: string
  readonly seq: number
  readonly ts: number
  readonly sessionId: string | undefined
  readonly tag: string | undefined
  readonly type: EventType
  readonly data: EventData
}

/** Strings longer than this are cut in `summary` mode. */
export const SUMMARY_STRING_LIMIT = 2048
/** Arrays longer than this are cut in `summary` mode. */
export const SUMMARY_ARRAY_LIMIT = 100
/** Deeper values are replaced in both modes, so a cycle-like shape cannot blow up a batch. */
export const MAX_DEPTH = 12

/** Epoch milliseconds: the one place the mod reads the time of day. */
export function nowMs(): number {
  return Date.now()
}

/** A random id for this load of the module, so the host can tell a reload's `seq` restart from a gap. */
export function newBootId(): string {
  return crypto.randomUUID()
}

export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function field(record: { readonly [key: string]: unknown }, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value)
}

/**
 * An envelope read back from `$.state`, or undefined when it is not one. A
 * reload can bring in a different version of the mod, so nothing written by
 * the earlier load is taken on trust.
 */
export function parseEnvelope(raw: unknown): Envelope | undefined {
  if (!isRecord(raw)) return undefined
  const boot = field(raw, 'boot')
  const seq = field(raw, 'seq')
  const ts = field(raw, 'ts')
  const sessionId = field(raw, 'sessionId')
  const type = field(raw, 'type')
  const data = field(raw, 'data')
  if (field(raw, 'v') !== 1 || typeof boot !== 'string' || boot === '') return undefined
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return undefined
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined
  if (sessionId !== undefined && typeof sessionId !== 'string') return undefined
  if (!isEventType(type) || !isRecord(data)) return undefined
  // `data` came from `toWire` or a literal, and `$.state` holds JSON data alone.
  return { v: 1, boot, seq, ts, sessionId, tag: undefined, type, data: data as EventData }
}

/**
 * A JSON copy of `value`, with long strings and arrays cut in `summary` mode.
 * Anything JSON cannot hold (functions, undefined, bigint) is dropped or turned
 * into a string, so the result always serialises.
 */
export function toWire(value: unknown, detail: ToolDetail, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) return '[too deep]'
  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return detail === 'summary' && value.length > SUMMARY_STRING_LIMIT
        ? `${value.slice(0, SUMMARY_STRING_LIMIT)}… [truncated ${value.length - SUMMARY_STRING_LIMIT} chars]`
        : value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'object': {
      if (Array.isArray(value)) {
        const kept = detail === 'summary' ? value.slice(0, SUMMARY_ARRAY_LIMIT) : value
        const items = kept.map(item => toWire(item, detail, depth + 1))
        if (kept.length < value.length) items.push(`[truncated ${value.length - kept.length} items]`)
        return items
      }
      const out: { [key: string]: JsonValue } = {}
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
        out[key] = toWire(item, detail, depth + 1)
      }
      return out
    }
    default:
      return null
  }
}

/** Drops undefined fields so the data is plain JSON. */
function compact(fields: { readonly [key: string]: JsonValue | undefined }): EventData {
  const out: { [key: string]: JsonValue } = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** `claudeCode` is what `$.session.version()` answered, or undefined when it failed. */
export function bootStartedData(claudeCode: { readonly version: string; readonly base?: string; readonly builtAt?: string } | undefined): EventData {
  return compact({
    version: MOD_VERSION,
    claudeCode: claudeCode === undefined ? undefined : compact({ version: claudeCode.version, base: claudeCode.base, builtAt: claudeCode.builtAt }),
  })
}

export type SessionStartedFields = {
  readonly source: string
  readonly session_id: string
  readonly cwd: string
  readonly transcript_path: string
  readonly model?: string
  readonly agent_type?: string
}

export function sessionStartedData(e: SessionStartedFields): EventData {
  return compact({
    source: e.source,
    cwd: e.cwd,
    transcriptPath: e.transcript_path,
    model: e.model,
    agentType: e.agent_type,
  })
}

export function sessionEndedData(e: { readonly reason: string; readonly sessionId: string; readonly resume: { readonly id: string } }): EventData {
  return { reason: e.reason, resumeId: e.resume.id }
}

export function turnStartedData(e: { readonly turnId: string; readonly text: string }, detail: ToolDetail): EventData {
  return { turnId: e.turnId, prompt: toWire(e.text, detail) }
}

export type TurnCompletedFields = {
  readonly turnId: string
  readonly agentId?: string
  readonly reason: string
  readonly answer: string
  readonly durationMs: number
  readonly isAborted: boolean
  readonly usage?: unknown
}

export function turnCompletedData(e: TurnCompletedFields, detail: ToolDetail): EventData {
  return compact({
    turnId: e.turnId,
    agentId: e.agentId,
    reason: e.reason,
    isAborted: e.isAborted,
    durationMs: e.durationMs,
    answer: toWire(e.answer, detail),
    usage: e.usage === undefined ? undefined : toWire(e.usage, 'full'),
  })
}

export function notificationData(e: { readonly message: string; readonly title?: string; readonly notification_type: string; readonly agent_id?: string }): EventData {
  return compact({
    notificationType: e.notification_type,
    title: e.title,
    message: e.message,
    agentId: e.agent_id,
  })
}

export function permissionRequestedData(
  e: { readonly tool_name: string; readonly tool_input: unknown; readonly permission_suggestions?: unknown; readonly agent_id?: string },
  detail: ToolDetail,
): EventData {
  return compact({
    tool: e.tool_name,
    input: toWire(e.tool_input, detail),
    suggestions: e.permission_suggestions === undefined ? undefined : toWire(e.permission_suggestions, 'summary'),
    agentId: e.agent_id,
  })
}

/**
 * Splits a `tool.call` input into the call's identity and the tool's own
 * arguments, which the engine spreads beside `tool`.
 */
export function splitToolCall(e: { readonly [key: string]: unknown }): {
  tool: string
  toolUseId: string | undefined
  agentId: string | undefined
  input: { [key: string]: unknown }
} {
  const input: { [key: string]: unknown } = {}
  for (const [key, value] of Object.entries(e)) {
    if (key === 'tool' || key === 'tool_use_id' || key === 'agentId' || key === 'requestMeta' || key === 'consent') continue
    input[key] = value
  }
  return {
    tool: String(e.tool),
    toolUseId: typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined,
    agentId: typeof e.agentId === 'string' ? e.agentId : undefined,
    input,
  }
}

export function toolStartedData(
  call: { readonly tool: string; readonly toolUseId: string | undefined; readonly agentId: string | undefined; readonly input: unknown },
  detail: ToolDetail,
): EventData {
  return compact({
    tool: call.tool,
    toolUseId: call.toolUseId,
    agentId: call.agentId,
    input: toWire(call.input, detail),
  })
}

/** The parts of a `tool.call` result the host gets: never the tool's raw record. */
export type ToolOutcome = {
  readonly deny?: string
  readonly isError?: true
  readonly text?: string
}

export function toolFinishedData(
  call: { readonly tool: string; readonly toolUseId: string | undefined; readonly agentId: string | undefined },
  outcome: ToolOutcome | undefined,
  durationMs: number,
  detail: ToolDetail,
): EventData {
  let status: string
  if (outcome === undefined) status = 'failed'
  else if (outcome.deny !== undefined) status = 'denied'
  else if (outcome.isError === true) status = 'error'
  else status = 'ok'
  return compact({
    tool: call.tool,
    toolUseId: call.toolUseId,
    agentId: call.agentId,
    status,
    durationMs,
    text: outcome?.deny ?? (outcome?.text === undefined ? undefined : toWire(outcome.text, detail)),
  })
}
