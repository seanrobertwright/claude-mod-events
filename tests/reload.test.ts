import type { HttpInit, HttpResponse, On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Envelope } from '../hooks/events'
import { CARRY_LIMIT } from '../hooks/outbox'
import { register } from '../hooks/register'

type Hook = (...args: unknown[]) => unknown
type StateRef = { readonly plugin: string; readonly key: string; readonly id?: string }

/** How the host's listener answers `/v1/events`: takes them, refuses the connection, or never answers. */
type EventsMode = 'up' | 'down' | 'hold'

const HOST = { CLAUDE_EVENTS_URL: 'http://127.0.0.1:47800', CLAUDE_EVENTS_TOKEN: 'secret', CLAUDE_EVENTS_TAG: 'pane-7' }

function reply(status: number, text = ''): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text }
}

/**
 * A session that hot-reloads the plugin, which the kit cannot do. Each `load`
 * runs `register` afresh, as the engine does, and the load before it is gone:
 * its timers dropped, its `$` calls never settling. `$.state` is held here
 * across loads, as the engine holds it, and so is the host's listener.
 */
function reloadingSession(variables: Record<string, string>, { isInteractive = true } = {}) {
  const env = new Map(Object.entries(variables))
  let now = 0
  let load = 0
  let hooks = new Map<string, Hook>()
  let $: unknown
  let eventsMode: EventsMode = 'up'
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  const delivered: Envelope[] = []
  const polls: URL[] = []
  const commands: unknown[] = []
  const state = new Map<string, unknown>()
  const aborts: string[] = []
  const never = new Promise<never>(() => undefined)

  function engineFor(id: number) {
    const gone = () => id !== load
    const answer = <T>(value: () => T): Promise<T> => (gone() ? never : Promise.resolve().then(value))
    const key = (ref: StateRef) => `${ref.plugin}/${ref.key}/${ref.id ?? ''}`
    return {
      env: {
        get: (name: string) => answer(() => env.get(name)),
        set: (name: string, value: string | undefined) =>
          answer(() => {
            if (value === undefined) env.delete(name)
            else env.set(name, value)
          }),
      },
      session: { id: () => answer(() => 's-1') },
      clock: {
        now: () => answer(() => now),
        after: (ms: number, fn: () => void) => {
          const timer = { at: now + ms, fn, cancelled: gone() }
          timers.push(timer)
          return { cancel: () => void (timer.cancelled = true) }
        },
      },
      http: {
        fetch: (url: string, init?: HttpInit): Promise<HttpResponse> => {
          if (gone()) return never
          if (url.includes('/v1/commands')) {
            polls.push(new URL(url))
            return Promise.resolve(commands.length === 0 ? reply(204) : reply(200, JSON.stringify({ commands: commands.splice(0) })))
          }
          if (eventsMode === 'hold') return never
          if (eventsMode === 'down') return Promise.reject(new Error('connection refused'))
          delivered.push(...(JSON.parse(init?.body ?? '{}') as { events: Envelope[] }).events)
          return Promise.resolve(reply(200))
        },
      },
      ui: { log: () => answer(() => undefined), toast: () => answer(() => undefined) },
      prompt: { submit: (args: { text: string }) => answer(() => ({ text: args.text })) },
      turn: { abort: (args: { turnId: string }) => answer(() => void aborts.push(args.turnId)) },
      state: {
        get: (ref: StateRef) => answer(() => ({ value: state.get(key(ref)), version: 0 })),
        set: (ref: StateRef, value: unknown) =>
          answer(() => {
            state.set(key(ref), JSON.parse(JSON.stringify(value)))
            return { isSet: true, version: 0 }
          }),
      },
    }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  async function fire(event: string, e: object, result: unknown = {}): Promise<void> {
    const hook = hooks.get(event)
    const next = Object.assign(async () => result, { budget: { remainingMs: 1500 } })
    if (hook !== undefined) await hook($, e, next)
    await settle()
  }

  /** A load of the module, then `session.start`, which the engine fires again on a reload. */
  async function loadAndStart(): Promise<void> {
    load += 1
    for (const timer of timers) timer.cancelled = true
    hooks = new Map()
    const on = ((event: string, a: unknown, b?: unknown) => {
      hooks.set(event, (typeof a === 'function' ? a : b) as Hook)
      return { catch: () => undefined }
    }) as unknown as On
    await register(on, {})
    $ = engineFor(load)
    await fire('session.start', { cwd: '/work', surface: isInteractive ? 'terminal' : null, isInteractive })
  }

  return {
    delivered,
    polls,
    aborts,
    fire,
    /** The environment now, as a command Claude runs would inherit it. */
    env: () => Object.fromEntries(env),
    /** Empties `$.state`, as a `/clear` or a resume may. */
    clearState: () => state.clear(),
    async start(): Promise<void> {
      await loadAndStart()
      await fire('classic.SessionStart', { source: 'startup', session_id: 's-1' })
    },
    /** A hot reload: no SessionStart follows it. */
    reload: loadAndStart,
    async advance(ms: number): Promise<void> {
      const target = now + ms
      await settle()
      for (;;) {
        const due = timers.filter(timer => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        due.cancelled = true
        now = Math.max(now, due.at)
        due.fn()
        await settle()
      }
      now = target
    },
    setEvents: (mode: EventsMode) => {
      eventsMode = mode
    },
    queue: (...more: unknown[]) => {
      commands.push(...more)
    },
  }
}

/** Each delivered event as [which boot, seq, type], boots named A, B, ... in the order they first arrive. */
function byBoot(events: readonly Envelope[]): [string, number, string][] {
  const names = new Map<string, string>()
  return events.map(event => {
    if (!names.has(event.boot)) names.set(event.boot, String.fromCharCode(65 + names.size))
    return [names.get(event.boot) ?? '?', event.seq, event.type]
  })
}

describe('event-bridge across a hot reload', () => {
  test('sends what the load before left unsent first, under its own boot and seq', async () => {
    const w = reloadingSession(HOST)
    await w.start()
    await w.advance(200)
    w.setEvents('down')
    await w.fire('turn.start', { text: 'go', turnId: 'turn-1' })
    await w.fire('tool.call', { tool: 'Bash', command: 'ls', tool_use_id: 'tu_1' }, { result: 'x', text: 'x' })
    await w.advance(2000)

    await w.reload()
    w.setEvents('up')
    await w.fire('turn.complete', { turnId: 'turn-1', reason: 'answer', answer: 'done', durationMs: 5, isAborted: false })
    await w.advance(10_000)

    expect(byBoot(w.delivered)).toEqual([
      ['A', 1, 'session.started'],
      ['A', 2, 'turn.started'],
      ['A', 3, 'tool.started'],
      ['A', 4, 'tool.finished'],
      ['B', 1, 'turn.completed'],
    ])
  })

  test('sends a batch that was in flight at the reload again', async () => {
    const w = reloadingSession(HOST)
    await w.start()
    await w.advance(200)
    w.setEvents('hold')
    await w.fire('turn.start', { text: 'go', turnId: 'turn-1' })
    await w.fire('turn.complete', { turnId: 'turn-1', reason: 'answer', answer: 'done', durationMs: 5, isAborted: false })
    await w.advance(200)

    await w.reload()
    w.setEvents('up')
    await w.advance(1000)

    expect(byBoot(w.delivered)).toEqual([
      ['A', 1, 'session.started'],
      ['A', 2, 'turn.started'],
      ['A', 3, 'turn.completed'],
    ])
  })

  test('reports what the load before could not carry, under that boot', async () => {
    const w = reloadingSession(HOST)
    await w.start()
    await w.advance(200)
    w.setEvents('down')
    const over = 5
    for (let i = 0; i < CARRY_LIMIT + over; i++) await w.fire('turn.start', { text: 'go', turnId: `turn-${i}` })
    await w.advance(1000)

    await w.reload()
    w.setEvents('up')
    await w.advance(10_000)

    const sent = byBoot(w.delivered)
    const lastUsed = 1 + CARRY_LIMIT + over
    // As within a boot, the notice goes ahead of the boot's events, under the seq after the last one it used.
    expect(sent.slice(0, 2)).toEqual([
      ['A', 1, 'session.started'],
      ['A', lastUsed + 1, 'outbox.dropped'],
    ])
    expect(w.delivered[1]?.data).toEqual({ count: over })
    expect(sent.slice(2)).toEqual(Array.from({ length: CARRY_LIMIT }, (_, i) => ['A', i + 2, 'turn.started']))
  })

  test('lets an interrupt abort a turn that started before the reload', async () => {
    const w = reloadingSession(HOST)
    await w.start()
    await w.advance(0)
    await w.fire('turn.start', { text: 'long job', turnId: 'turn-1' })

    await w.reload()
    w.queue({ id: 'c1', type: 'interrupt' })
    await w.advance(2000)

    expect(w.aborts).toEqual(['turn-1'])
    expect(w.delivered.filter(event => event.type === 'command.result').map(event => event.data)).toEqual([{ id: 'c1', ok: true }])
  })

  test('polls under its own boot, from the last command the load before received', async () => {
    const w = reloadingSession(HOST)
    w.queue({ id: 'c1', type: 'toast', text: 'hello' })
    await w.start()
    await w.advance(200)
    const bootA = w.delivered[0]?.boot
    const before = w.polls.length

    await w.reload()
    await w.advance(0)

    expect(w.polls[0]?.searchParams.get('boot')).toBe(bootA)
    const after = w.polls.slice(before)
    expect(after.length).toBe(1)
    expect(after[0]?.searchParams.get('boot')).not.toBe(bootA)
    expect(after[0]?.searchParams.get('after')).toBe('c1')
  })

  test('takes no commands after a reload of a headless run, and still sends its events', async () => {
    const w = reloadingSession(HOST, { isInteractive: false })
    await w.start()
    await w.advance(200)

    await w.reload()
    await w.fire('turn.start', { text: 'go', turnId: 'turn-1' })
    await w.advance(10_000)

    expect(w.polls).toEqual([])
    expect(byBoot(w.delivered)).toEqual([
      ['A', 1, 'session.started'],
      ['B', 1, 'turn.started'],
    ])
  })
})

describe('event-bridge with its variables cleared', () => {
  test('still reaches the host after a reload, though the environment no longer holds them', async () => {
    const w = reloadingSession(HOST)
    await w.start()
    await w.advance(200)
    expect(w.env()).toEqual({})

    await w.reload()
    await w.fire('turn.start', { text: 'go', turnId: 'turn-1' })
    await w.advance(1000)
    expect(byBoot(w.delivered)).toEqual([
      ['A', 1, 'session.started'],
      ['B', 1, 'turn.started'],
    ])
    // The inbox runs only with a token, so a poll from B means B has it.
    expect(w.polls.some(poll => poll.searchParams.get('boot') === w.delivered[1]?.boot)).toBe(true)
  })

  test('still reaches the host after a /clear that empties $.state, then a reload', async () => {
    const w = reloadingSession(HOST)
    await w.start()
    await w.advance(200)
    await w.fire('session.end', { reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
    w.clearState()
    await w.fire('classic.SessionStart', { source: 'clear', session_id: 's-2' })
    await w.advance(200)

    await w.reload()
    await w.fire('turn.start', { text: 'go', turnId: 'turn-1' })
    await w.advance(1000)
    expect(w.env()).toEqual({})
    expect(byBoot(w.delivered).at(-1)).toEqual(['B', 1, 'turn.started'])
    expect(w.polls.at(-1)?.searchParams.get('tag')).toBe('pane-7')
  })
})
