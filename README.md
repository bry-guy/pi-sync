# pi-sync

`pi-sync` is a bry-guy-owned self-hosted, single-user synchronization service and Pi package for carrying Pi conversations between CLI installations and host applications such as pi-ez-web. It wraps and extends Pi from `@earendil-works/pi-coding-agent`.

The repository contains the v1 Go daemon (`pi-syncd`), reusable TypeScript client and JSONL session adapter, Pi extension and skill, protocol fixtures, and generic container/Kubernetes release artifacts.

## Run pi-syncd

`pi-syncd` is the sync server. It keeps conversations as files under `PI_SYNC_DATA_DIR`, gives one device the lease for a conversation's running turn, and relays remote-control requests from pi-web. The HTTP API is in [`protocol/v1/http.md`](protocol/v1/http.md).

From a checkout, it listens on `127.0.0.1:8080` by default:

```sh
mise run test
PI_SYNC_DATA_DIR=.pi-sync-data go run ./cmd/pi-syncd
```

Or run the image, `ghcr.io/bry-guy/pi-syncd`:

```sh
docker run --rm -p 127.0.0.1:8080:8080 -v pi-syncd-data:/data ghcr.io/bry-guy/pi-syncd:<tag>
```

Image tags: `sha-<12-char commit>` for `main`, `branch-<name>-<12-char commit>` for `feature/*` branches, and the version for `v*.*.*` tags.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_SYNC_LISTEN` | `127.0.0.1:8080` (image: `0.0.0.0:8080`) | Address to listen on |
| `PI_SYNC_DATA_DIR` | `.pi-sync-data` (image: `/data`) | Where conversations are stored |
| `PI_SYNC_TOKEN` | unset | When set, sync requests need `Authorization: Bearer <token>`. `/v1/health` stays open |
| `PI_SYNC_REMOTE_TOKEN` | unset | When set, enables the remote-control relay (`/v1/remote/*`). pi-web sends this token |
| `PI_SYNC_RETENTION_DAYS` | `14` | Deletes conversations unused for this many days. `0` keeps them forever |

`GET /v1/health` returns `buildId`, the commit the image was built from (`unknown` for a plain `go run`).

## Install the Pi package

The Pi package is published as `@bry-guy/pi-sync` (the unscoped `pi-sync` on npm is someone else's):

```sh
pi install npm:@bry-guy/pi-sync
# or from git:
pi install git:github.com/bry-guy/pi-sync
```

For a local checkout, run `pi install .` from the repository root instead.

Set `PI_SYNC_SERVER_URL` to your pi-syncd server, and `PI_SYNC_TOKEN` when the server requires one. Settings, `/sync` commands, and sync behavior are in [`packages/pi-sync/README.md`](packages/pi-sync/README.md).

## Deployment

Every push to `main` runs `.github/workflows/publish-image.yml`, unless it only changes `deploy/k8s/`. The job builds and pushes `ghcr.io/bry-guy/pi-syncd`. Then `scripts/deploy.sh production` pins the new digest in `deploy/k8s/deployment.yaml` with a `deploy(production): <sha7>` commit. It waits until `https://pi-sync.bry-guy.net/v1/health` reports the new source commit as `buildId`. Argo CD syncs the pin from `main`. The Argo CD Application, namespace, route, and image pull Secret live in the `infra` repository (see [`deploy/k8s/README.md`](deploy/k8s/README.md)).

Feature branches and `v*.*.*` tags only publish images; they do not deploy. A `pi-sync-v*` tag publishes the Pi package to npm (`.github/workflows/release.yml`).

Roll back by reverting the `deploy(production)` commit on `main`.

## License

MIT
