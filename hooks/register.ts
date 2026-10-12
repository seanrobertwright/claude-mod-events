import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { type Config, type ToolDetail, parseConfig } from './config'
import {
  nowMs,
  notificationData,
  permissionRequestedData,
  sessionEndedData,
  sessionStartedData,
  splitToolCall,
  toolFinishedData,
  toolStartedData,
  turnCompletedData,
  turnStartedData,
  type ToolOutcome,
} from './events'
import { Inbox } from './inbox'
import { Outbox } from './outbox'
import { askHost } from './permission'
import type { Ports } from './ports'

const PLUGIN_NAME = 'event-bridge'

/** Below this much of `session.end`'s bound left, the final flush is skipped so the exit stays fast. */
const END_FLUSH_MIN_MS = 200

/** What one load of the module holds. A hot reload starts a fresh one. */
type Bridge = {
  readonly options: PluginOptions
  readonly outbox: Outbox
  readonly inbox: Inbox
  config: Config | undefined
  starting: Promise<void> | undefined
}

/** The engine calls the other files make, bound to a hook's `$`. */
function portsFor($: EngineInterface): Ports {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    after: (ms, fn) => $.clock.after(ms, fn),
    now: () => $.clock.now(),
    log: (text, to) => $.ui.log(`${PLUGIN_NAME}: ${text}`, { to }),
    toast: text => $.ui.toast(text),
    submitPrompt: args => $.prompt.submit(args),
    abortTurn: turnId => $.turn.abort({ turnId }),
  }
}

/** Reads the config once per load, from whichever hook runs first. */
function start($: EngineInterface, bridge: Bridge): Promise<void> {
  bridge.starting ??= readConfig($, bridge)
  return bridge.starting
}

async function readConfig($: EngineInterface, bridge: Bridge): Promise<void> {
  const result = parseConfig(
    {
      url: await $.env.get('CLAUDE_EVENTS_URL'),
      token: await $.env.get('CLAUDE_EVENTS_TOKEN'),
      tag: await $.env.get('CLAUDE_EVENTS_TAG'),
      tools: await $.env.get('CLAUDE_EVENTS_TOOLS'),
      permissions: await $.env.get('CLAUDE_EVENTS_PERMISSIONS'),
    },
    bridge.options,
  )
  if (result.kind === 'off') {
    bridge.outbox.disable()
    return
  }
  const ports = portsFor($)
  if (result.kind === 'invalid') {
    bridge.outbox.disable()
    ports.log(`idle, ${result.reason}`, 'transcript')
    return
  }
  bridge.config = result.config
  for (const warning of result.warnings) ports.log(warning, 'transcript')
  bridge.outbox.sessionId ??= await $.session.id()
  bridge.outbox.start(ports, result.config)
  bridge.inbox.start(ports, result.config)
}

/**
 * The `.catch` of every hook here: they only observe, so when one fails the
 * engine's own answer stands. Where the hook had called `next`, `next(e)`
 * replays what that call settled to and nothing runs twice.
 */
function passThrough<E, R>(_$: unknown, e: E, next: (e: E) => R): R {
  return next(e)
}

export const register: Register = (on, options) => {
  const outbox = new Outbox()
  const bridge: Bridge = { options, outbox, inbox: new Inbox(outbox), config: undefined, starting: undefined }
  const { inbox } = bridge
  const detail = (): ToolDetail => bridge.config?.toolDetail ?? 'summary'

  on('session.start', async ($, e, next) => {
    await start($, bridge)
    return next(e)
  })

  on('classic.SessionStart', ($, e, next) => {
    outbox.sessionId = e.session_id
    outbox.emit('session.started', sessionStartedData(e))
    void start($, bridge)
    return next(e)
  }).catch(passThrough)

  on('session.end', async ($, e, next) => {
    outbox.emit('session.ended', sessionEndedData(e), e.sessionId)
    if (next.budget.remainingMs >= END_FLUSH_MIN_MS) await outbox.flushNow()
    // A /clear goes on in the same process under a new session id.
    if (e.reason !== 'clear') inbox.stop()
    inbox.currentTurnId = undefined
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    inbox.currentTurnId = e.turnId
    outbox.emit('turn.started', turnStartedData(e, detail()))
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && e.turnId === inbox.currentTurnId) inbox.currentTurnId = undefined
    outbox.emit('turn.completed', turnCompletedData(e, detail()))
    return next(e)
  })

  on('classic.Notification', ($, e, next) => {
    outbox.emit('attention.notification', notificationData(e))
    return next(e)
  }).catch(passThrough)

  on('classic.PermissionRequest', ($, e, next) => {
    outbox.emit('permission.requested', permissionRequestedData(e, detail()))
    return next(e)
  }).catch(passThrough)

  on('tool.call', async ($, e, next) => {
    const call = splitToolCall(e)
    outbox.emit('tool.started', toolStartedData(call, detail()))
    const startedAt = nowMs()
    let outcome: ToolOutcome | undefined
    try {
      const result = await next(e)
      outcome = result
      return result
    } finally {
      outbox.emit('tool.finished', toolFinishedData(call, outcome, nowMs() - startedAt, detail()))
    }
  }).catch(passThrough)

  // The host may decide a call the engine would put to the person. It only
  // runs when the person turned host permissions on and gave a token. A
  // failure here skips the hook, which leaves the engine's own verdict.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const config = bridge.config
    if (verdict.decision !== 'ask' || config === undefined || !config.hostPermissions) return verdict
    // A query (`$.tool.check`) has no call behind it to decide.
    if (e.tool_use_id === undefined) return verdict
    const answer = await askHost(portsFor($), config, {
      requestId: e.tool_use_id,
      sessionId: outbox.sessionId,
      tool: e.tool,
      input: e.input,
      agentId: e.agentId,
      reason: verdict.reason,
    })
    if (answer === undefined) return verdict
    // The organization's ceiling caps what the host may grant.
    if (answer.decision === 'allow' && e.ceiling !== undefined && e.ceiling !== 'allow') return verdict
    return {
      decision: answer.decision,
      reason: answer.reason ?? `the host ${answer.decision === 'allow' ? 'allowed' : 'denied'} this call`,
    }
  }).catch(passThrough)
}
