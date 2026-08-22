# Client-state recovery and reconciliation plan

Status: proposed follow-up to the v1 release

## Decision

`pi-syncd` remains the normal canonical authority, but each participating client
also has a materialized local session and a last-known synchronization baseline.
The client and server therefore have enough information to distinguish a
one-sided change from a real disagreement.

A missing server record is not a conflict: the server has no opinion. At a safe
settled point, the client should mark the session `recovery_required` and
automatically recreate the server record from its current local state using the
existing create-if-absent API. This should not require a special manual
recovery command.

A conflict exists only when both sides have changed since their shared
baseline. In that case the session is marked `conflict` and the user is asked
to choose whether to continue from the server copy, the local copy, or defer.
No copy is silently overwritten or merged.

The server store should still be durable for ordinary restarts and rollouts.
Client-side reconciliation is a disaster-recovery path, not a replacement for
normal persistence.

## Current behavior and gap

The released v1 package already supports the basic cases:

- `/sync start` normalizes an existing persistent local Pi session and creates
  it with `POST /v1/sessions`.
- `/sync` lists server sessions and materializes one onto a new client.
- `POST /v1/sessions` is create-if-absent, so duplicate enrollment cannot
  silently overwrite a canonical session.
- Bindings retain the last ETag and local envelope fingerprint.

The missing behavior is reconciliation:

- If the server record is lost, renew/acquire returns `session_not_found` and
  the extension becomes blocked without attempting a safe recreate.
- If an unbound local session already exists on the server, `/sync start` treats
  the duplicate as an error instead of proving whether the local state matches
  and attaching it.
- If both local and server copies changed, the current flow does not present a
  user-facing choice between them.

## Goals

1. Make initial setup from a pre-existing local session idempotent.
2. Automatically mark and repair one-sided server-store loss from a client.
3. Detect two-sided divergence using the last synchronized baseline.
4. Ask the user to choose a winner only for genuine conflicts.
5. Preserve the losing copy for inspection/rollback; never silently merge it.
6. Never turn a network timeout, stale ETag, or active lease into recovery.
7. Give pi-ez-web the same state and error semantics through its adapter.

## Non-goals

- Replicating the server store across multiple `pi-syncd` instances.
- Automatically choosing between divergent local and server copies.
- Adding a destructive server reset or delete endpoint.
- Treating client copies as a substitute for normal server persistence.
- Transferring Git patches, dirty state, credentials, or local-only commits.

## State model

A binding already provides the comparison baseline:

- `lastFingerprint`: the last local envelope successfully accepted by the
  server; it is also the expected server content at that point.
- `lastEtag`: the server version returned with that accepted envelope.
- current local fingerprint: computed from the current settled local session.
- current server fingerprint: computed from the canonical envelope returned by
  acquisition.

At a safe point, compare both current fingerprints to the shared baseline:

| Local vs baseline | Server vs baseline | Result |
| --- | --- | --- |
| equal | equal | Continue normally. |
| changed | equal | Client is the only writer; upload local under the server ETag. |
| equal | changed | Server is the only writer; materialize server locally. |
| changed | changed, equal to local | Copies converge; update binding and continue. |
| changed | changed, different | Mark `conflict` and ask the user. |
| no baseline | exact match | Attach the local file to the server session. |
| no baseline | different | Mark `conflict`; never attach or overwrite silently. |

Do not normalize or replace a local session while it is streaming or compacting.
A current turn may finish locally, but reconciliation waits for its settled
snapshot.

## Automatic initial enrollment and reattachment

Keep `/sync start` as the user-facing setup command, but make it idempotent:

1. Require a persistent session file and a configured server URL.
2. Normalize the current local file and derive its portable workspace pointer.
3. Call `POST /v1/sessions`.
4. On `201`, persist the binding, acquire the lease, and start heartbeat.
5. On `409 duplicate_enrollment`, locate the existing canonical session by
   ID/list metadata, acquire its snapshot, and compare fingerprints.
6. If the local and server envelopes match, persist a binding for the local
   file without replacing it and continue with the normal lease lifecycle.
7. If they differ, mark `conflict` and ask the user whether to use the server
   copy or this local copy. `/sync` remains the safe path to materialize the
   server copy.
8. Preserve local state on every error.

A duplicate enrollment must never be treated as permission to overwrite the
server. If the canonical session cannot be found after a duplicate response,
report a recoverable protocol inconsistency rather than retrying blindly.

## Automatic server-store recovery

When an existing binding receives `session_not_found` from renew/acquire, or a
server list confirms that its canonical ID is absent:

1. Mark the binding `recovery_required` and notify the user without exposing
   raw session content, credentials, or lease tokens.
2. Keep the local session available for inspection and local work. Block claims
   of synchronized mutation until reconciliation succeeds; an already-running
   turn may settle locally.
3. At the next safe settled point, normalize the current local session.
4. Attempt `POST /v1/sessions` with the same canonical session ID. This is an
   automatic best-effort repair, not a separate manual recovery command.
5. On `201`, update the binding's ETag/fingerprint/workspace metadata, acquire
   the lease, clear `recovery_required`, and report that the server was
   recreated from this client.
6. On `409 duplicate_enrollment`, another client recreated the record first.
   Acquire that copy and run the state comparison table above.
7. On a network error, timeout, invalid response, active lease, or stale ETag,
   keep the marker and retry with bounded backoff. Never create from a failure
   that did not prove the server record was absent.

If several clients detect a wiped store, the first successful create wins the
race. Other clients do not overwrite it; they compare their local state and
surface a conflict if it differs. This makes the best-effort behavior safe
without pretending there is a distributed way to know which client was newest.

Recovery should be attempted automatically from lifecycle-safe hooks:

- after session start detects the missing record;
- after an active turn reaches `agent_settled`;
- before the next synchronized mutation;
- during bounded background retry while the server is reachable.

An optional `/sync reconcile` command may trigger an immediate retry or reopen a
conflict prompt, but ordinary recovery must not depend on users remembering a
special command.

## Conflict resolution

When both local and server copies changed from the same baseline, present a
clear choice:

```text
This conversation changed locally and on the sync server.
[Use server copy] [Use this client copy] [Decide later]
```

The resolver must:

### Use server copy

1. Hold or reacquire the server lease.
2. Preserve the current local session as a timestamped local rollback file.
3. Materialize the server envelope through the normal temporary-sibling and
   atomic-replace path.
4. Restore the server head and update the binding baseline.
5. Clear `conflict` and resume synchronization.

### Use this client copy

1. Hold or reacquire the server lease and obtain the current ETag.
2. Recompute the local settled envelope immediately before writing.
3. Upload it with `PUT`, the lease token, and `If-Match`.
4. If the ETag changed while the prompt was open, return to conflict instead
   of overwriting the newer server copy.
5. Update the binding baseline and resume synchronization.

### Decide later

Release any lease, preserve both copies, keep the `conflict` marker, and block
synchronized mutations until the user chooses. Local inspection/export remains
available.

The browser and CLI should display metadata such as title, timestamps, and
workspace branch/commit. They should not dump complete conversation contents
into a confirmation prompt.

## Rebinding a local copy with no binding

If the local binding file is lost while the native session remains:

- `/sync` remains the safe default and materializes the canonical server copy
  into a new local session.
- `/sync start` handles the common case by attempting create, then resolving a
  duplicate through fingerprint comparison.
- A future explicit `/sync connect <server-session-id>` may make the intent
  clearer, but it is not required for the first recovery implementation.

An unbound local file must never be attached to a server session solely because
its title or native ID looks similar. Exact normalized-envelope equality is the
minimum condition for automatic attachment; otherwise show a conflict.

## Binding and adapter error semantics

Expose these non-secret states:

```text
available | in_use | pending | recovery_required | conflict | unreachable
```

`session_not_found` during renew/acquire maps to `recovery_required`, not a
generic network error. A stale ETag remains `conflict`; it must never trigger
server recreation.

The pi-ez-web adapter should map the same conditions to stable application
errors and state rows. Its reconciliation loop may automatically recreate a
missing server record from a settled web session, but must never let
`PI_WEB_SYNC_ALL_CONVERSATIONS` silently choose among divergent sessions. It
should surface conflicts for operator/user choice.

## Recovery runbook

For an actual store loss:

1. Clients detect the missing records and mark affected sessions
   `recovery_required`.
2. The first idle/settled client automatically recreates each record from its
   current local state.
3. Other clients reconnect, compare their local state, and either converge
   automatically or show a conflict choice.
4. If copies disagree, the user chooses server or a specific client; the losing
   copy remains preserved locally.
5. Verify `/sync` list output and resume normal lease-transfer tests.

No manual recovery command should be required for the normal one-sided-loss
case. Manual intervention is required only when there are genuinely divergent
opinions or no client has a usable local session.

## Tests

### Client and extension

- `/sync start` creates a binding from an existing local session.
- Duplicate enrollment with an identical local envelope attaches safely.
- Duplicate enrollment with a different local envelope produces `conflict`.
- `session_not_found` marks `recovery_required` and does not immediately write
  while a session is streaming.
- A settled missing-record session automatically recreates itself.
- Network errors and timeouts never trigger recreation.
- Two clients racing to recreate result in exactly one `201`; the other
  compares against the winner without overwriting it.
- Only-local-changed uploads automatically with the expected ETag.
- Only-server-changed materializes automatically while preserving local
  rollback state.
- Both-changed divergence presents server/local/defer choices.
- Choosing local uses a fresh ETag and returns to conflict if the server changed
  while the prompt was open.
- Choosing server atomically materializes and restores the remote head.

### Server and end-to-end

- Temporary-store deletion followed by automatic one-client recreation and
  second-client convergence.
- Recovery across different local `cwd` values with workspace pointers intact.
- Recovery after an expired lease and after a server restart.
- A stale ETag remains a conflict, never a recovery trigger.
- A real temporary `pi-syncd` plus two isolated client homes exercises the full
  reconciliation state machine.

## Delivery order

1. Add this reconciliation contract and operator semantics to the released
   protocol documentation.
2. Add baseline comparison, `recovery_required`, and automatic missing-record
   recreation to the client/extension.
3. Make `/sync start` duplicate-safe for identical pre-existing local state.
4. Add the conflict resolver and atomic server/local choice flows.
5. Add pi-ez-web adapter mapping, reconciliation, and UI/operator reporting.
6. Run the two-client disaster-recovery and divergence end-to-end gates before
   treating local storage as an acceptable server backup policy.

Until this work lands, server persistence remains required and a missing record
will continue to require an implementation-specific manual recovery procedure.
