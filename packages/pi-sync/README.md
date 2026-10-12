# `@bry-guy/pi-sync`

Reusable client and Pi package from bry-guy for the `pi-syncd` v1 conversation
synchronization protocol. It wraps and extends Pi from
`@earendil-works/pi-coding-agent`. The package includes the native Pi JSONL adapter,
`/sync` extension, and `synchronized-workspace` skill.

The extension expects `PI_SYNC_SERVER_URL` (or `PI_SYNC_URL`) and is intended
to be installed as a trusted Pi package.

## Using it

- `/sync attach` shares the current conversation.
- `/sync` opens a picker of shared conversations. It lists the current
  repository first, then sorts by most recent. Opening a conversation this
  device already has reuses its file.
- Starting pi in a repository with no conversation open offers the shared
  conversation for that repository that this device hasn't caught up with
  (updated in the last day). `/sync open <id>` opens one directly.
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

When another device's checkout differs from the conversation's code, pi-sync
says so. `/sync code` then fast-forwards (or creates) the branch and restores
the shared changes as uncommitted work. It refuses rather than overwrite local
uncommitted work or a branch that has diverged.

`PI_SYNC_DEVICE_LABEL` overrides the device name shown to other devices; the
default is the host name. Lease tokens are device-local state; they are never
written to synchronized session entries or Git metadata.

Hosts such as pi-ez-web run the extension in JSON mode, which disables the
background poll. They call `/sync auto-check` (or `/sync reconcile`) instead;
it returns `{ outcome: "unchanged" | "busy" | "conflict" | "refreshed" }`.

## Tests

`npm test` runs the unit tests. `npm run test:e2e` drives two real Pi
processes in RPC mode against a real `pi-syncd` and a fake model. It needs
`pi` and `go` on `PATH`.
