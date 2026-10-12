import type { HttpResponse, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Envelope } from '../hooks/events'

type Sent = { url: string; body: string | undefined; headers: Record<string, string> | undefined }

function ok(text = ''): HttpResponse {
  return { status: 200, ok: true, headers: {}, text }
}

/**
 * Answers everything beneath the plugin a session would: the env it reads,
 * the clock, the host's HTTP listener and the engine's own events.
 */
function world(on: On, env: Record<string, string>, commands: unknown[] = []) {
  mock.env(on, env)
  const clock = mock.clock(on)
  const sent: Sent[] = []
  const prompts: string[] = []
  const aborts: string[] = []
  const logs: string[] = []
  let served = false
  let decision = '{"decision":"allow"}'

  // Calls on `$` are answered `{ value }`, as core answers them.
  on('http.fetch', ($, e) => {
    sent.push({ url: e.url, body: e.init?.body, headers: e.init?.headers })
    if (e.url.includes('/v1/commands')) {
      if (served || commands.length === 0) return { value: { status: 204, ok: true, headers: {}, text: '' } }
      served = true
      return { value: ok(JSON.stringify({ commands })) }
    }
    if (e.url.endsWith('/v1/permission')) return { value: ok(decision) }
    return { value: ok() }
  })
  on('session.id', () => ({ value: 'from-engine' }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('classic.Notification', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'file-a\nfile-b', text: 'file-a\nfile-b' }))
  on('tool.check', () => ({ decision: 'ask', reason: 'needs approval' }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.abort', ($, e) => {
    aborts.push(e.turnId)
    return { value: undefined }
  })

  const events = (): Envelope[] =>
    sent
      .filter(request => request.url.endsWith('/v1/events'))
      .flatMap(request => (JSON.parse(request.body ?? '{}') as { events: Envelope[] }).events)

  return {
    clock,
    sent,
    prompts,
    aborts,
    logs,
    events,
    setDecision: (body: string) => {
      decision = body
    },
  }
}

const HOST = { CLAUDE_EVENTS_URL: 'http://127.0.0.1:47800', CLAUDE_EVENTS_TOKEN: 'secret', CLAUDE_EVENTS_TAG: 'pane-7' }

describe('event-bridge in a session', () => {
  test('stays idle with no host configured', async ($, on) => {
    const w = world(on, {})
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.classic.SessionStart({ source: 'startup', session_id: 's-1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await w.clock.advance(10_000)
    expect(w.sent.length).toBe(0)
    expect(w.logs.length).toBe(0)
  })

  test('says once why a bad URL leaves it idle', async ($, on) => {
    const w = world(on, { CLAUDE_EVENTS_URL: 'http://10.0.0.5:1' })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(10_000)
    expect(w.sent.length).toBe(0)
    expect(w.logs).toEqual(['event-bridge: idle, plain http is only allowed to 127.0.0.1, localhost or [::1], not 10.0.0.5'])
  })

  test('sends the lifecycle and tool events in order, tagged and authorised', async ($, on) => {
    const w = world(on, HOST)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.classic.SessionStart({ source: 'startup', session_id: 's-1', cwd: '/work', transcript_path: '/t.jsonl' })
    await $.turn.start({ text: 'list the files', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: 'two files', durationMs: 40, isAborted: false })
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
    await w.clock.advance(200)

    const events = w.events()
    expect(events.map(event => event.type)).toEqual([
      'session.started',
      'turn.started',
      'tool.started',
      'tool.finished',
      'turn.completed',
      'attention.notification',
    ])
    expect(events.every(event => event.sessionId === 's-1' && event.tag === 'pane-7')).toBe(true)
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events[0]?.data).toEqual({ source: 'startup', cwd: '/work', transcriptPath: '/t.jsonl' })
    expect(events[2]?.data).toEqual({ tool: 'Bash', toolUseId: expect.any(String), input: { command: 'ls' } })
    expect(events[3]?.data).toEqual(expect.objectContaining({ tool: 'Bash', status: 'ok', text: 'file-a\nfile-b' }))
    expect(events[5]?.data).toEqual({ notificationType: 'idle_prompt', message: 'Claude is waiting for your input' })

    const post = w.sent.find(request => request.url.endsWith('/v1/events'))
    expect(post?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer secret' })
  })

  test('tags events raised before the config was read', async ($, on) => {
    const w = world(on, HOST)
    // In a real session SessionStart can fire before session.start has read the env.
    await $.classic.SessionStart({ source: 'startup', session_id: 's-1' })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(200)
    expect(w.events().map(event => [event.type, event.tag])).toEqual([['session.started', 'pane-7']])
  })

  test('flushes on session end without waiting for the timer', async ($, on) => {
    const w = world(on, HOST)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.classic.SessionStart({ source: 'startup', session_id: 's-1' })
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { id: 's-1' } })
    expect(w.events().map(event => event.type)).toEqual(['session.started', 'session.ended'])
    expect(w.events()[1]?.data).toEqual({ reason: 'prompt_input_exit', resumeId: 's-1' })
  })

  test('runs a prompt and an interrupt the host sends', async ($, on) => {
    const w = world(on, HOST, [
      { id: 'c1', type: 'interrupt' },
      { id: 'c2', type: 'prompt', text: 'now run the tests' },
    ])
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.classic.SessionStart({ source: 'startup', session_id: 's-1' })
    await $.turn.start({ text: 'long job', turnId: 'turn-1' })
    await w.clock.advance(0)
    await w.clock.advance(200)
    expect(w.aborts).toEqual(['turn-1'])
    expect(w.prompts).toEqual(['now run the tests'])
    const results = w.events().filter(event => event.type === 'command.result')
    expect(results.map(event => event.data)).toEqual([
      { id: 'c1', ok: true },
      { id: 'c2', ok: true },
    ])
    const poll = w.sent.find(request => request.url.includes('/v1/commands'))
    expect(poll?.url).toBe('http://127.0.0.1:47800/v1/commands?session=s-1&tag=pane-7')
  })

  test('takes no commands without a token', async ($, on) => {
    const w = world(on, { CLAUDE_EVENTS_URL: 'http://127.0.0.1:47800' }, [{ id: 'c1', type: 'prompt', text: 'hi' }])
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(5000)
    expect(w.sent.some(request => request.url.includes('/v1/commands'))).toBe(false)
    expect(w.prompts).toEqual([])
  })

  test('lets the host decide an ask only when host permissions are on', async ($, on) => {
    const w = world(on, { ...HOST, CLAUDE_EVENTS_PERMISSIONS: 'host' })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    const allowed = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu_9' })
    expect(allowed.decision).toBe('allow')
    const ask = w.sent.find(request => request.url.endsWith('/v1/permission'))
    expect(JSON.parse(ask?.body ?? '{}')).toEqual(expect.objectContaining({ requestId: 'tu_9', tool: 'Bash', reason: 'needs approval' }))

    w.setDecision('{"decision":"ask"}')
    const deferred = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu_10' })
    expect(deferred.decision).toBe('ask')

    // A query has no call behind it, so the host is not asked.
    const before = w.sent.length
    const query = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(query.decision).toBe('ask')
    expect(w.sent.length).toBe(before)
  })

  test('keeps the host out of permissions by default', async ($, on) => {
    const w = world(on, HOST)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu_9' })
    expect(verdict.decision).toBe('ask')
    expect(w.sent.some(request => request.url.endsWith('/v1/permission'))).toBe(false)
  })

  test('never lets the host grant past an organization ceiling', async ($, on) => {
    world(on, { ...HOST, CLAUDE_EVENTS_PERMISSIONS: 'host' })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm' }, tool_use_id: 'tu_9', ceiling: 'ask' })
    expect(verdict.decision).toBe('ask')
  })
})
