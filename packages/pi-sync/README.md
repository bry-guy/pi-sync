# `@bry-guy/pi-sync`

Reusable client and Pi package from bry-guy for the `pi-syncd` v1 conversation
synchronization protocol. It wraps and extends Pi from
`@earendil-works/pi-coding-agent`. The package includes the native Pi JSONL adapter,
`/sync` extension,
and `synchronized-workspace` skill.

The extension expects `PI_SYNC_SERVER_URL` (or `PI_SYNC_URL`) and is intended
to be installed as a trusted Pi package. Use `/sync start` to enroll a local
session, or to explicitly recreate a server record that is reported missing.
Lease tokens are device-local state; they are never written to synchronized
session entries or Git metadata.
