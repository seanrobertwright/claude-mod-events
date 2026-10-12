import { describe, expect, test } from 'claude-code/testing'
import { PERMISSION_TIMEOUT_MS, askHost, parseDecision } from '../hooks/permission'
import { CONFIG, fakePorts, reply } from './fakes'

const ASK = { requestId: 'tu_1', sessionId: 's1', tool: 'Bash', input: { command: 'rm -rf build' }, agentId: undefined, reason: 'needs approval' }

describe('parseDecision', () => {
  test('takes allow and deny with an optional reason', () => {
    expect(parseDecision('{"decision":"allow"}')).toEqual({ decision: 'allow', reason: undefined })
    expect(parseDecision('{"decision":"deny","reason":"not on main"}')).toEqual({ decision: 'deny', reason: 'not on main' })
  })

  test('treats ask, garbage and other shapes as no decision', () => {
    expect(parseDecision('{"decision":"ask"}')).toBe(undefined)
    expect(parseDecision('{"decision":"yes"}')).toBe(undefined)
    expect(parseDecision('[]')).toBe(undefined)
    expect(parseDecision('nope')).toBe(undefined)
  })
})

describe('askHost', () => {
  test('posts the ask and returns the host decision', async () => {
    const host = fakePorts(() => reply(200, '{"decision":"deny","reason":"no"}'))
    const answer = askHost(host.ports, CONFIG, ASK)
    await host.settle()
    expect(await answer).toEqual({ decision: 'deny', reason: 'no' })
    const [request] = host.requests
    expect(request?.url).toBe('http://127.0.0.1:47800/v1/permission')
    expect(JSON.parse(request?.init?.body ?? '{}')).toEqual({
      requestId: 'tu_1',
      sessionId: 's1',
      tag: 'pane-7',
      tool: 'Bash',
      input: { command: 'rm -rf build' },
      agentId: null,
      reason: 'needs approval',
    })
    expect(host.pendingTimers()).toBe(0)
  })

  test('gives up after the timeout', async () => {
    const host = fakePorts(() => new Promise(() => {}))
    let answer: unknown = 'pending'
    void askHost(host.ports, CONFIG, ASK).then(value => {
      answer = value
    })
    await host.advance(PERMISSION_TIMEOUT_MS - 1)
    expect(answer).toBe('pending')
    await host.advance(1)
    expect(answer).toBe(undefined)
  })

  test('returns no decision on an error status or a failed request', async () => {
    const refused = fakePorts(() => reply(500, '{"decision":"allow"}'))
    const first = askHost(refused.ports, CONFIG, ASK)
    await refused.settle()
    expect(await first).toBe(undefined)

    const down = fakePorts(() => Promise.reject(new Error('down')))
    const second = askHost(down.ports, CONFIG, ASK)
    await down.settle()
    expect(await second).toBe(undefined)
  })
})
