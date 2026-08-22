# pi-sync implementation plan

Status: implementation baseline (standalone service and Pi package implemented; pi-ez-web and infra integration remain cross-repository work)

## Context

Pi conversations are native append-only JSONL trees. Their entry IDs and
`parentId` links preserve conversation branches, but the files also contain
machine-local paths and are unsafe to edit from two Pi runtimes at once.
The desired experience is continuity between multiple CLI installations and
pi-ez-web for one person who intentionally uses only one writer at a time.

`pi-sync` will provide the shared authority for enrolled conversations. It is
not a remote agent runtime: models, tools, repositories, and worktrees remain
on the client currently holding a conversation lease. The service carries the
conversation plus a pointer to the last committed and pushed Git revision.

The complete system is split across three repositories:

- `pi-sync` owns the protocol, Go server, reusable TypeScript client, Pi
  extension and skill, generic container image, and generic Kubernetes
  manifests.
- `pi-ez-web` owns its adapter, enrollment UI, supervisor coordination, and the
  production-backed frontend preview mode.
- `infra` owns the site-specific persistent storage, tailnet-only route, Argo CD
  bootstrap, rollout tasks, and production/preview platform wiring.

## Fixed operating model

- The server represents one implicit user and has no application-level
  authentication. Deployments must place it behind a trusted private network;
  the homelab deployment will use Tailscale and tailnet ACLs.
- Every enrolled conversation has one canonical snapshot on `pi-syncd`.
- A client must hold the conversation's exclusive lease to update it.
- CLI clients hold a lease while the synchronized session is open. Host clients
  such as pi-ez-web may acquire a lease only around a run or other mutation.
- Clients upload complete settled snapshots. The server uses opaque ETags for
  compare-and-swap and never overwrites a stale base.
- A background heartbeat renews a lease independently of model streaming and
  tool execution. The initial constants are a 20-second heartbeat and a
  120-second expiry.
- If a lease expires, a client may reacquire and upload only when the canonical
  ETag is unchanged. Otherwise it retains its local file and reports a conflict.
- Workspace transfer means only a Git remote, upstream branch, and upstream
  commit. Uncommitted and unpushed state remains local and is not described to
  the server.

## Repository shape

Create the implementation under this repository with the following ownership:

```text
cmd/pi-syncd/                    Go entry point
internal/api/                    HTTP handlers and protocol errors
internal/lease/                  in-memory lease registry and fakeable clock
internal/session/                envelope validation and Pi entry graph checks
internal/store/                  atomic filesystem store
protocol/                        versioned JSON examples and contract docs
packages/pi-sync/                TypeScript client and Pi package
  src/client/                    reusable HTTP client
  src/session/                   JSONL normalize/materialize helpers
  extensions/sync.ts             Pi lifecycle and /sync commands
  skills/synchronized-workspace/SKILL.md
deploy/k8s/                      generic single-replica workload and service
.github/workflows/               checks and immutable image publication
mise.toml                        public build, test, and check tasks
```

Use one Go module at the repository root and one npm package beneath
`packages/pi-sync`. The npm package must export its HTTP/session client so
pi-ez-web can consume the same protocol implementation that the extension uses.

## Protocol v1

### Canonical session envelope

Define a versioned JSON envelope independent of native session paths:

```json
{
  "formatVersion": 1,
  "sessionId": "uuid",
  "piSessionVersion": 3,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "parentSessionId": null,
  "headEntryId": "entry-id",
  "title": "Display title",
  "entries": [],
  "workspace": {
    "gitRemote": "git@github.com:owner/repository.git",
    "branch": "feature/example",
    "commit": "full-commit-sha"
  }
}
```

`workspace` is absent for scratch conversations or repositories without an
upstream. Clients derive it from `@{upstream}`; local `HEAD`, dirty state, and
absolute paths do not enter the envelope.

The TypeScript session adapter must:

1. Parse native JSONL and verify the requested session ID.
2. Remove header `cwd` and native `parentSession` paths.
3. preserve every native entry and the current `headEntryId`.
4. Resolve a portable `parentSessionId` when known.
5. Materialize a native header using the receiving client's current `cwd`.
6. Restore `headEntryId` through Pi's navigation API when opening the
   materialized session.

The server validates the envelope rather than interpreting model content. It
must verify the format versions, session ID, unique entry IDs, resolvable parent
links, and head membership. Preserve unknown valid Pi entry types as JSON so
extensions remain compatible.

### HTTP surface

Implement:

```text
GET    /v1/health
GET    /v1/sessions
POST   /v1/sessions
POST   /v1/sessions/:id/lease
POST   /v1/sessions/:id/lease/renew
PUT    /v1/sessions/:id
DELETE /v1/sessions/:id/lease
```

`GET /v1/sessions` returns only list metadata, current ETag, lease holder label,
lease expiry, and workspace pointer. Acquiring a lease returns the complete
snapshot and an opaque random lease token. Updating requires both the token and
`If-Match` ETag. Errors use stable machine codes with conventional HTTP status:
`409` for duplicate enrollment, `412` for a stale ETag, and `423` for an active
lease.

No browser talks directly to this API in the first integration; CLI extensions
and server-side adapters are the clients.

## Go server implementation

### Filesystem store

Store one canonical file per session:

```text
${PI_SYNC_DATA_DIR}/sessions/<session-id>.json
```

On create or update:

1. Decode with request and nesting limits.
2. Validate the canonical envelope.
3. Serialize through one canonical encoder.
4. Write a temporary sibling file with restrictive permissions.
5. Flush the file, atomically rename it, and flush the parent directory.
6. Compute the returned ETag from the exact stored bytes.

Serialize mutations per session. Listing may scan the directory because the
personal store is expected to contain a modest number of sessions. Reject
symlinks, malformed filenames, path traversal, duplicate IDs, and oversized
payloads.

### Lease registry

Keep leases in a mutex-protected in-memory map. A lease contains the session ID,
random token, display-only holder label, acquisition time, and expiry. The
registry must use an injected clock so expiry and renewal tests are
deterministic.

Renewal extends expiry regardless of how long the current agent run has lasted.
A restart clears the registry. The client then learns that its token is invalid
and may reacquire only against the same ETag.

### Process and deployment contract

`pi-syncd` needs only:

```text
PI_SYNC_LISTEN       listen address, with a safe local default
PI_SYNC_DATA_DIR     persistent data root
```

Expose health/readiness through `/v1/health`. Handle SIGTERM by stopping new
requests, allowing current atomic writes to complete, and exiting within the
Kubernetes grace period.

The generic Kubernetes deployment is one replica with a Recreate strategy,
non-root security context, ClusterIP service, probes, and a PVC mount. The
site-specific PV, route, image pull secret, and Argo CD Application remain in
the infra repository.

## TypeScript client and Pi extension

### Reusable client

Implement a dependency-light client with typed methods for list, enroll,
acquire, renew, update, and release. It must apply short request timeouts,
validate protocol version and response shape, and sanitize server errors before
showing them to users. Lease tokens never enter session entries, logs, process
arguments, or Git metadata.

### Local binding state

Store device-local bindings beneath the Pi agent state directory. A binding
associates the native session ID with server URL, canonical session ID, last
ETag, and materialized local file. The active lease token is persisted only as
needed to survive extension reload during `ctx.switchSession()` and removed on
release.

Generate one stable, local-only device label for lease displays. Do not sync
that identity through the conversation.

### Commands

Implement:

- `/sync`: fetch list metadata, show a normal `ctx.ui.select()` picker, acquire
  the selected lease, materialize under the current workspace, switch the Pi
  session, and navigate to the stored head.
- `/sync start`: enroll the current persistent local session and begin its
  lease/heartbeat lifecycle.
- `/sync status`: display server reachability, lease state, ETag state, and the
  recorded upstream branch/commit.

A synchronized session opened through Pi's native local resume flow must verify
its binding and current lease before accepting input. When it cannot safely
refresh an already-loaded manager, block input and direct the user through
`/sync` so replacement uses the supported session switch lifecycle.

### Lifecycle

- Start the heartbeat after enrollment or acquisition and renew independently
  of agent activity.
- On `agent_settled`, normalize the complete session using the manager's current
  leaf, derive the current upstream Git pointer, and upload with the lease token
  and base ETag.
- On `session_shutdown`, attempt a final changed-session upload, then release.
- If renewal fails transiently, mark the lease uncertain and block the next new
  prompt. Finish any already-running turn locally.
- If reacquisition finds the same ETag, upload normally. If it finds a new ETag,
  preserve the local materialization and surface a conflict without mutating
  either copy.

### Workspace skill

Ship `synchronized-workspace` in the package. It instructs agents working in a
synchronized conversation to create coherent commits and push their upstream
before claiming the work can continue elsewhere, while excluding credentials
and machine-local files. The extension adds a concise per-turn context line
containing the recorded upstream branch and commit so the model knows when the
skill applies.

## Verification

### Go tests

Cover canonical encoding, malformed/truncated envelopes, entry graph
validation, atomic replacement, conditional update, concurrent lease attempts,
renewal, expiry with a fake clock, restart behavior, signal shutdown, and
request-size bounds. Run race-enabled tests in CI.

### TypeScript tests

Use sanitized native Pi fixtures containing linear history, in-file branches,
compaction, labels, custom entries, and parent sessions. Verify normalization,
materialization under different `cwd` values, head restoration, lease state
transitions, settled upload, shutdown release, timeout handling, and stale ETag
preservation.

### End-to-end test

Start a temporary `pi-syncd` and two isolated Pi agent homes. Enroll from client
A, confirm B receives `423` while A is active, release A, continue from B under
a different workspace path, and then return the updated conversation to A.

## Delivery sequence

1. Establish repository tooling and protocol fixtures.
2. Implement and test the Go store, lease registry, and API.
3. Implement the reusable TypeScript client and native session adapter.
4. Implement the Pi commands, lifecycle hooks, and skill.
5. Prove CLI-to-CLI synchronization locally.
6. Add generic container and Kubernetes release artifacts.
7. Integrate pi-ez-web through its repository plan.
8. Roll out the selfhost deployment through the infra repository plan.

The first tagged protocol remains `v1`; compatibility changes require a new API
version rather than silent reinterpretation of stored sessions.
