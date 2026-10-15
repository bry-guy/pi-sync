# `@bry-guy/pi-sync`

Reusable client and Pi package from bry-guy for the `pi-syncd` v1 conversation
synchronization protocol. It wraps and extends Pi from
`@earendil-works/pi-coding-agent`. The package includes the native Pi JSONL adapter,
`/sync` extension, and `synchronized-workspace` skill.

The extension is intended to be installed as a trusted Pi package.

## Settings

Settings live in `~/.pi/agent/pi-sync.json` (or `$PI_CODING_AGENT_DIR/pi-sync.json`).
Each one can be overridden by an environment variable. Edits take effect after
`/reload` or a restart. Invalid values are ignored with a warning at startup.

```json
{
  "serverUrl": "https://pi-sync.example",
  "deviceLabel": "laptop",
  "code": "ask",
  "allSessions": false
}
```

| Setting | Environment | Values | Default |
|---|---|---|---|
| `serverUrl` | `PI_SYNC_SERVER_URL` (or `PI_SYNC_URL`) | http(s) URL of pi-syncd | none: sync is off |
| `deviceLabel` | `PI_SYNC_DEVICE_LABEL` | name other devices see | host name |
| `code` | `PI_SYNC_CODE` | `ask` once per repository, `auto` share without asking (announced once per remote; anyone who can read the remote can read the code), `off` never, whatever a repository says | `ask` |
| `allSessions` | `PI_SYNC_ALL_SESSIONS` | `on`: every conversation syncs after its first reply; `off`: only `/sync attach` | `off` |

With `ask` or `auto`, a repository's own `/sync code on|off` wins. `/sync detach` keeps a
conversation out of `allSessions`.

## Using it

- `/sync attach` shares the current conversation.
- `/sync` opens a picker of shared conversations. It lists the current
  repository first, then sorts by most recent. Opening a conversation this
  device already has reuses its file.
- Starting pi in a repository warns when a shared conversation for that
  repository, updated in the last day, is ahead of this device, and names the
  other clients it is on. Nothing opens by itself: use `/sync`, or
  `/sync open <id>` to open one directly.
- `/sync status`, `/sync refresh`, and `/sync detach` inspect, force-refresh,
  or stop syncing on this device. Detaching leaves the server copy unchanged.

Once a conversation is shared, synchronization runs in the background:

- Each prompt holds the conversation's lease only for that turn, so a second
  device is told which device is running it. Its prompt is put back in the
  editor rather than lost. If the other device is asleep or stuck mid-turn,
  you can confirm a take-over; whatever that device was still writing is kept
  there as a separate copy.
- An idle device follows remote turns automatically.
- If you type on a device that is behind, it catches up first and then sends
  your prompt.
- Idle local changes are carried onto the newer copy and uploaded. These
  include model or thinking changes, names, and extension state.
- Turns that were never uploaded are never merged. That happens, for example,
  when the server was unreachable while another device continued. Those turns
  are saved as a separate local session, and the shared copy wins.
- Each device keeps one session file per conversation.

Code follows the conversation too. Each turn records the branch and commit.
The first time a turn ends with uncommitted or unpushed work in a repository,
pi-sync asks whether to share it. If you agree, every turn's working tree
(tracked changes and untracked files, never `.gitignore`d ones) is captured
without touching your index or stash, and pushed to the hidden ref
`refs/pi-sync/<conversation id>` on the repository's remote. Anyone who can
read the remote can read that ref. Snapshots over 20 MB, or with a file over
5 MB, are skipped with a warning. The answer is stored per repository as
`git config pi-sync.shareWorkingTree`; change it with `/sync code on|off`.
If a push fails (offline, remote unreachable), pi-sync says so and retries
after the next turn and about once a minute while idle; only the newest
snapshot is pushed.

When another device's checkout differs from the conversation's code, pi-sync
says so. `/sync code` then fast-forwards (or creates) the branch and restores
the shared changes as uncommitted work. It refuses rather than overwrite local
uncommitted work or a branch that has diverged.

When the server is unreachable, a prompt asks whether to send anyway; that turn
uploads when the server is back, or is kept as a named "(unsynced copy)"
session (find it with `/resume`) if another device moved on meanwhile.

Catching up replaces the session in place, so Pi fires `session_start` with
reason `resume` and `previousSessionFile` equal to the current file. Extensions
that announce themselves on start can skip that case to stay quiet.

If `sync-bindings.json` loses a conversation (for example, an older pi-sync
process rewrote it), the running session writes it back. A new session
reconnects on its own when the server has a conversation with the same id,
unless it was stopped with `/sync detach`, which records that in the session.
To stop older processes rewriting the file, restart them after updating.

Each turn on a synchronized conversation tells the agent which machine it runs
on (device label, platform, working directory). When the previous turn ran on
another machine, it also warns that files, processes, and uncommitted work from
there may not exist here. A small `pi-sync-device` entry records each move; it
is not sent to the model.

Lease tokens are device-local state; they are never
written to synchronized session entries or Git metadata.

Hosts such as pi-ez-web run the extension in JSON mode, which disables the
background poll. They call `/sync auto-check` (or `/sync reconcile`) instead;
it returns `{ outcome: "unchanged" | "busy" | "conflict" | "refreshed" }`.

## Tests

`npm test` runs the unit tests. `npm run test:e2e` drives two real Pi
processes in RPC mode against a real `pi-syncd` and a fake model. It needs
`pi` and `go` on `PATH`.
