import type { PluginOptions } from 'claude-code'
import type { EnvCarry } from '../types'
import { field, isRecord } from './events'

export type ToolDetail = 'summary' | 'full'

/** What the mod runs with once the host is configured. */
export type Config = {
  /** Base URL with no trailing slash: `${url}/v1/events` and so on. */
  readonly url: string
  /** Bearer token; commands from the host and host permissions need it. */
  readonly token: string | undefined
  /** The host's own label, echoed on every event. */
  readonly tag: string | undefined
  readonly toolDetail: ToolDetail
  readonly hostPermissions: boolean
  readonly hostCommands: boolean
}

/**
 * The raw environment, one field per variable; undefined means unset.
 * Kept apart from `$.env.get` so the parser is a pure function.
 */
export type RawEnv = {
  readonly url: string | undefined
  readonly token: string | undefined
  readonly tag: string | undefined
  readonly tools: string | undefined
  readonly permissions: string | undefined
  readonly commands: string | undefined
}

/**
 * `off`: no URL anywhere, the mod stays idle and says nothing.
 * `invalid`: something is set but wrong, the mod stays idle and says why once.
 * `on`: the config, plus warnings about options it had to drop.
 */
export type ConfigResult =
  | { readonly kind: 'off' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'on'; readonly config: Config; readonly warnings: readonly string[] }

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_TOKEN_LENGTH = 4096
const MAX_TAG_LENGTH = 256
// Visible ASCII only: a token goes into a header, so no spaces or line breaks.
const TOKEN_PATTERN = /^[\x21-\x7e]+$/
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/

const ENV_FIELDS = ['url', 'token', 'tag', 'tools', 'permissions', 'commands'] as const

/** Whether any of the bridge's variables was set. */
export function anySet(env: RawEnv): boolean {
  return ENV_FIELDS.some(name => env[name] !== undefined)
}

/** Each variable as it was read, or else as an earlier load kept it. */
export function withCarried(env: RawEnv, carried: RawEnv | undefined): RawEnv {
  return {
    url: env.url ?? carried?.url,
    token: env.token ?? carried?.token,
    tag: env.tag ?? carried?.tag,
    tools: env.tools ?? carried?.tools,
    permissions: env.permissions ?? carried?.permissions,
    commands: env.commands ?? carried?.commands,
  }
}

export function toEnvCarry(env: RawEnv): EnvCarry {
  return {
    url: env.url ?? null,
    token: env.token ?? null,
    tag: env.tag ?? null,
    tools: env.tools ?? null,
    permissions: env.permissions ?? null,
    commands: env.commands ?? null,
  }
}

/**
 * Variables read back from `$.state`, or undefined when they are not that
 * shape. `parseConfig` checks the values themselves, as it does the
 * environment's. A variable the carry lacks counts as unset: a reload into a
 * newer copy of the mod can find a carry written before that variable existed.
 */
export function parseEnvCarry(raw: unknown): RawEnv | undefined {
  if (!isRecord(raw)) return undefined
  const env: { [K in (typeof ENV_FIELDS)[number]]?: string } = {}
  for (const name of ENV_FIELDS) {
    const value = field(raw, name)
    if (value !== undefined && value !== null && typeof value !== 'string') return undefined
    if (typeof value === 'string') env[name] = value
  }
  return { url: env.url, token: env.token, tag: env.tag, tools: env.tools, permissions: env.permissions, commands: env.commands }
}

/** An env value trimmed, or undefined when unset or blank. */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionString(options: PluginOptions, key: string): string | undefined {
  if (!Object.hasOwn(options, key)) return undefined
  const value = options[key]
  return typeof value === 'string' ? present(value) : undefined
}

function optionBoolean(options: PluginOptions, key: string): boolean {
  if (!Object.hasOwn(options, key)) return false
  return options[key] === true
}

/** A power the host gets only when asked for: `host` or `off` in its variable, else its boolean option. */
function hostSwitch(
  variable: string,
  value: string | undefined,
  options: PluginOptions,
  option: string,
): { ok: true; on: boolean } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, on: optionBoolean(options, option) }
  if (value === 'host') return { ok: true, on: true }
  if (value === 'off') return { ok: true, on: false }
  return { ok: false, reason: `${variable} must be host or off, not "${value}"` }
}

/** The base URL, or the reason it is refused. */
export function parseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: `"${raw}" is not a URL` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'the URL must not carry a user name or password; use the token' }
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, reason: 'the URL must not carry a query or a fragment' }
  }
  if (parsed.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { ok: false, reason: `plain http is only allowed to 127.0.0.1, localhost or [::1], not ${parsed.hostname}` }
    }
  } else if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `the URL must be http or https, not ${parsed.protocol}` }
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${parsed.origin}${path}` }
}

/**
 * Builds the config from the environment and the plugin's options.
 * A set environment variable wins over its option.
 */
export function parseConfig(env: RawEnv, options: PluginOptions): ConfigResult {
  const rawUrl = present(env.url) ?? optionString(options, 'url')
  if (rawUrl === undefined) return { kind: 'off' }

  const url = parseUrl(rawUrl)
  if (!url.ok) return { kind: 'invalid', reason: url.reason }

  const token = present(env.token) ?? optionString(options, 'token')
  if (token !== undefined) {
    if (token.length > MAX_TOKEN_LENGTH) {
      return { kind: 'invalid', reason: `the token is longer than ${MAX_TOKEN_LENGTH} characters` }
    }
    if (!TOKEN_PATTERN.test(token)) {
      return { kind: 'invalid', reason: 'the token may hold only visible ASCII characters' }
    }
  }

  const tag = present(env.tag)
  if (tag !== undefined) {
    if (tag.length > MAX_TAG_LENGTH) {
      return { kind: 'invalid', reason: `CLAUDE_EVENTS_TAG is longer than ${MAX_TAG_LENGTH} characters` }
    }
    if (CONTROL_PATTERN.test(tag)) {
      return { kind: 'invalid', reason: 'CLAUDE_EVENTS_TAG holds control characters' }
    }
  }

  const tools = present(env.tools) ?? optionString(options, 'toolDetail') ?? 'summary'
  if (tools !== 'summary' && tools !== 'full') {
    return { kind: 'invalid', reason: `tool detail must be summary or full, not "${tools}"` }
  }

  const permissions = hostSwitch('CLAUDE_EVENTS_PERMISSIONS', present(env.permissions), options, 'hostPermissions')
  if (!permissions.ok) return { kind: 'invalid', reason: permissions.reason }
  const commands = hostSwitch('CLAUDE_EVENTS_COMMANDS', present(env.commands), options, 'hostCommands')
  if (!commands.ok) return { kind: 'invalid', reason: commands.reason }

  const warnings: string[] = []
  if (token === undefined) {
    if (permissions.on) warnings.push('host permissions are off: they need a token')
    if (commands.on) warnings.push('host commands are off: they need a token')
  }

  return {
    kind: 'on',
    config: {
      url: url.url,
      token,
      tag,
      toolDetail: tools,
      hostPermissions: permissions.on && token !== undefined,
      hostCommands: commands.on && token !== undefined,
    },
    warnings,
  }
}
