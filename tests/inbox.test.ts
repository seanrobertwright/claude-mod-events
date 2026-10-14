import { describe, expect, test } from 'claude-code/testing'
import { Inbox, MAX_COMMANDS_PER_POLL, MAX_ID_LENGTH, MIN_POLL_INTERVAL_MS, REFUSED_RETRY_MS, parseCommand, parseCommands, parseInboxCarry } from '../hooks/inbox'
import { Outbox } from '../hooks/outbox'
import { CONFIG, fakePorts, reply } from './fakes'

describe('parseCommand', () => {
  test('takes the three command types', () => {
    expect(parseCommand({ id: 'c1', type: 'prompt', text: 'hi' })).toEqual({ ok: true, command: { id: 'c1', type: 'prompt', text: 'hi', asUser: false } })
    expect(parseCommand({ id: 'c2', type: 'prompt', text: 'hi', asUser: true })).toEqual({ ok: true, command: { id: 'c2', type: 'prompt', text: 'hi', asUser: true } })
    expect(parseCommand({ id: 'c3', type: 'interrupt' })).toEqual({ ok: true, command: { id: 'c3', type: 'interrupt' } })
    expect(parseCommand({ id: 'c4', type: 'toast', text: 'yo' })).toEqual({ ok: true, command: { id: 'c4', type: 'toast', text: 'yo' } })
  })

  test('refuses a missing id, a bad type, and empty or wrong-typed fields', () => {
    expect(parseCommand({ type: 'interrupt' }).ok).toBe(false)
    expect(parseCommand({ id: '', type: 'interrupt' }).ok).toBe(false)
    expect(parseCommand({ id: 'c', type: 'rm -rf' })).toEqual({ ok: false, rejection: { id: 'c', error: 'unknown command type "rm -rf"' } })
    expect(parseCommand({ id: 'c', type: 'prompt', text: '  ' }).ok).toBe(false)
    expect(parseCommand({ id: 'c', type: 'prompt', text: 'hi', asUser: 'yes' }).ok).toBe(false)
    expect(parseCommand(['id', 'type']).ok).toBe(false)
    expect(parseCommand(null).ok).toBe(false)
  })

  test('ignores inherited properties', () => {
    const raw = Object.create({ id: 'c', type: 'interrupt' }) as object
    expect(parseCommand(raw).ok).toBe(false)
  })
})

describe('parseCommands', () => {
  test('refuses a body that is not the expected shape', () => {
    expect(parseCommands('nope').rejections.length).toBe(1)
    expect(parseCommands('{"cmds":[]}').rejections.length).toBe(1)
  })

  test('runs at most the per-poll limit', () => {
    const list = Array.from({ length: MAX_COMMANDS_PER_POLL + 3 }, (_, i) => ({ id: `c${i}`, type: 'interrupt' }))
    const result = parseCommands(JSON.stringify({ commands: list }))
    expect(result.commands.length).toBe(MAX_COMMANDS_PER_POLL)
    expect(result.rejections.length).toBe(1)
  })
})

function setup(answer: Parameters<typeof fakePorts>[0]) {
  const host = fakePorts(answer)
  const outbox = new Outbox()
  outbox.sessionId = 's1'
  outbox.start(host.ports, CONFIG)
  const inbox = new Inbox(outbox)
  return { host, outbox, inbox }
}

function commandsReply(commands: unknown[]) {
  return reply(200, JSON.stringify({ commands }))
}

/** A host that serves `commands` on the first poll, then nothing; events are taken. */
function serveOnce(commands: unknown[]) {
  let served = false
  return (request: { url: string }) => {
    if (!request.url.includes('/v1/commands')) return reply(200)
    if (served) return reply(204)
    served = true
    return commandsReply(commands)
  }
}

describe('Inbox', () => {
  test('does not start unless host commands are on', async () => {
    const { host, inbox } = setup(() => reply(204))
    inbox.start(host.ports, { ...CONFIG, hostCommands: false })
    await host.advance(5000)
    expect(inbox.isRunning).toBe(false)
    expect(host.requests.length).toBe(0)
  })

  test('polls with the session, tag, boot and token, and spaces out empty answers', async () => {
    const { host, outbox, inbox } = setup(() => reply(204))
    inbox.start(host.ports, CONFIG)
    await host.advance(0)
    expect(host.requests.length).toBe(1)
    expect(host.requests[0]?.url).toBe(`http://127.0.0.1:47800/v1/commands?session=s1&tag=pane-7&boot=${outbox.bootId}`)
    expect(host.requests[0]?.init?.headers).toEqual({ authorization: 'Bearer secret' })
    await host.advance(MIN_POLL_INTERVAL_MS - 1)
    expect(host.requests.length).toBe(1)
    await host.advance(1)
    expect(host.requests.length).toBe(2)
  })

  test('runs a prompt, reports it, and sends the last id back as after', async () => {
    const { host, inbox } = setup(serveOnce([{ id: 'c1', type: 'prompt', text: 'run the tests' }]))
    inbox.start(host.ports, CONFIG)
    await host.advance(0)
    expect(host.prompts).toEqual([{ text: 'run the tests' }])
    await host.advance(MIN_POLL_INTERVAL_MS)
    expect(host.requests.filter(request => request.url.includes('/v1/commands'))[1]?.url).toContain('after=c1')
    await host.advance(1000)
    expect(host.posted().filter(event => event.type === 'command.result').map(event => event.data)).toEqual([{ id: 'c1', ok: true }])
  })

  test('interrupts the running turn, and reports when there is none', async () => {
    const { host, inbox } = setup(
      serveOnce([
        { id: 'c1', type: 'interrupt' },
        { id: 'c2', type: 'toast', text: 'hello' },
      ]),
    )
    inbox.currentTurnId = 'turn-9'
    inbox.start(host.ports, CONFIG)
    await host.advance(0)
    inbox.stop()
    expect(host.aborts).toEqual(['turn-9'])
    expect(host.toasts).toEqual(['hello'])

    const second = setup(serveOnce([{ id: 'c3', type: 'interrupt' }]))
    second.inbox.start(second.host.ports, CONFIG)
    await second.host.advance(0)
    second.inbox.stop()
    await second.host.advance(1000)
    expect(second.host.aborts).toEqual([])
    expect(second.host.posted().map(event => event.data)).toEqual([{ id: 'c3', ok: false, error: 'no turn is running' }])
  })

  test('reports a command it refused', async () => {
    const { host, inbox } = setup(serveOnce([{ id: 'c1', type: 'shell' }]))
    inbox.start(host.ports, CONFIG)
    await host.advance(0)
    inbox.stop()
    await host.advance(1000)
    expect(host.posted().map(event => event.data)).toEqual([{ id: 'c1', ok: false, error: 'unknown command type "shell"' }])
  })

  test('waits long after a refusal and backs off when the host is down', async () => {
    const refused = setup(() => reply(403))
    refused.inbox.start(refused.host.ports, CONFIG)
    await refused.host.advance(0)
    await refused.host.advance(REFUSED_RETRY_MS - 1)
    expect(refused.host.requests.length).toBe(1)
    await refused.host.advance(1)
    expect(refused.host.requests.length).toBe(2)

    const down = setup(() => Promise.reject(new Error('refused')))
    down.inbox.start(down.host.ports, CONFIG)
    await down.host.advance(0)
    await down.host.advance(MIN_POLL_INTERVAL_MS)
    await down.host.advance(MIN_POLL_INTERVAL_MS * 2)
    expect(down.host.requests.length).toBe(3)
  })

  test('stop ends the loop', async () => {
    const { host, inbox } = setup(() => reply(204))
    inbox.start(host.ports, CONFIG)
    await host.advance(0)
    inbox.stop()
    await host.advance(10_000)
    expect(host.requests.length).toBe(1)
  })
})

describe('Inbox across a hot reload', () => {
  test('takes the running turn and the last command id from a carry', async () => {
    const { host, inbox } = setup(serveOnce([{ id: 'c10', type: 'interrupt' }]))
    inbox.start(host.ports, CONFIG, { turnId: 'turn-3', lastId: 'c9' })
    await host.advance(0)
    inbox.stop()
    expect(host.requests[0]?.url).toContain('after=c9')
    expect(host.aborts).toEqual(['turn-3'])
  })

  test('trusts a turn this load saw over the carry', async () => {
    const { host, inbox } = setup(serveOnce([{ id: 'c1', type: 'interrupt' }]))
    // The carried turn ended before the poll started: turn.complete cleared it.
    inbox.currentTurnId = undefined
    inbox.start(host.ports, CONFIG, { turnId: 'turn-3', lastId: null })
    await host.advance(0)
    inbox.stop()
    await host.advance(1000)
    expect(host.aborts).toEqual([])
    expect(host.posted().map(event => event.data)).toEqual([{ id: 'c1', ok: false, error: 'no turn is running' }])
  })

  test('keeps the running turn and the last command id in its carry', async () => {
    const { host, inbox } = setup(serveOnce([{ id: 'c1', type: 'toast', text: 'hi' }]))
    inbox.start(host.ports, CONFIG)
    inbox.currentTurnId = 'turn-1'
    expect(host.inboxCarries.at(-1)).toEqual({ turnId: 'turn-1', lastId: null })
    await host.advance(0)
    expect(host.inboxCarries.at(-1)).toEqual({ turnId: 'turn-1', lastId: 'c1' })
    inbox.currentTurnId = undefined
    expect(host.inboxCarries.at(-1)).toEqual({ turnId: null, lastId: 'c1' })
    inbox.stop()
  })

  test('refuses a carry it cannot trust', () => {
    expect(parseInboxCarry({ turnId: 't', lastId: null })).toEqual({ turnId: 't', lastId: null })
    const tooLong = 'x'.repeat(MAX_ID_LENGTH + 1)
    for (const bad of [null, {}, { turnId: '', lastId: null }, { turnId: 't', lastId: 4 }, { turnId: null, lastId: tooLong }]) {
      expect(parseInboxCarry(bad)).toBe(undefined)
    }
  })
})
