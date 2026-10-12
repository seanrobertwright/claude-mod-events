# claude-mod-events: a mod that exposes Claude Code events to a host program

This is the plan the build started from. Where the build departed from it,
the text below says so; the README and `PROTOCOL.md` describe what shipped.

## What changed during the build

- **Plugin name.** `claude plugin validate` refuses plugin names that start
  with `claude-`, so the plugin is `event-bridge`. The repository and folder
  keep the name `claude-mod-events`.
- **Engine calls live in `register.ts`.** The validator only follows `$` into
  functions declared at the top of the hooks module. Every call on `$` is
  made there, in `portsFor`, and the outbox, inbox and permission ask take
  those calls as plain functions (`hooks/ports.ts`). Tests drive them with fakes.
- **Flush timing.** An emit schedules one `$.clock.after(100)` flush per
  burst instead of a standing `$.clock.every(150)` timer, so an idle session
  runs no timers. Only `session.end` flushes at once.
- **Drop notices.** A drop notice keeps one `seq` across retries, so a retry
  opens no gap of its own.
- **Tags.** The tag is stamped when a batch is sent, not when an event is
  queued: `SessionStart` can fire before the config has been read.
- **Tests** live in `tests/`, not beside the hooks.

## Context

The goal: let programs that host Claude Code see what it is doing and steer it.
Two kinds of host: our own app, which launches `claude` as a child process, and
terminal multiplexers such as Herdr, Orca or Warp.
The answer to "is it possible" is yes. Claude Code's mod API (function hooks,
build 2.1.296) has hooks for every event we need. It can also call the network
through `$.http.fetch`, submit prompts (`$.prompt.submit`) and abort turns
(`$.turn.abort`), so the host can talk back.

Decisions already made:

- Build a **mod**, not plain settings HTTP hooks.
- Host types: **our own app and multiplexers**.
- Events: **session lifecycle, turn lifecycle, needs-attention, tool activity**.
- Direction: **two-way**.

Caveat to keep in mind: the mod API is early access and changes between
releases. The authority is the declaration file the engine writes, not memory.

## Shape

The mod lives in `E:\Projects\claude-mod-events`; the plugin is called `event-bridge`.

- It **pushes** events as batched JSON `POST`s to a loopback HTTP listener the host runs.
- It **pulls** commands by long-polling the same listener.
- Discovery is through environment variables the host sets before it starts `claude`.
  Your own app sets them on the child process. A multiplexer sets them in each pane's environment.
- With nothing configured, the mod is inert: no traffic, no errors.

### Configuration (parse at the boundary, `hooks/config.ts`)

Environment variables are read with `$.env.get` using literal names.
Each one overrides the matching `userConfig` field in `plugin.json`.

| Env var | userConfig | Meaning |
| --- | --- | --- |
| `CLAUDE_EVENTS_URL` | `url` | Base URL. Plain `http:` only for `127.0.0.1`, `localhost` or `[::1]`; otherwise `https:` is required. Anything else is rejected with one `$.ui.log` line, and the mod stays inert. |
| `CLAUDE_EVENTS_TOKEN` | `token` (sensitive) | Shared secret, sent as `Authorization: Bearer`. **Inbound commands are off unless it is set.** |
| `CLAUDE_EVENTS_TAG` | — | Opaque host label (a pane id, for example), echoed on every event so the host can route them before it knows the session id. |
| `CLAUDE_EVENTS_TOOLS` | `toolDetail` | `summary` (default: strings cut to 2 KB, marked `truncated`) or `full`. |
| `CLAUDE_EVENTS_PERMISSIONS` | `hostPermissions` | `host` lets the host answer permission asks. Off by default; needs the token. |

Rules for the parser: reject empty strings and malformed URLs; numbers are
checked, never passed raw through `Number()`; on objects, use `Object.hasOwn`.

### Wire protocol (written up in `PROTOCOL.md`)

- `POST {url}/v1/events` with body `{ events: Envelope[] }`.
  - `Envelope = { v: 1, seq, ts, sessionId, tag?, type, data }`.
  - `seq` increases monotonically per process, so the host can spot gaps.
  - The host answers 2xx.
- `GET {url}/v1/commands?session=<id>&after=<lastId>` is a long-poll. The host
  holds it about 25 s and answers `200 { commands: [...] }` or `204`.
- `POST {url}/v1/permission` with body `{ requestId, sessionId, tool, input, reason }`.
  The host holds the request until it decides, then answers
  `{ decision: "allow" | "deny" | "ask", reason? }`.

Events and the hook each one comes from:

| Wire `type` | Source hook | Data |
| --- | --- | --- |
| `session.started` | `classic.SessionStart` | `source` (startup, resume, clear or compact), `session_id`, `cwd`, `model`, `transcript_path` |
| `session.ended` | `session.end` | `reason`, `sessionId`, `resume`. The outbox is flushed inside the 1.5 s end budget (`next.budget`, `next.signal`). |
| `turn.started` / `turn.completed` | `turn.start` / `turn.complete` | `turnId`, `agentId?`, `reason` (answer, aborted, refusal or error), `usage`, answer text truncated |
| `attention.notification` | `classic.Notification` | `message`, `title`, `notification_type` (permission prompt, idle prompt and so on) |
| `permission.requested` | `classic.PermissionRequest` | `tool_name`, `tool_input` (truncated), `permission_suggestions` |
| `tool.started` / `tool.finished` | `tool.call`: emit, `await next(e)`, emit | `tool`, `tool_use_id`, `agentId?`, `input` / result summary, `isError`, `durationMs` |
| `command.result` | the inbox | `{ id, ok, error? }` for each command the host sent |
| `outbox.dropped` | the outbox | `count`, emitted after the queue overflowed |

`session.start` (the mod event) is used only to bootstrap timers. It also fires
on hot reload and does not fire after `/clear`. The host-facing start event is
`classic.SessionStart`.

Commands the host can send:

- `prompt { text }` calls `$.prompt.submit`. The prompt is queued and runs once the session is idle.
- `interrupt` calls `$.turn.abort({ turnId })` with the running main-loop turn's id, which is held from `turn.start`.
- `toast { text }` calls `$.ui.toast`.

### Module layout (project folder `E:\Projects\claude-mod-events\`, which exists and is empty)

The mod is written straight into the project folder, with no session dev-mods copy.
While developing, run `claude --plugin-dir E:\Projects\claude-mod-events`;
an interactive session watches that folder and hot-reloads it on save.
The plugin's name is `event-bridge` (see What changed during the build).

- `PLAN.md`: this plan, written first.
- `.claude-plugin/plugin.json`: name, version 0.1.0, description, and `userConfig` (url, token, toolDetail, hostPermissions).
- `.claude-plugin/marketplace.json`: one entry with `"source": "./"`, so the folder can be installed from directly.
- `hooks/hooks.json`: `{ "modules": ["./register.ts"] }`.
- `hooks/register.ts`: the `on(...)` wiring, and every call on `$` (`portsFor`).
- `hooks/ports.ts`: the engine calls the other files use, as plain functions.
- `hooks/config.ts`: the boundary parser described above.
- `hooks/outbox.ts`:
  - Queue capped at 1,000 events; when full, drop the oldest and count the drops.
  - One `$.clock.after(100)` flush per burst of emits; `session.end` flushes at once.
  - Exponential backoff to 5 s while the host is unreachable.
  - `flushNow(signal)` for `session.end`.
- `hooks/inbox.ts`:
  - The long-poll loop is chained with `$.clock.after`, so it is timer-driven and outlives any dispatch.
  - It sends each command to the matching call and emits `command.result`.
  - It only starts when a token is set.
- `hooks/events.ts`: builds envelopes and truncates strings.
- `tests/*.test.ts`: tests for `claude plugin test` (below).
- `PROTOCOL.md`: the host-facing contract, including the security rules below.
- `examples/listener.mjs`: a reference host in plain Node.
  - Binds 127.0.0.1 only, checks the bearer token, and rejects any request that carries an `Origin` header (stops browser CSRF and DNS rebinding).
  - Prints events.
  - Stdin commands: `/prompt …`, `/say …` (as the person's own words), `/interrupt`, `/toast …`, and `/allow` / `/deny` for pending permission asks.

### Host permission decisions (opt-in, built last)

This is a `tool.check` hook:

1. Call `const v = await next(e)` to get the engine's own verdict.
2. If `v.decision !== 'ask'`, or `hostPermissions` is off, return `v` unchanged.
3. Otherwise `POST /v1/permission`, racing it against a `$.clock.after` timeout (default 30 s).
4. Return the host's decision. On timeout or error, return `v`, so the person's normal dialog shows.

If the hook fails, the engine skips it and its verdict stands. So a failure
never grants anything, and the hook needs no `.catch` that denies.

### Security notes

These go in `PROTOCOL.md` and the README:

- A host that can submit prompts controls a session. That includes `ag`
  sessions running with `--dangerously-skip-permissions`.
- That is why inbound commands require the token.
- The listener must bind loopback only, check the token, and reject requests that carry `Origin`.

## Steps

0. Write this plan to `E:\Projects\claude-mod-events\PLAN.md`.
1. Before writing each `$` call, grep this build's types file for the exact shapes:
   `PromptSubmitArgs`, `ToolCallResult`, the `userConfig` field schema, and the hook budget (`next.budget`).
   The file is `types/claude-code.d.ts` in the `plugin-authoring` skill; after the first `--plugin-dir` load,
   it is also at `<mod>/.claude-plugin/types/`.
   Type-check with the `tsconfig.json` from the types file's header, kept outside the mod folder,
   until those laid types exist.
2. Write `config.ts` and `events.ts` with their tests.
3. Write `outbox.ts` and the event hooks, with tests.
   **Early check:** `$.http.fetch` from a `$.clock.after` callback, using the `$` captured in `session.start`.
4. Write `inbox.ts` with tests.
   **Early check:** a fetch kept pending about 25 s works from a timer callback.
   If it does not, fall back to a 1 s short poll.
5. Write the `tool.check` permission hook with tests.
6. Write `examples/listener.mjs` and `PROTOCOL.md`. Run markdownlint on the markdown.
7. Install the mod from its own folder at user scope (commands below).
   A folder marketplace is read in place, so later edits only need `/reload-plugins`.
   Every session then loads the mod, and it stays inert wherever no host sets `CLAUDE_EVENTS_URL`.

   ```text
   claude plugin marketplace add E:\Projects\claude-mod-events
   claude plugin install event-bridge@event-bridge
   ```

   If the folder becomes a git repo, add the global pre-commit gates (CLAUDE.md section 4):
   markdownlint, plus the grep for U+FFFD, the username, the home path and the email address.
   `PROTOCOL.md` and `PLAN.md` use `%USERPROFILE%`-style paths, never a literal home path.

## Verification

- `claude plugin validate <mod>`, `tsc -p <mod>`, and `claude plugin test <mod>`.
  The tests answer `http.fetch` beneath the plugin and use `mock.clock` and `mock.env`. They cover:
  - URL and token parsing, including rejected inputs.
  - Batching, the 1,000-event cap and the drop count, and backoff.
  - The `session.end` flush within budget.
  - `tool.started` and `tool.finished` with truncation.
  - The `prompt` and `interrupt` commands reaching `$.prompt.submit` and `$.turn.abort`.
  - The inbox staying off without a token.
  - Permission: the host's decision is used, it falls back on timeout, and nothing happens when the option is off.
- End to end, terminal 1: `node examples/listener.mjs --port 47800 --token test`.
- End to end, terminal 2: set `CLAUDE_EVENTS_URL=http://127.0.0.1:47800` and `CLAUDE_EVENTS_TOKEN=test`,
  then run `claude --plugin-dir <mod>`. Check:
  - `session.started`, `turn.*`, `tool.*` and `attention.notification` arrive in order.
  - `/prompt hi` from the listener runs a turn.
  - `/interrupt` stops a long turn.
  - `/clear` produces `session.ended` (reason `clear`) and then `session.started` (source `clear`).
  - Exiting produces `session.ended`.
- Headless: `claude -p "list files" --plugin-dir <mod>` delivers the same lifecycle events.
- Host down: start `claude` with no listener running. Nothing slows down and no errors show.
  Start the listener later: events resume, with `outbox.dropped` if the queue overflowed.
