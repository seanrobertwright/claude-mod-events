import { describe, expect, test } from 'claude-code/testing'
import { BACKOFF_MAX_MS, BACKOFF_START_MS, BATCH_SIZE, FLUSH_DELAY_MS, Outbox, QUEUE_CAP } from '../hooks/outbox'
import { CONFIG, fakePorts, reply } from './fakes'

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
      [1, 'turn.started', 's1'],
      [2, 'turn.completed', 's1'],
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
