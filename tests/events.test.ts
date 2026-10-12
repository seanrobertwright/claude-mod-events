import { describe, expect, test } from 'claude-code/testing'
import {
  SUMMARY_ARRAY_LIMIT,
  SUMMARY_STRING_LIMIT,
  splitToolCall,
  toWire,
  toolFinishedData,
  turnCompletedData,
} from '../hooks/events'

describe('toWire', () => {
  test('cuts long strings in summary mode and says how much', () => {
    const long = 'x'.repeat(SUMMARY_STRING_LIMIT + 10)
    const cut = toWire(long, 'summary')
    expect(typeof cut === 'string' && cut.startsWith('x'.repeat(SUMMARY_STRING_LIMIT))).toBe(true)
    expect(typeof cut === 'string' && cut.endsWith('[truncated 10 chars]')).toBe(true)
  })

  test('keeps long strings whole in full mode', () => {
    const long = 'x'.repeat(SUMMARY_STRING_LIMIT + 10)
    expect(toWire(long, 'full')).toBe(long)
  })

  test('cuts long arrays in summary mode', () => {
    const list = Array.from({ length: SUMMARY_ARRAY_LIMIT + 5 }, (_, i) => i)
    const cut = toWire(list, 'summary')
    expect(Array.isArray(cut) && cut.length).toBe(SUMMARY_ARRAY_LIMIT + 1)
    expect(Array.isArray(cut) && cut[SUMMARY_ARRAY_LIMIT]).toBe('[truncated 5 items]')
  })

  test('turns what JSON cannot hold into something it can', () => {
    const value = { a: undefined, b: () => 1, c: Number.NaN, d: 10n, e: [1, 'two', null] }
    expect(toWire(value, 'full')).toEqual({ c: 'NaN', d: '10', e: [1, 'two', null] })
  })

  test('stops at the depth limit', () => {
    let deep: unknown = 'bottom'
    for (let i = 0; i < 20; i++) deep = { next: deep }
    expect(JSON.stringify(toWire(deep, 'full'))).toContain('[too deep]')
  })
})

describe('splitToolCall', () => {
  test('separates the call identity from the tool arguments', () => {
    const call = splitToolCall({ tool: 'Bash', tool_use_id: 'tu_1', agentId: 'ag_1', requestMeta: { x: 1 }, command: 'ls', timeout: 5 })
    expect(call).toEqual({ tool: 'Bash', toolUseId: 'tu_1', agentId: 'ag_1', input: { command: 'ls', timeout: 5 } })
  })
})

describe('toolFinishedData', () => {
  const call = { tool: 'Bash', toolUseId: 'tu_1', agentId: undefined }

  test('reports ok, error, denied and failed calls', () => {
    expect(toolFinishedData(call, { text: 'done' }, 12, 'summary')).toEqual({ tool: 'Bash', toolUseId: 'tu_1', status: 'ok', durationMs: 12, text: 'done' })
    expect(toolFinishedData(call, { isError: true, text: 'boom' }, 1, 'summary').status).toBe('error')
    expect(toolFinishedData(call, { deny: 'no' }, 1, 'summary')).toEqual({ tool: 'Bash', toolUseId: 'tu_1', status: 'denied', durationMs: 1, text: 'no' })
    expect(toolFinishedData(call, undefined, 1, 'summary').status).toBe('failed')
  })
})

describe('turnCompletedData', () => {
  test('leaves out fields the turn did not have', () => {
    const data = turnCompletedData({ turnId: 't1', reason: 'answer', answer: 'hi', durationMs: 5, isAborted: false }, 'summary')
    expect(data).toEqual({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 5, answer: 'hi' })
  })
})
