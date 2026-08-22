# `@earendil-works/pi-sync`

Reusable client and Pi package for the `pi-syncd` v1 conversation synchronization
protocol. The package includes the native Pi JSONL adapter, `/sync` extension,
and `synchronized-workspace` skill.

The extension expects `PI_SYNC_SERVER_URL` (or `PI_SYNC_URL`) and is intended
to be installed as a trusted Pi package. Lease tokens are device-local state;
they are never written to synchronized session entries or Git metadata.
