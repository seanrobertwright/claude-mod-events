# event-bridge wire protocol, version 1

This is the contract between the `event-bridge` Claude Code mod and a host
program: your own app that starts `claude`, or a terminal multiplexer that
runs Claude Code sessions in its panes.

The host runs an HTTP listener. The mod pushes events to it, pulls commands
from it, and, when allowed, asks it to decide tool permissions. Every
request comes from the Claude Code process, never from a browser.

## Discovery

The host sets these variables in the environment of the `claude` process it
starts (or of the pane's shell). Each one overrides the matching option in
the plugin's settings.

| Variable | Option | Meaning |
| --- | --- | --- |
| `CLAUDE_EVENTS_URL` | `url` | Base URL of the listener. Plain `http` only to `127.0.0.1`, `localhost` or `[::1]`; any other host needs `https`. No credentials, query or fragment. Unset or empty: the mod stays idle. |
| `CLAUDE_EVENTS_TOKEN` | `token` | Shared secret, sent as `Authorization: Bearer <token>` on every request. Visible ASCII, at most 4096 characters. Without it the mod still sends events but takes no commands and asks no permissions. |
| `CLAUDE_EVENTS_TAG` | (none) | The host's own label for this session, such as a pane id. Echoed on every event and on each command poll. At most 256 characters, no control characters. |
| `CLAUDE_EVENTS_TOOLS` | `toolDetail` | `summary` (the default) cuts strings in tool inputs, results, prompts and answers to 2048 characters and arrays to 100 items, and says how much was cut. `full` sends them whole, up to 1 MiB of JSON per event (see Events). |
| `CLAUDE_EVENTS_PERMISSIONS` | `hostPermissions` | `host` lets the host decide tool calls that would otherwise ask the person; `off` overrides an option that turned it on. Needs the token. |

A value the mod cannot use (a remote `http` URL, a token with spaces, an
unknown `CLAUDE_EVENTS_TOOLS`) leaves the mod idle, and it writes one line
saying why in the session's transcript.

The mod reads these as the session starts and then clears them from Claude
Code's environment. The processes Claude Code starts after that don't inherit
them: the commands Claude runs, and a `claude` started from inside the
session, which would otherwise join the host as a second session under the
same tag. The mod keeps the values in the session's `$.state`, where a hot
reload finds them and other plugins in the session can read them.

Clearing keeps the values out of what a process is handed, not out of reach:

- Processes Claude Code started before the mod cleared them keep their copy.
  In a live check on Claude Code 2.1.296, MCP servers and settings
  `SessionStart` command hooks run at startup still saw them.
- A process running as the same user can read the environment Claude Code
  started with, for example from `/proc/<pid>/environ` on Linux, which a
  later change does not alter. The shell that started Claude Code may hold
  the values too.

## Events: `POST {url}/v1/events`

Body: `{ "events": [Envelope, ...] }`, at most 200 per request and 3 MiB
(3,145,728 characters) of JSON. Answer with any `2xx`. Events from one
process arrive in order, one request at a time.

An event whose JSON is longer than 1 MiB (1,048,576 characters), as one can
be with `full` detail, is sent with its `data` cut the way `summary` cuts it.
One still longer than that is dropped and counted in an `outbox.dropped`
event. Claude Code refuses a request body over 4 MiB, so neither could be
sent whole.

```json
{
  "v": 1,
  "boot": "4f0c8a9e-...",
  "seq": 12,
  "ts": 1791900000000,
  "sessionId": "fea20429-7191-4e45-8c57-ca5e89387f8f",
  "tag": "pane-7",
  "type": "tool.finished",
  "data": { "tool": "Bash", "toolUseId": "toolu_01...", "status": "ok", "durationMs": 31, "text": "bridge-ok" }
}
```

- `boot` is new each time the mod loads (a process start or a hot reload).
- `seq` counts up from 1 within one `boot`, and `seq` 1 is that boot's
  `boot.started`, which says which version of the mod and of Claude Code
  the boot runs. No other event of a boot arrives ahead of its
  `boot.started`, and the mod never drops one to make room. A gap means
  events were dropped; an `outbox.dropped` event says how many.
- `ts` is epoch milliseconds when the event was raised.
- `sessionId` is the Claude Code session id at that moment. It changes after
  `/clear` and after a resume, so route by `tag` when you need one key for a pane.
- `tag` is `CLAUDE_EVENTS_TAG`, or absent.

How the mod treats your answer:

| Answer | What happens |
| --- | --- |
| `2xx` | The batch is done. |
| A `4xx` other than `408` and `429` | The batch is dropped. The mod writes one line to the transcript the first time. |
| Anything else: no answer, `408`, `429`, `5xx` | The batch is kept and retried, waiting 250 ms and doubling up to 5 s. The mod holds at most 1000 events; past that it drops the oldest, never a `boot.started`, and reports the count in an `outbox.dropped` event. |

### After a hot reload

Claude Code reloads the mod when its files change in a session that watches
them, when `/reload-plugins` finds them changed, when its options change, and
when it restarts a lost hooks worker. The mod starts again under a new `boot`,
and what the previous boot had not had acknowledged goes on:

- The new boot first sends the previous boot's unacknowledged events, each
  under the previous `boot` and its own `seq`, then its own events, starting
  with its `boot.started`.
- At most 200 of the previous boot's own events, and 3 MiB of their JSON,
  are carried. The rest are reported in an `outbox.dropped` event under that
  boot.
- A batch that was in flight at the reload is sent again, so an event can
  arrive twice. Drop an event whose `boot` and `seq` you already have.

### Event types

| `type` | When | `data` |
| --- | --- | --- |
| `boot.started` | The mod loads: a process start or a hot reload. It is the boot's `seq` 1 | `version` (the mod's own, as its `plugin.json` states it), and `claudeCode` when Claude Code says its version: `version` (what `claude --version` prints), and `base` (the release it is built from, such as `2.1.300` or `2.1.300-dev`) and `builtAt` (when it was built) when known, each as Claude Code states it |
| `session.started` | A session starts, resumes, or begins again after `/clear` or compaction | `source` (`startup`, `resume`, `clear`, `compact` or `fork`), `cwd`, `transcriptPath`, and `model`, `agentType` when known |
| `session.ended` | A session ends | `reason` (`prompt_input_exit`, `clear`, `resume`, `logout` or `other`), `resumeId` (what `claude --resume` takes) |
| `turn.started` | A model turn begins | `turnId`, `prompt` |
| `turn.completed` | A turn ends, in the main loop or a subagent | `turnId`, `reason` (`answer`, `aborted`, `refusal` or `error`; see Tool and turn details), `isAborted`, `durationMs`, `answer`, and `agentId`, `usage` when present |
| `attention.notification` | Claude Code raises a notification, such as waiting for input or for a permission | `notificationType`, `message`, and `title`, `agentId` when present |
| `permission.requested` | The permission dialog is about to show | `tool`, `input`, and `suggestions`, `agentId` when present |
| `tool.started` | A tool call starts | `tool`, `input` (the tool's arguments), and `toolUseId` when the call has one, `agentId` in a subagent |
| `tool.finished` | A tool call ends | `tool`, `status` (`ok`, `error`, `refused` or `failed`; see Tool and turn details), `durationMs`, and `text` (the result as the model read it, or the reason the call was refused), `toolUseId` and `agentId` when present |
| `command.result` | A command the host sent was run or refused | `id` (null when the command had none), `ok`, and `error` when not ok |
| `outbox.dropped` | Events were dropped while the host was unreachable | `count` |

On `session.ended` the mod sends what it holds at once, within Claude Code's
short exit bound (about 1.5 s for every plugin together). A host that is
slow to answer may miss that last batch.

### Tool and turn details

A `tool.finished` event's `status` says how the call ended:

| `status` | Meaning |
| --- | --- |
| `ok` | The tool answered. |
| `error` | The tool's answer is an error. A permission denial reports `error` too: a settings rule's deny, the host's, the person's No and a `--permission-mode dontAsk` deny all do, with the reason in `text`. The mod doesn't tell a denial apart from the tool's own error, because it can't see the person's No or a `dontAsk` deny. |
| `refused` | A plugin's hook refused the call, or withheld its result after the tool ran. The hook's reason is in `text`. |
| `failed` | The call ended with no answer at all: a hook or Claude Code threw. |

A tool's `durationMs` is the mod's own timing, from the call's start to its
answer, so it includes any time a permission dialog waited for the person. A
turn's `durationMs` is Claude Code's own, and it can come out shorter than a
tool call inside that turn.

A turn's `reason` is Claude Code's own word for how it ended. `aborted` comes
from Esc while Claude is working, and from the host's `interrupt`, even one
that closes an open dialog. A turn that ends because the person declined a
dialog, with No or Esc on a permission dialog or Esc on an `AskUserQuestion`,
reports `answer` with an empty `answer`, and No and Esc look the same. To
recognise one, check the turn's last tool event: a `tool.finished` with
`status` `error`, followed by a `turn.completed` with no answer text. An
empty `answer` alone isn't enough, because a turn that ends with only
thinking has one too.

## Commands: `GET {url}/v1/commands`

The mod long-polls this endpoint while the session runs, and only when a
token is set. Polling goes on across `/clear` and a resume,
under the new session id, and across a hot reload, under the new boot. It stops
when the session ends for any other reason: an exit, a finished `-p` run, a
signal or a logout. Query parameters:

- `session`: the current session id.
- `tag`: `CLAUDE_EVENTS_TAG`, when set.
- `boot`: the `boot` the mod's events carry. Just after a hot reload the
  previous boot's poll can still be open beside the new boot's, and a command
  given to it is lost. When polls from two boots are open, send commands to
  the poll of the boot that appeared later.
- `after`: the id of the last command the mod received, when there was one,
  kept across a hot reload.

Hold the request until a command is ready or about 25 seconds have passed.
Keep each answer under 4 MiB (4,194,304 characters): Claude Code cuts a
longer one, and the mod refuses what is left as not JSON, with one
`command.result` whose `id` is null.

| Answer | Meaning |
| --- | --- |
| `2xx` other than `204`, with `{ "commands": [...] }` | Commands to run. The mod runs the first 50 and refuses the rest with one `command.result`, then polls again at once. An empty list counts as `204`. |
| `204` | Nothing to do. If you answered in under a second, the mod waits out the rest of that second before polling again. |
| A `4xx` other than `408` and `429` (a wrong token, say) | The mod tries again in 30 s. |
| Anything else: no answer, `408`, `429`, `5xx` | The mod backs off from 1 s, doubling up to 5 s. |

Each command has an `id` of 1 to 256 characters, which the host chooses, and
a `type`:

| `type` | Fields | What the mod does |
| --- | --- | --- |
| `prompt` | `text` (1 to 100000 characters), `asUser` (optional boolean) | Submits the prompt. It runs as a turn of its own once the session is idle. With `asUser: true` the model reads it as the person's own words; otherwise it is framed as coming from the plugin. |
| `interrupt` | (none) | Aborts the main loop's running turn. Reported as an error when no turn is running. |
| `toast` | `text` (1 to 2000 characters) | Shows a short notice in the session. |

Every command is answered with a `command.result` event, and so is every
command the mod refuses (an unknown type, a missing field).

## Permissions: `POST {url}/v1/permission`

Sent only when host permissions are on and a token is set, and only for a
real tool call that Claude Code would otherwise put to the person.

```json
{
  "requestId": "toolu_01...",
  "sessionId": "fea20429-...",
  "tag": "pane-7",
  "tool": "Bash",
  "input": { "command": "rm -rf build" },
  "agentId": null,
  "reason": "the reason Claude Code gives for asking"
}
```

Hold the request until you decide, then answer `200` with one of:

- `{ "decision": "allow" }`: the call runs.
- `{ "decision": "deny", "reason": "..." }`: the call is refused; the model
  reads the reason.
- `{ "decision": "ask" }`: you defer, and the person's own dialog shows.

The mod waits at most 30 seconds. No answer in that time, an error status, or
a body it cannot read all count as `ask`. So does an ask too long for Claude
Code to send, over 4 MiB, which `full` detail can make: the host is not asked
at all. An `allow` never goes past an
organization's ceiling for that tool: where the organization caps a tool at
`ask`, the dialog still shows.

## Security requirements for a host

A host that can send `prompt` commands controls the session, including one
started with `--dangerously-skip-permissions`. So:

- Bind the listener to `127.0.0.1` (or `::1`) only.
- Generate a fresh random token for each session or pane, pass it in
  `CLAUDE_EVENTS_TOKEN`, and refuse any request whose `Authorization` header
  does not match it. Compare in constant time.
- Don't count on the token staying secret inside the session. The commands
  Claude runs no longer inherit it, but processes that started before the mod
  cleared it have it, other plugins can read it from `$.state`, and a process
  of the same user can dig it out of the environment Claude Code started with
  (see Discovery). A fresh token per session keeps that exposure to the
  session it belongs to.
- Refuse any request that carries an `Origin` header, and any whose `Host`
  header is not your own `127.0.0.1:<port>` or `localhost:<port>`. That stops
  web pages from reaching the listener, directly or through DNS rebinding.
- Treat event data as untrusted text. Tool inputs and results can hold
  anything the model or a file contained; escape it before showing it in HTML.

`examples/listener.mjs` does all of this and is a starting point.
