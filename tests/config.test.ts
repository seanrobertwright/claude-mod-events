import { describe, expect, test } from 'claude-code/testing'
import { type RawEnv, parseConfig, parseEnvCarry, parseUrl } from '../hooks/config'

const NO_ENV: RawEnv = {
  url: undefined,
  token: undefined,
  tag: undefined,
  tools: undefined,
  permissions: undefined,
  commands: undefined,
}

function env(fields: Partial<RawEnv>): RawEnv {
  return { ...NO_ENV, ...fields }
}

describe('parseUrl', () => {
  test('takes loopback http and strips trailing slashes', () => {
    expect(parseUrl('http://127.0.0.1:47800/')).toEqual({ ok: true, url: 'http://127.0.0.1:47800' })
    expect(parseUrl('http://localhost:9/hooks//')).toEqual({ ok: true, url: 'http://localhost:9/hooks' })
    expect(parseUrl('http://[::1]:5000')).toEqual({ ok: true, url: 'http://[::1]:5000' })
  })

  test('takes https to any host', () => {
    expect(parseUrl('https://events.example.com/claude')).toEqual({ ok: true, url: 'https://events.example.com/claude' })
  })

  test('refuses plain http off the machine', () => {
    expect(parseUrl('http://192.168.1.10:47800').ok).toBe(false)
    expect(parseUrl('http://example.com').ok).toBe(false)
  })

  test('refuses other schemes, credentials, queries and garbage', () => {
    expect(parseUrl('ftp://127.0.0.1').ok).toBe(false)
    expect(parseUrl('file:///tmp/x').ok).toBe(false)
    expect(parseUrl('http://user:pw@127.0.0.1:1').ok).toBe(false)
    expect(parseUrl('http://127.0.0.1:1/?a=b').ok).toBe(false)
    expect(parseUrl('http://127.0.0.1:1/#x').ok).toBe(false)
    expect(parseUrl('not a url').ok).toBe(false)
  })
})

describe('parseConfig', () => {
  test('is off with no URL anywhere, and with a blank one', () => {
    expect(parseConfig(NO_ENV, {})).toEqual({ kind: 'off' })
    expect(parseConfig(env({ url: '   ' }), { url: '' })).toEqual({ kind: 'off' })
  })

  test('reads the URL from options when the env has none', () => {
    const result = parseConfig(NO_ENV, { url: 'http://127.0.0.1:1' })
    expect(result.kind).toBe('on')
  })

  test('lets a set env var win over its option', () => {
    const result = parseConfig(env({ url: 'http://127.0.0.1:2', tools: 'full' }), { url: 'http://127.0.0.1:1', toolDetail: 'summary' })
    expect(result).toEqual({
      kind: 'on',
      config: {
        url: 'http://127.0.0.1:2',
        token: undefined,
        tag: undefined,
        toolDetail: 'full',
        hostPermissions: false,
        hostCommands: false,
      },
      warnings: [],
    })
  })

  test('defaults tool detail to summary', () => {
    const result = parseConfig(env({ url: 'http://127.0.0.1:1' }), {})
    expect(result.kind === 'on' && result.config.toolDetail).toBe('summary')
  })

  test('refuses a token with spaces or line breaks', () => {
    expect(parseConfig(env({ url: 'http://127.0.0.1:1', token: 'a b' }), {}).kind).toBe('invalid')
    expect(parseConfig(env({ url: 'http://127.0.0.1:1', token: 'a\nb' }), {}).kind).toBe('invalid')
  })

  test('refuses a tag with control characters or past its length', () => {
    expect(parseConfig(env({ url: 'http://127.0.0.1:1', tag: 'pane\u00071' }), {}).kind).toBe('invalid')
    expect(parseConfig(env({ url: 'http://127.0.0.1:1', tag: 'x'.repeat(257) }), {}).kind).toBe('invalid')
  })

  test('refuses an unknown tool detail, permissions or commands value', () => {
    expect(parseConfig(env({ url: 'http://127.0.0.1:1', tools: 'everything' }), {}).kind).toBe('invalid')
    expect(parseConfig(env({ url: 'http://127.0.0.1:1', permissions: 'yes' }), {}).kind).toBe('invalid')
    expect(parseConfig(env({ url: 'http://127.0.0.1:1', token: 't', commands: 'on' }), {})).toEqual({
      kind: 'invalid',
      reason: 'CLAUDE_EVENTS_COMMANDS must be host or off, not "on"',
    })
  })

  test('turns host permissions on only with a token', () => {
    const withToken = parseConfig(env({ url: 'http://127.0.0.1:1', token: 't', permissions: 'host' }), {})
    expect(withToken.kind === 'on' && withToken.config.hostPermissions).toBe(true)

    const without = parseConfig(env({ url: 'http://127.0.0.1:1', permissions: 'host' }), {})
    expect(without.kind).toBe('on')
    if (without.kind === 'on') {
      expect(without.config.hostPermissions).toBe(false)
      expect(without.warnings).toEqual(['host permissions are off: they need a token'])
    }
  })

  test('lets CLAUDE_EVENTS_PERMISSIONS=off override the option', () => {
    const result = parseConfig(env({ url: 'http://127.0.0.1:1', token: 't', permissions: 'off' }), { hostPermissions: true })
    expect(result.kind === 'on' && result.config.hostPermissions).toBe(false)
  })

  test('keeps host commands off with a token alone', () => {
    const result = parseConfig(env({ url: 'http://127.0.0.1:1', token: 't' }), {})
    expect(result.kind === 'on' && result.config.hostCommands).toBe(false)
  })

  test('turns host commands on from the variable or the option, only with a token', () => {
    const fromEnv = parseConfig(env({ url: 'http://127.0.0.1:1', token: 't', commands: 'host' }), {})
    expect(fromEnv.kind === 'on' && fromEnv.config.hostCommands).toBe(true)
    const fromOption = parseConfig(env({ url: 'http://127.0.0.1:1', token: 't' }), { hostCommands: true })
    expect(fromOption.kind === 'on' && fromOption.config.hostCommands).toBe(true)

    const without = parseConfig(env({ url: 'http://127.0.0.1:1', commands: 'host' }), {})
    expect(without.kind).toBe('on')
    if (without.kind === 'on') {
      expect(without.config.hostCommands).toBe(false)
      expect(without.warnings).toEqual(['host commands are off: they need a token'])
    }
  })

  test('lets CLAUDE_EVENTS_COMMANDS=off override the option', () => {
    const result = parseConfig(env({ url: 'http://127.0.0.1:1', token: 't', commands: 'off' }), { hostCommands: true })
    expect(result.kind === 'on' && result.config.hostCommands).toBe(false)
  })
})

describe('parseEnvCarry', () => {
  test('takes a carry written before CLAUDE_EVENTS_COMMANDS existed, with commands unset', () => {
    const older = { url: 'http://127.0.0.1:1', token: 't', tag: null, tools: null, permissions: 'host' }
    expect(parseEnvCarry(older)).toEqual(env({ url: 'http://127.0.0.1:1', token: 't', permissions: 'host' }))
  })

  test('refuses a carry with a value that is not a string', () => {
    expect(parseEnvCarry({ url: 'http://127.0.0.1:1', token: 7 })).toBeUndefined()
    expect(parseEnvCarry('http://127.0.0.1:1')).toBeUndefined()
  })
})
