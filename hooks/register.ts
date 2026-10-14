import type { EngineInterface, PluginOptions, Register, SessionVersion } from 'claude-code'
import type { InboxCarry } from '../types'
import { type Config, type RawEnv, type ToolDetail, anySet, parseConfig, parseEnvCarry, toEnvCarry, withCarried } from './config'
import {
  bootStartedData,
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
import { Inbox, parseInboxCarry } from './inbox'
import { type Carry, Outbox, parseOutboxCarry } from './outbox'
import { askHost } from './permission'
import type { Ports } from './ports'

const PLUGIN_NAME = 'event-bridge'

/** Below this much of `session.end`'s bound left, the final flush is skipped so the exit stays fast. */
const END_FLUSH_MIN_MS = 200

/** What each load leaves for the next: `$.state` outlives a hot reload, the module's memory does not. */
const OUTBOX_CARRY = { plugin: 'event-bridge', key: 'outbox' } as const
const INBOX_CARRY = { plugin: 'event-bridge', key: 'inbox' } as const
const ENV_CARRY = { plugin: 'event-bridge', key: 'env' } as const

/** What one load of the module holds. A hot reload starts a fresh one. */
type Bridge = {
  readonly options: PluginOptions
  readonly outbox: Outbox
  readonly inbox: Inbox
  config: Config | undefined
  /** The variables this load runs with, once read; kept in `$.state` for the next load. */
  env: RawEnv | undefined
  /** What the inbox of the load before left, for this load's inbox to go on from. */
  inboxCarry: InboxCarry | undefined
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
    // A write that fails leaves the one before it standing: the next load may send
    // again what the host already has (it drops a repeated boot and seq) or miss the newest.
    carryOutbox: carry => void $.state.set(OUTBOX_CARRY, carry).catch(() => undefined),
    carryInbox: carry => void $.state.set(INBOX_CARRY, carry).catch(() => undefined),
  }
}

/** What the load before this one left, or nothing when this is the first load or it cannot be read. */
async function readCarries($: EngineInterface): Promise<{ outbox?: Carry; inbox?: InboxCarry; env?: RawEnv }> {
  try {
    const [outbox, inbox, env] = await Promise.all([$.state.get(OUTBOX_CARRY), $.state.get(INBOX_CARRY), $.state.get(ENV_CARRY)])
    return { outbox: parseOutboxCarry(outbox.value), inbox: parseInboxCarry(inbox.value), env: parseEnvCarry(env.value) }
  } catch {
    return {}
  }
}

/**
 * Reads the bridge's variables, then clears each one that was set. Every
 * process Claude Code starts afterwards inherits its environment: the
 * commands Claude runs, which a prompt injection can steer, and a `claude`
 * started from the session, which would otherwise join the host as this one.
 */
async function takeEnv($: EngineInterface): Promise<RawEnv> {
  const env: RawEnv = {
    url: await $.env.get('CLAUDE_EVENTS_URL'),
    token: await $.env.get('CLAUDE_EVENTS_TOKEN'),
    tag: await $.env.get('CLAUDE_EVENTS_TAG'),
    tools: await $.env.get('CLAUDE_EVENTS_TOOLS'),
    permissions: await $.env.get('CLAUDE_EVENTS_PERMISSIONS'),
    commands: await $.env.get('CLAUDE_EVENTS_COMMANDS'),
  }
  const clearing = await Promise.allSettled([
    env.url === undefined ? undefined : $.env.set('CLAUDE_EVENTS_URL', undefined),
    env.token === undefined ? undefined : $.env.set('CLAUDE_EVENTS_TOKEN', undefined),
    env.tag === undefined ? undefined : $.env.set('CLAUDE_EVENTS_TAG', undefined),
    env.tools === undefined ? undefined : $.env.set('CLAUDE_EVENTS_TOOLS', undefined),
    env.permissions === undefined ? undefined : $.env.set('CLAUDE_EVENTS_PERMISSIONS', undefined),
    env.commands === undefined ? undefined : $.env.set('CLAUDE_EVENTS_COMMANDS', undefined),
  ])
  if (clearing.some(outcome => outcome.status === 'rejected')) {
    portsFor($).log('could not clear the CLAUDE_EVENTS_ variables; commands Claude runs can read them', 'transcript')
  }
  return env
}

/**
 * Writes what the next load needs and `$.state` may have lost: the variables
 * and the inbox's carry. A `/clear` or a resume may empty `$.state` without
 * reloading the module, so the hooks write them again after each.
 */
function keepCarries($: EngineInterface, bridge: Bridge): void {
  if (bridge.env !== undefined) void $.state.set(ENV_CARRY, toEnvCarry(bridge.env)).catch(() => undefined)
  bridge.inbox.carry()
}

/** Claude Code's version, or undefined when the engine cannot say it: the boot opens either way. */
async function claudeCodeVersion($: EngineInterface): Promise<SessionVersion | undefined> {
  try {
    return await $.session.version()
  } catch {
    return undefined
  }
}

/** Reads the config once per load, from whichever hook runs first. */
function start($: EngineInterface, bridge: Bridge): Promise<void> {
  bridge.starting ??= readConfig($, bridge)
  return bridge.starting
}

async function readConfig($: EngineInterface, bridge: Bridge): Promise<void> {
  const fromEnv = await takeEnv($)
  const carried = await readCarries($)
  // After the first load the environment no longer holds them: a reload finds them kept.
  const env = withCarried(fromEnv, carried.env)
  if (anySet(env)) {
    bridge.env = env
    keepCarries($, bridge)
  }
  const result = parseConfig(env, bridge.options)
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
  bridge.inboxCarry = carried.inbox
  for (const warning of result.warnings) ports.log(warning, 'transcript')
  bridge.outbox.sessionId ??= await $.session.id()
  bridge.outbox.start(ports, result.config, carried.outbox, bootStartedData(await claudeCodeVersion($)))
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
  const bridge: Bridge = {
    options,
    outbox,
    inbox: new Inbox(outbox),
    config: undefined,
    env: undefined,
    inboxCarry: undefined,
    starting: undefined,
  }
  const { inbox } = bridge
  const detail = (): ToolDetail => bridge.config?.toolDetail ?? 'summary'

  // The engine fires this on every load of the module, a hot reload included.
  // Only a session with a person at the prompt polls for commands: a headless
  // run (`-p`, the SDK) does not exit until the poll it holds comes back.
  on('session.start', async ($, e, next) => {
    await start($, bridge)
    if (e.isInteractive && bridge.config !== undefined) inbox.start(portsFor($), bridge.config, bridge.inboxCarry)
    return next(e)
  })

  on('classic.SessionStart', ($, e, next) => {
    outbox.sessionId = e.session_id
    outbox.emit('session.started', sessionStartedData(e))
    void start($, bridge).then(() => keepCarries($, bridge))
    return next(e)
  }).catch(passThrough)

  on('session.end', async ($, e, next) => {
    outbox.emit('session.ended', sessionEndedData(e), e.sessionId)
    if (next.budget.remainingMs >= END_FLUSH_MIN_MS) await outbox.flushNow()
    // A /clear or a resume goes on in the same process under a new session id.
    if (e.reason !== 'clear' && e.reason !== 'resume') inbox.stop()
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
