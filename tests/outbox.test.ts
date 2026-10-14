import { describe, expect, test } from 'claude-code/testing'
import { BACKOFF_MAX_MS, BACKOFF_START_MS, BATCH_SIZE, CARRY_LIMIT, FLUSH_DELAY_MS, MAX_EVENT_CHARS, Outbox, QUEUE_CAP, parseOutboxCarry } from '../hooks/outbox'
import { CONFIG, ENGINE_TEXT_LIMIT, fakePorts, reply } from './fakes'

// An outbox keeps seq 1 for its boot's `boot.started`. These tests start it
// without one, so the events they emit begin at seq 2.

describe('Outbox', () => {
  test('holds events until started, then sends them as one batch', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.sessionId = 's1'
    outbox.emit('turn.started', { turnId: 't1' })
    outbox.emit('turn.completed', { turnId: 't1' })
    await host.advance(1000)
    expect(host.requests.length).toBe(0)

    outbox.start(host.ports, CONFIG)
    await host.advance(0)
    expect(host.requests.length).toBe(1)
    const [request] = host.requests
    expect(request?.url).toBe('http://127.0.0.1:47800/v1/events')
    expect(request?.init?.method).toBe('POST')
    expect(request?.init?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer secret' })
    const events = host.posted()
    expect(events.map(event => [event.seq, event.type, event.sessionId])).toEqual([
      [2, 'turn.started', 's1'],
      [3, 'turn.completed', 's1'],
    ])
  })

  test('sends no authorization header without a token', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.start(host.ports, { ...CONFIG, token: undefined })
    outbox.emit('turn.started', {})
    await host.advance(FLUSH_DELAY_MS)
    expect(host.requests[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
  })

  test('folds a burst into one POST after the flush delay', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    for (let i = 0; i < 5; i++) outbox.emit('tool.started', { i })
    await host.advance(FLUSH_DELAY_MS - 1)
    expect(host.requests.length).toBe(0)
    await host.advance(1)
    expect(host.requests.length).toBe(1)
    expect(host.posted().length).toBe(5)
  })

  test('splits a big queue into batches', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    for (let i = 0; i < BATCH_SIZE * 2 + 50; i++) outbox.emit('tool.started', { i })
    outbox.start(host.ports, CONFIG)
    await host.advance(0)
    expect(host.requests.length).toBe(3)
    expect(host.posted().length).toBe(BATCH_SIZE * 2 + 50)
  })

  test('backs off while the host is down and keeps the events', async () => {
    let up = false
    const host = fakePorts(() => (up ? reply(200) : Promise.reject(new Error('refused'))))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    outbox.emit('turn.started', {})
    await host.advance(FLUSH_DELAY_MS)
    expect(host.requests.length).toBe(1)
    expect(outbox.queued).toBe(1)
    expect(host.logs).toEqual([`host unreachable (no response); holding up to ${QUEUE_CAP} events`])

    await host.advance(BACKOFF_START_MS - 1)
    expect(host.requests.length).toBe(1)
    await host.advance(1)
    expect(host.requests.length).toBe(2)
    await host.advance(BACKOFF_START_MS * 2)
    expect(host.requests.length).toBe(3)

    // The gap stops growing at the cap.
    await host.advance(60_000)
    const before = host.requests.length
    await host.advance(BACKOFF_MAX_MS)
    expect(host.requests.length).toBe(before + 1)

    up = true
    await host.advance(BACKOFF_MAX_MS)
    expect(outbox.queued).toBe(0)
    expect(host.posted().filter(event => event.type === 'turn.started').length).toBe(host.requests.length)
    expect(host.logs.at(-1)).toBe('host reachable again')
  })

  test('drops the oldest past the cap and reports the count once, under one seq', async () => {
    let up = false
    const host = fakePorts(() => (up ? reply(200) : reply(503)))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    for (let i = 0; i < QUEUE_CAP + 5; i++) outbox.emit('tool.started', { i })
    expect(outbox.queued).toBe(QUEUE_CAP)
    expect(outbox.droppedCount).toBe(5)

    await host.advance(FLUSH_DELAY_MS)
    await host.advance(BACKOFF_START_MS)
    const failedNotices = host.requests.map(
      request => (JSON.parse(request.init?.body ?? '{}') as { events: { type: string; seq: number }[] }).events[0],
    )
    expect(failedNotices.every(event => event?.type === 'outbox.dropped')).toBe(true)
    // The same seq on every retry, so the host sees no gap from the notice itself.
    expect(new Set(failedNotices.map(event => event?.seq)).size).toBe(1)

    up = true
    host.requests.length = 0
    await host.advance(BACKOFF_MAX_MS)
    const events = host.posted()
    const notices = events.filter(event => event.type === 'outbox.dropped')
    expect(notices.length).toBe(1)
    expect(notices[0]?.data).toEqual({ count: 5 })
    for (const request of host.requests) {
      const sent = JSON.parse(request.init?.body ?? '{}') as { events: unknown[] }
      expect(sent.events.length <= BATCH_SIZE).toBe(true)
    }
    expect(events.filter(event => event.type === 'tool.started').length).toBe(QUEUE_CAP)
    expect(outbox.droppedCount).toBe(0)
  })

  test('keeps its boot.started first past the cap, and reports the drop behind it', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG, undefined, { version: '1.2.3' })
    for (let i = 0; i < QUEUE_CAP; i++) outbox.emit('tool.started', { i })
    expect(outbox.droppedCount).toBe(1)

    await host.advance(BACKOFF_MAX_MS)
    // The oldest after boot.started went: seq 2. The notice takes the seq after the last one used.
    expect(host.posted().slice(0, 3).map(event => [event.seq, event.type])).toEqual([
      [1, 'boot.started'],
      [1 + QUEUE_CAP + 1, 'outbox.dropped'],
      [3, 'tool.started'],
    ])
  })

  test('drops a batch the host refuses with a 4xx and says so once', async () => {
    const host = fakePorts(() => reply(401))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    outbox.emit('turn.started', {})
    await host.advance(FLUSH_DELAY_MS)
    outbox.emit('turn.completed', {})
    await host.advance(FLUSH_DELAY_MS)
    expect(host.requests.length).toBe(2)
    expect(outbox.queued).toBe(0)
    expect(host.logs).toEqual(['the host refused events with HTTP 401; dropping them'])
  })

  test('retries a 429 rather than dropping it', async () => {
    const host = fakePorts(() => reply(429))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    outbox.emit('turn.started', {})
    await host.advance(FLUSH_DELAY_MS)
    expect(outbox.queued).toBe(1)
  })

  test('flushNow sends everything at once, waiting for a POST already out', async () => {
    let release: (() => void) | undefined
    const host = fakePorts(
      () =>
        new Promise(resolve => {
          release = () => resolve(reply(200))
        }),
    )
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    outbox.emit('turn.started', {})
    await host.advance(FLUSH_DELAY_MS)
    expect(host.requests.length).toBe(1)

    outbox.emit('session.ended', { reason: 'other' })
    const flushing = outbox.flushNow()
    await host.settle()
    release?.()
    await host.settle()
    release?.()
    await flushing
    expect(host.requests.length).toBe(2)
    expect(outbox.queued).toBe(0)
  })

  test('once disabled, emits nothing and holds nothing', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.emit('turn.started', {})
    outbox.disable()
    outbox.emit('turn.completed', {})
    outbox.start(host.ports, CONFIG)
    await host.advance(1000)
    expect(outbox.isOff).toBe(true)
    expect(outbox.queued).toBe(0)
    expect(host.requests.length).toBe(0)
  })
})

describe('Outbox across a hot reload', () => {
  test('carries everything the host has not acknowledged, a POST in flight included', async () => {
    let release: (() => void) | undefined
    const host = fakePorts(
      () =>
        new Promise(resolve => {
          release = () => resolve(reply(200))
        }),
    )
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    outbox.emit('turn.started', {})
    outbox.emit('turn.completed', {})
    await host.advance(FLUSH_DELAY_MS)
    expect(host.requests.length).toBe(1)
    outbox.emit('attention.notification', {})
    await host.settle()
    const carry = host.outboxCarries.at(-1)
    expect(carry?.boot).toBe(outbox.bootId)
    expect(carry?.events.map(event => [event.seq, event.type])).toEqual([
      [2, 'turn.started'],
      [3, 'turn.completed'],
      [4, 'attention.notification'],
    ])
    expect([carry?.dropped, carry?.noticeSeq]).toEqual([0, null])

    release?.()
    await host.advance(0)
    release?.()
    await host.advance(0)
    expect(host.outboxCarries.at(-1)?.events).toEqual([])
  })

  test('counts its own events past the carry limit as dropped, under the next seq', async () => {
    const host = fakePorts(() => reply(503))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    for (let i = 0; i < CARRY_LIMIT + 3; i++) outbox.emit('tool.started', { i })
    await host.settle()
    const carry = host.outboxCarries.at(-1)
    expect(carry?.events.length).toBe(CARRY_LIMIT)
    expect(carry?.events.at(-1)?.seq).toBe(1 + CARRY_LIMIT)
    expect([carry?.dropped, carry?.noticeSeq]).toEqual([3, 1 + CARRY_LIMIT + 3 + 1])
  })

  test('carries its boot.started even when the load before left a full carry', async () => {
    const host = fakePorts(() => reply(503))
    const outbox = new Outbox()
    const old = Array.from({ length: CARRY_LIMIT }, (_, i) => ({ v: 1, boot: 'old-boot', seq: i + 1, ts: 1, sessionId: 's1', tag: undefined, type: 'turn.started', data: {} }) as const)
    outbox.start(host.ports, CONFIG, { boot: 'old-boot', events: old, dropped: 0, noticeSeq: null }, { version: '1.2.3' })
    outbox.emit('turn.completed', {})
    await host.settle()
    const carry = host.outboxCarries.at(-1)
    expect(carry?.events.slice(CARRY_LIMIT).map(event => [event.seq, event.type])).toEqual([[1, 'boot.started']])
    expect([carry?.dropped, carry?.noticeSeq]).toEqual([1, 3])
  })

  test('sends an adopted carry first, under its own boot, and never trims it', async () => {
    let up = false
    const host = fakePorts(() => (up ? reply(200) : reply(503)))
    const outbox = new Outbox()
    outbox.sessionId = 's1'
    const old = (seq: number, type: 'turn.started' | 'turn.completed') =>
      ({ v: 1, boot: 'old-boot', seq, ts: 1, sessionId: 's1', tag: undefined, type, data: {} }) as const
    outbox.start(host.ports, CONFIG, {
      boot: 'old-boot',
      events: [old(5, 'turn.started'), old(6, 'turn.completed')],
      dropped: 2,
      noticeSeq: 7,
    })
    for (let i = 0; i < QUEUE_CAP; i++) outbox.emit('tool.started', { i })
    // The two carried events and their notice take three places, so three of this boot's own go.
    expect(outbox.queued).toBe(QUEUE_CAP)
    expect(outbox.droppedCount).toBe(3)

    up = true
    await host.advance(BACKOFF_MAX_MS)
    const events = host.posted()
    expect(events.slice(0, 4).map(event => [event.boot === 'old-boot' ? 'old' : 'own', event.seq, event.type])).toEqual([
      ['old', 7, 'outbox.dropped'],
      ['old', 5, 'turn.started'],
      ['old', 6, 'turn.completed'],
      ['own', 1 + QUEUE_CAP + 1, 'outbox.dropped'],
    ])
    expect([events[0]?.data, events[3]?.data]).toEqual([{ count: 2 }, { count: 3 }])
    expect(events.every(event => event.tag === CONFIG.tag)).toBe(true)
    expect(events.filter(event => event.type === 'tool.started').length).toBe(QUEUE_CAP - 3)
  })

  test('reads back the carry it writes, and refuses one it cannot trust', async () => {
    const host = fakePorts(() => reply(503))
    const outbox = new Outbox()
    outbox.start(host.ports, CONFIG)
    outbox.emit('turn.started', { turnId: 't1' })
    await host.settle()
    expect(parseOutboxCarry(host.outboxCarries.at(-1))?.events.map(event => event.type)).toEqual(['turn.started'])

    const event = { v: 1, boot: 'b', seq: 1, ts: 1, type: 'turn.started', data: {} }
    const carry = { boot: 'b', events: [event], dropped: 0, noticeSeq: null }
    expect(parseOutboxCarry(carry)).toEqual({ ...carry, events: [{ ...event, sessionId: undefined, tag: undefined }] })
    for (const bad of [
      null,
      [],
      { ...carry, boot: '' },
      { ...carry, dropped: -1 },
      { ...carry, dropped: 2, noticeSeq: null },
      { ...carry, noticeSeq: 4 },
      { ...carry, events: [{ ...event, v: 2 }] },
      { ...carry, events: [{ ...event, seq: 0 }] },
      { ...carry, events: [{ ...event, type: 'turn.exploded' }] },
      { ...carry, events: [{ ...event, data: [] }] },
      { ...carry, events: [{ ...event, sessionId: 7 }] },
      Object.create(carry) as object,
    ]) {
      expect(parseOutboxCarry(bad)).toBe(undefined)
    }
  })
})

describe('Outbox under the engine\'s length limits', () => {
  const FULL = { ...CONFIG, toolDetail: 'full' } as const
  /** A tool result as `full` detail sends it: long enough that BATCH_SIZE of them is over the request limit. */
  const bigText = (i: number) => `${i}:${'x'.repeat(30_000)}`

  test('keeps every POST under the request limit, so a burst of long events all arrive', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.start(host.ports, FULL)
    for (let i = 0; i < BATCH_SIZE; i++) outbox.emit('tool.finished', { text: bigText(i) })
    await host.advance(10_000)
    expect(host.posted().length).toBe(BATCH_SIZE)
    expect(host.requests.every(request => (request.init?.body?.length ?? 0) <= ENGINE_TEXT_LIMIT)).toBe(true)
  })

  test('cuts an event too long to send on its own, and sends what follows it', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.start(host.ports, FULL)
    outbox.emit('tool.finished', { text: 'y'.repeat(ENGINE_TEXT_LIMIT + 1) })
    outbox.emit('turn.completed', { turnId: 't1' })
    await host.advance(10_000)
    const events = host.posted()
    expect(events.map(event => event.type)).toEqual(['tool.finished', 'turn.completed'])
    expect(String(events[0]?.data.text)).toContain('[truncated')
  })

  test('drops and counts an event still too long once cut, and sends what follows it', async () => {
    const host = fakePorts(() => reply(200))
    const outbox = new Outbox()
    outbox.start(host.ports, FULL)
    // Summary detail cuts strings and arrays, not the keys of an object.
    const wide = Object.fromEntries(Array.from({ length: MAX_EVENT_CHARS / 10 }, (_, i) => [`k${i}`, 'value']))
    outbox.emit('tool.started', { input: wide })
    outbox.emit('turn.completed', { turnId: 't1' })
    await host.advance(10_000)
    expect(host.posted().map(event => [event.seq, event.type, event.data])).toEqual([
      [4, 'outbox.dropped', { count: 1 }],
      [3, 'turn.completed', { turnId: 't1' }],
    ])
  })

  test('keeps its carry under the $.state limit, counting what it leaves out', async () => {
    const host = fakePorts(() => reply(503))
    const outbox = new Outbox()
    outbox.start(host.ports, FULL)
    for (let i = 0; i < BATCH_SIZE; i++) outbox.emit('tool.finished', { text: bigText(i) })
    await host.settle()
    expect(host.refusedCarries()).toBe(0)
    const carry = host.outboxCarries.at(-1)
    expect(carry?.events.length).toBeLessThan(BATCH_SIZE)
    expect((carry?.events.length ?? 0) + (carry?.dropped ?? 0)).toBe(BATCH_SIZE)
  })
})
