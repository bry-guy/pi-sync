# Client-state repair plan

Status: implemented as a small follow-up to the v1 release

## Decision

Normal synchronization remains automatic: the extension renews its lease in the
background and uploads settled snapshots. Recovery is deliberately human-led.
This project does not attempt to build distributed reconciliation or a complete
server-disaster-recovery system.

When a bound session receives a confirmed `session_not_found` response, the
client preserves its local file, stops claiming that it is synchronized, and
marks the binding `setup_required`. It does not recreate the server record in
the background. The user runs `/sync attach` to set the record up again from the
current local session.

Create-if-absent remains the safety boundary. A repair that receives
`duplicate_enrollment` never overwrites an existing server copy; the user is
directed to `/sync` to open the canonical copy.

## Scope

The repair path covers:

- a durable server record disappearing while the local Pi session remains;
- a lost or newly created local binding file during ordinary setup;
- restarting synchronization after a user has restored or re-seeded the server.

It does not cover:

- automatic background recreation;
- distributed winner selection or merge;
- perfect VM, PVC, or server-store deletion recovery;
- rollback artifact management;
- destructive server reset/delete endpoints;
- automatic conflict resolution.

Existing lease and ETag behavior remains unchanged. A stale ETag is still a
conflict, not a repair trigger, and network failures never prove that a server
record is absent.

## Binding state

Bindings may contain the persisted state:

```text
ready | setup_required
```

Older bindings without a state are treated as `ready`. The active lease token is
removed when a binding enters `setup_required`; local session content and the
last known ETag remain available for diagnostics.

`setup_required` is set only after the client receives the server's stable
`session_not_found` protocol error from acquisition, renewal, or update. Timeouts,
invalid responses, stale ETags, active leases, and unreachable servers retain
their existing blocked/error behavior.

## Repair flow

When `/sync attach` is run for a `setup_required` binding:

1. Require a persistent current Pi session and the configured server URL.
2. Normalize the local JSONL session through the existing adapter.
3. Call the existing `POST /v1/sessions` create-if-absent endpoint.
4. On `201`, update the binding's ETag, fingerprint, workspace metadata, and
   state. The next prompt takes the lease as usual.
5. On `409 duplicate_enrollment`, adopt the existing canonical copy. Any local
   conversation entries it lacks are saved as a separate session first.
6. On any other failure, preserve `setup_required` and the local file.

A session without a binding continues to use `/sync attach` for normal initial
enrollment. If the server already contains that session ID, it is never
silently overwritten.

## User runbook

For an empty or restored server:

1. Choose the client containing the desired local conversation.
2. Run `/sync attach`.
3. On other clients, use `/sync` to acquire the newly canonical copy.
4. Resume normal lease-transfer operation.

## Verification

Client and extension tests cover:

- persisted `setup_required` bindings;
- `session_not_found` clearing the lease and blocking synchronization;
- explicit repair creating a missing record;
- duplicate repair never overwriting a server record;
- network, timeout, stale-ETag, and active-lease errors never triggering repair;
- local session preservation throughout the flow.

The recovery end-to-end gate uses a temporary daemon store reset followed by
explicit re-enrollment from one isolated client and normal `/sync` acquisition
from another. It does not attempt to model a distributed store-recovery race.

## Follow-up

If production experience shows that manual repair is too frequent, a later
version may add exact-envelope reattachment or a richer conflict resolver. That
work is intentionally deferred until the simple repair path has real usage.
