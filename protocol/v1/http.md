# Pi synchronization protocol v1

`pi-syncd` is intended to be reachable only through a trusted private network.
There is no application-level authentication in v1.

## Session envelope

The JSON body for enrollment and updates is the versioned envelope in
[`session.json`](session.json). `entries` contains every native Pi entry after
the local session header. Header `cwd` and `parentSession` paths are never
stored in the envelope. Unknown valid entry types are retained as JSON.

`workspace` is omitted when the checkout has no configured upstream. When
present, it contains only the remote URL, upstream branch, and full upstream
commit. Local paths, dirty state, local-only commits, credentials, and stashes
are not synchronized.

## Endpoints

| Method | Path | Response |
| --- | --- | --- |
| GET | `/v1/health` | protocol and lease timing |
| GET | `/v1/sessions` | metadata, ETags, `updatedAt`, lease display, workspace pointers (optionally filtered by repository) |
| POST | `/v1/sessions` | create an enrolled canonical snapshot (`201`) |
| GET | `/v1/sessions/:id` | complete snapshot and ETag without taking a lease |
| POST | `/v1/sessions/:id/lease` | acquire lease and return complete snapshot |
| POST | `/v1/sessions/:id/lease/renew` | renew lease |
| PUT | `/v1/sessions/:id` | replace complete snapshot conditionally |
| DELETE | `/v1/sessions/:id/lease` | release lease |

Lease tokens are returned only by acquisition and are sent in
`X-Pi-Sync-Lease`. `Authorization: Bearer` and `X-Lease-Token` are accepted
as compatibility aliases. Updates must also send `If-Match` with the exact ETag
returned by acquisition or the previous update.

Acquisition accepts `{ "holder": "display-only device label", "repository": "normalized repository identity", "takeOver": false }`.
With `"takeOver": true` acquisition replaces an active lease instead of
returning `423 active_lease`; the previous holder's token stops working, so its
renewals and uploads fail with `423 lease_invalid`. Clients offer this only
after the user confirms, for a device that is asleep or stuck mid-turn.
The repository value is advisory and only validated for format: a
conversation's upstream can appear, change, or disappear as the user pushes
and switches branches, so acquisition and updates never reject a scope
change. `GET /v1/sessions?repository=<value>` filters the list by the
normalized remote of each conversation's last workspace pointer (`none`
selects unscoped conversations). The default
lease heartbeat is 20 seconds and expiry is 120 seconds. A restart clears all
leases.

## Errors

Errors are JSON objects with a stable machine code:

```json
{
  "error": {
    "code": "stale_etag",
    "message": "canonical session changed"
  }
}
```

Important statuses are:

- `404 session_not_found`: a previously bound session no longer exists on the server; the client preserves its local copy and requires explicit re-enrollment.
- `409 duplicate_enrollment`: the session ID already exists. Repair clients never overwrite the existing copy.
- `412 stale_etag`: the submitted base is no longer canonical.
- `423 active_lease` / `lease_invalid`: another client owns the lease or the
  token is no longer valid.
- `413 request_too_large`: request limits were exceeded.

The server never merges conversation entries and never overwrites a stale
base. When a client finds a newer canonical copy, it replaces its local file.
It first saves any conversation entries the canonical copy lacks as a separate,
unsynchronized session. A missing server record is not recreated automatically
in the background. The Pi extension marks the local binding as requiring setup,
and `/sync attach` re-enrolls the local session.
