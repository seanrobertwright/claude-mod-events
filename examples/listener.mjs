#!/usr/bin/env node
// A reference host for event-bridge: prints the events a Claude Code session
// sends, and sends commands back from what you type.
//
//   node examples/listener.mjs --port 47800 --token <secret>
//
// Then start Claude Code with:
//   CLAUDE_EVENTS_URL=http://127.0.0.1:47800 CLAUDE_EVENTS_TOKEN=<secret> claude
//
// It serves one session at a time: commands go to whichever session polls
// next. A real host routes them by the `session` and `tag` query parameters.

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createInterface } from 'node:readline'

const LONG_POLL_MS = 25_000
const PERMISSION_HOLD_MS = 25_000
const MAX_BODY_BYTES = 10 * 1024 * 1024

function fail(message) {
  console.error(`listener: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { port: 47800, token: undefined }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--port') {
      if (value === undefined || !/^\d{1,5}$/.test(value)) fail('--port needs a number')
      const port = Number.parseInt(value, 10)
      if (port < 1 || port > 65535) fail('--port must be between 1 and 65535')
      args.port = port
      i++
    } else if (flag === '--help' || flag === '-h') {
      console.log('usage: node examples/listener.mjs [--port 47800] [--token <secret>]')
      console.log('With no --token, a random one is made and printed.')
      process.exit(0)
    } else if (flag === '--token') {
      if (value === undefined || !/^[\x21-\x7e]{8,4096}$/.test(value)) fail('--token needs 8 or more visible ASCII characters')
      args.token = value
      i++
    } else {
      fail(`unknown argument ${flag}`)
    }
  }
  return args
}

const { port, token: givenToken } = parseArgs(process.argv.slice(2))
const token = givenToken ?? randomBytes(24).toString('hex')
const expectedAuth = Buffer.from(`Bearer ${token}`)
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

/** Commands waiting for the next poll, and the polls waiting for a command. */
const commands = []
const waitingPolls = new Set()
let nextCommandId = 1

/** Permission asks waiting for /allow or /deny, by requestId. */
const pendingAsks = new Map()

function send(res, status, body) {
  const headers = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
  if (body === undefined) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  res.writeHead(status, { ...headers, 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function isAuthorised(req) {
  const given = Buffer.from(req.headers.authorization ?? '')
  return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function short(value, limit = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** The boot and seq of each event printed, so a batch sent again after a hot reload prints once. */
const printed = new Set()
const PRINTED_MAX = 10_000

function printEvent(event) {
  const key = `${event.boot}:${event.seq}`
  if (printed.has(key)) return
  printed.add(key)
  if (printed.size > PRINTED_MAX) printed.delete(printed.values().next().value)
  const where = [event.sessionId?.slice(0, 8), event.tag].filter(Boolean).join(' ')
  console.log(`#${event.seq} ${event.type} [${where}] ${short(event.data)}`)
}

function deliver() {
  // The newest poll: just after a hot reload the previous boot's can still be open.
  const poll = [...waitingPolls].at(-1)
  if (commands.length === 0 || poll === undefined) return
  waitingPolls.delete(poll)
  clearTimeout(poll.timer)
  send(poll.res, 200, { commands: commands.splice(0, commands.length) })
}

function enqueue(command) {
  const id = `c${nextCommandId++}`
  commands.push({ id, ...command })
  console.log(`queued ${id}: ${command.type}`)
  deliver()
}

async function handle(req, res) {
  // A browser page cannot be a host: refusing any Origin stops cross-site
  // requests, and checking Host stops DNS rebinding to this port.
  if (req.headers.origin !== undefined) return send(res, 403, { error: 'browsers are not allowed' })
  if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'unexpected Host header' })
  if (!isAuthorised(req)) return send(res, 401, { error: 'missing or wrong bearer token' })

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  if (req.method === 'POST' && url.pathname === '/v1/events') {
    const body = JSON.parse(await readBody(req))
    if (!Array.isArray(body?.events)) return send(res, 400, { error: 'expected { events: [...] }' })
    for (const event of body.events) printEvent(event)
    return send(res, 204)
  }

  if (req.method === 'GET' && url.pathname === '/v1/commands') {
    if (commands.length > 0) return send(res, 200, { commands: commands.splice(0, commands.length) })
    const poll = { res, timer: undefined }
    poll.timer = setTimeout(() => {
      waitingPolls.delete(poll)
      send(res, 204)
    }, LONG_POLL_MS)
    waitingPolls.add(poll)
    res.on('close', () => {
      clearTimeout(poll.timer)
      waitingPolls.delete(poll)
    })
    return undefined
  }

  if (req.method === 'POST' && url.pathname === '/v1/permission') {
    const ask = JSON.parse(await readBody(req))
    if (typeof ask?.requestId !== 'string') return send(res, 400, { error: 'expected a requestId' })
    console.log(`permission asked ${ask.requestId}: ${ask.tool} ${short(ask.input)}`)
    console.log(`  /allow ${ask.requestId}   or   /deny ${ask.requestId} <reason>`)
    const timer = setTimeout(() => {
      pendingAsks.delete(ask.requestId)
      send(res, 200, { decision: 'ask' })
    }, PERMISSION_HOLD_MS)
    pendingAsks.set(ask.requestId, { res, timer })
    res.on('close', () => {
      clearTimeout(timer)
      pendingAsks.delete(ask.requestId)
    })
    return undefined
  }

  return send(res, 404, { error: 'not found' })
}

const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) send(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
  })
})

function decide(decision, rest) {
  const [requestId, ...reasonWords] = rest.split(' ').filter(Boolean)
  const id = requestId ?? [...pendingAsks.keys()][0]
  const ask = id === undefined ? undefined : pendingAsks.get(id)
  if (ask === undefined) {
    console.log('no permission ask is waiting')
    return
  }
  pendingAsks.delete(id)
  clearTimeout(ask.timer)
  const reason = reasonWords.join(' ')
  send(ask.res, 200, reason === '' ? { decision } : { decision, reason })
  console.log(`${decision} ${id}`)
}

const HELP = `commands:
  /prompt <text>     queue a prompt (framed as coming from the plugin)
  /say <text>        queue a prompt as the person's own words
  /interrupt         abort the running turn
  /toast <text>      show a toast in the session
  /allow [id]        allow a waiting permission ask
  /deny [id] [why]   deny a waiting permission ask`

createInterface({ input: process.stdin }).on('line', line => {
  const [verb = '', ...words] = line.trim().split(' ')
  const rest = words.join(' ').trim()
  switch (verb) {
    case '/prompt':
    case '/say':
      if (rest === '') return console.log(`${verb} needs text`)
      return enqueue({ type: 'prompt', text: rest, asUser: verb === '/say' })
    case '/interrupt':
      return enqueue({ type: 'interrupt' })
    case '/toast':
      if (rest === '') return console.log('/toast needs text')
      return enqueue({ type: 'toast', text: rest })
    case '/allow':
      return decide('allow', rest)
    case '/deny':
      return decide('deny', rest)
    case '':
      return undefined
    default:
      return console.log(HELP)
  }
})

server.on('error', error => {
  fail(error.code === 'EADDRINUSE' ? `port ${port} is already in use; pick another with --port` : error.message)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${port}`)
  if (givenToken === undefined) console.log(`token: ${token}`)
  console.log(HELP)
})
