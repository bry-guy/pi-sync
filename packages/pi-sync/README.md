# `@bry-guy/pi-sync`

Reusable client and Pi package from bry-guy for the `pi-syncd` v1 conversation
synchronization protocol. It wraps and extends Pi from
`@earendil-works/pi-coding-agent`. The package includes the native Pi JSONL adapter,
`/sync` extension,
and `synchronized-workspace` skill.

The extension expects `PI_SYNC_SERVER_URL` (or `PI_SYNC_URL`) and is intended
to be installed as a trusted Pi package. Use `/sync attach` to enroll a local
session or explicitly recreate a server record that is reported missing. Once
attached, the extension polls for newer canonical snapshots while idle and
refreshes unchanged local materializations automatically. Use `/sync refresh`
for an explicit recovery refresh and `/sync detach` to remove only the local
binding. The `/sync` picker limits choices to the current normalized Git
repository and shows the branch plus the current lease holder. Unscoped
conversations remain
separate. Lease
tokens are device-local state; they are never written to synchronized session
entries or Git metadata.
