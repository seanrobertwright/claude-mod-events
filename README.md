# claude-mod-events

`event-bridge` is a Claude Code mod that lets a program hosting Claude Code
follow what each session does and steer it. The host can be your own app that
starts `claude`, or a terminal multiplexer that runs sessions in panes.

- **Events out.** Session start and end, turn start and completion (with token
  usage), notifications and permission dialogs, and every tool call with its
  result, sent as batched JSON to an HTTP listener the host runs.
- **Commands in, if you allow it.** With `CLAUDE_EVENTS_COMMANDS=host`, the
  host can submit a prompt, interrupt the running turn, or show a toast in an
  interactive session. A headless run (`claude -p`, the SDK) sends events but
  takes no commands, so no held poll delays its exit.
- **Permissions, if you allow it.** The host can allow or deny a tool call that
  would otherwise ask the person.

With nothing configured the mod is idle: it sends nothing and shows nothing.

It is built on Claude Code's mod API (function hooks), which is early access and
changes between releases. This version was built and tested against Claude Code
2.1.296.

## How a host uses it

1. Start an HTTP listener on `127.0.0.1` that speaks the protocol in
   [PROTOCOL.md](PROTOCOL.md).
2. Make a random token for the session.
3. Start `claude` with these variables in its environment:

   ```sh
   CLAUDE_EVENTS_URL=http://127.0.0.1:47800
   CLAUDE_EVENTS_TOKEN=<the random token>
   CLAUDE_EVENTS_TAG=<your id for this session or pane>
   CLAUDE_EVENTS_COMMANDS=host   # only if the host sends commands
   ```

4. Read events from `POST /v1/events`. If you turned commands on, answer the
   long-poll on `GET /v1/commands` when you have something to send. If you
   turned host permissions on, decide `POST /v1/permission`.

`CLAUDE_EVENTS_TOOLS=full` sends tool inputs and results whole, up to 1 MiB
per event, instead of cutting long strings to 2 KB. `CLAUDE_EVENTS_COMMANDS=host`
turns commands on and `CLAUDE_EVENTS_PERMISSIONS=host` turns host permissions
on; both need the token. The same settings exist as plugin options for a fixed
host. [PROTOCOL.md](PROTOCOL.md) has every event, command and status code.

## Try it

`examples/listener.mjs` is a small reference host in plain Node. It prints every
event and sends commands you type.

```sh
node examples/listener.mjs --port 47800 --token try-it-out-1234
```

In another terminal, with the mod installed (below) or loaded from this folder:

```sh
CLAUDE_EVENTS_URL=http://127.0.0.1:47800 CLAUDE_EVENTS_TOKEN=try-it-out-1234 \
  CLAUDE_EVENTS_COMMANDS=host claude --plugin-dir .
```

In PowerShell, set the variables first:

```powershell
$env:CLAUDE_EVENTS_URL = 'http://127.0.0.1:47800'
$env:CLAUDE_EVENTS_TOKEN = 'try-it-out-1234'
$env:CLAUDE_EVENTS_COMMANDS = 'host'
claude --plugin-dir .
```

Then type into the listener: `/prompt list the files here`, `/interrupt` while
a turn runs, `/toast hello`. Type `/help` in the listener for the full list.

## Install

From a local clone, so later edits only need `/reload-plugins`:

```sh
claude plugin marketplace add <path to this clone>
claude plugin install event-bridge@event-bridge
```

From GitHub, at the prompt of a Claude Code terminal session, with `<owner>` set
to the account that hosts this repository:

```text
/plugin install event-bridge --marketplace <owner>/claude-mod-events
```

Once installed at user scope it loads in every session, and stays idle wherever
no host sets `CLAUDE_EVENTS_URL`.

## Security

A host that can send `prompt` commands controls the session, including one
started with `--dangerously-skip-permissions`. The mod takes commands only
when `CLAUDE_EVENTS_COMMANDS=host` or its option turns them on, and asks
permissions only when `CLAUDE_EVENTS_PERMISSIONS=host` or its option does.
Each needs a token. A host must:

- bind its listener to loopback only,
- use a fresh random token and check it in constant time,
- refuse requests that carry an `Origin` header or a foreign `Host` header.

[PROTOCOL.md](PROTOCOL.md) explains why, and the reference listener does all
three.

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin manifest and its options |
| `.claude-plugin/marketplace.json` | Makes this repository installable as a marketplace |
| `hooks/register.ts` | The hooks, and every call the mod makes on Claude Code |
| `hooks/config.ts` | Reads and checks the variables and options |
| `hooks/outbox.ts` | Queues events and sends them in batches, with backoff |
| `hooks/inbox.ts` | Long-polls for commands and runs them |
| `hooks/permission.ts` | Asks the host to decide a tool call |
| `hooks/events.ts` | Event shapes and truncation |
| `types/index.d.ts` | What the mod keeps in `$.state` so a hot reload loses nothing |
| `tests/` | Tests for `claude plugin test` |
| `examples/listener.mjs` | The reference host |
| `PROTOCOL.md` | The wire protocol |
| `PLAN.md` | The design plan the build started from |

## Development

```sh
claude plugin validate .   # what the engine will load, and what it would refuse
claude plugin test .       # the tests, run inside the engine's test kit
```

To type-check, start one interactive session with `claude --plugin-dir .`.
Claude Code writes this build's type declarations into `.claude-plugin/types/`,
which git ignores. Then run `npx -p typescript@5.6.3 tsc -p .`.

Turn on the repository's pre-commit hook once per clone:

```sh
git config core.hooksPath .githooks
```

It runs `scripts/check.sh`: a scan for personal paths and broken characters, and
markdownlint. CI runs the same script.
