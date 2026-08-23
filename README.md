# pi-sync

`pi-sync` is a bry-guy-owned self-hosted, single-user synchronization service
and Pi package for carrying Pi conversations between CLI installations and host
applications such as pi-ez-web. It wraps and extends Pi from
`@earendil-works/pi-coding-agent`.

The repository contains the v1 Go daemon (`pi-syncd`), reusable TypeScript
client and JSONL session adapter, Pi extension and skill, protocol fixtures,
and generic container/Kubernetes release artifacts.

```sh
mise run test
PI_SYNC_DATA_DIR=.pi-sync-data go run ./cmd/pi-syncd
```

Set `PI_SYNC_SERVER_URL` for the Pi package, then install it directly from Git:

```sh
pi install git:github.com/bry-guy/pi-sync
```

For a local checkout, run `pi install .` from the repository root instead. See
[`docs/implementation-plan.md`](docs/implementation-plan.md) for the
architecture and cross-repository integration contract.
