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
| GET | `/v1/sessions` | metadata, ETags, lease display, workspace pointers (optionally filtered by repository) |
| POST | `/v1/sessions` | create an enrolled canonical snapshot (`201`) |
| POST | `/v1/sessions/:id/lease` | acquire lease and return complete snapshot |
| POST | `/v1/sessions/:id/lease/renew` | renew lease |
| PUT | `/v1/sessions/:id` | replace complete snapshot conditionally |
| DELETE | `/v1/sessions/:id/lease` | release lease |

Lease tokens are returned only by acquisition and are sent in
`X-Pi-Sync-Lease`. `Authorization: Bearer` and `X-Lease-Token` are accepted
as compatibility aliases. Updates must also send `If-Match` with the exact ETag
returned by acquisition or the previous update.

Acquisition accepts `{ "holder": "display-only device label", "repository": "normalized repository identity" }`.
The optional `repository` value is `none` for an unscoped conversation. A
scoped conversation requires a matching repository value; mismatches return
`409 workspace_mismatch`, and missing scope returns `409 workspace_required`.
`GET /v1/sessions?repository=<value>` applies the same filter. The default
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
- `409 workspace_mismatch` / `workspace_required`: the requested repository
  scope does not match the canonical conversation.
- `412 stale_etag`: the submitted base is no longer canonical.
- `423 active_lease` / `lease_invalid`: another client owns the lease or the
  token is no longer valid.
- `413 request_too_large`: request limits were exceeded.

The server never merges conversation entries and never overwrites a stale
base. Clients preserve their local materialization when an update receives
`412`. A missing server record is not recreated automatically in the background;
the Pi extension marks the local binding as requiring setup and `/sync attach`
explicitly re-enrolls the local session after confirmation.
