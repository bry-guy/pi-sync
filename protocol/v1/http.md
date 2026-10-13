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
| GET | `/v1/sessions/:id` | complete snapshot and ETag without taking a lease (older clients) |
| POST | `/v1/sessions/:id/lease` | acquire lease and return complete snapshot |
| POST | `/v1/sessions/:id/lease/renew` | renew lease |
| PUT | `/v1/sessions/:id` | replace complete snapshot conditionally |
| GET | `/v1/sessions/:id/entries?from=N` | entries from index `N` on, a page at a time, without a lease |
| POST | `/v1/sessions/:id/entries` | append entries conditionally under the lease |
| DELETE | `/v1/sessions/:id/lease` | release lease |

## Appending

Conversations grow without a size limit, so current clients never send or fetch the
whole conversation once it is on both sides:

- **`POST /v1/sessions/:id/entries`** sends `{ "baseCount": N, "entries": [...], "headEntryId": "...", "title": "...", "workspace": {...} }`
  with the lease and `If-Match`. `baseCount` must equal the server's entry count, so a
  device can only append to the copy it last saw; a mismatch is `412 stale_etag` like a
  stale ETag. An empty `entries` list just moves the head or changes the title.
  New entries must have unique ids, and their parents must already exist or come
  earlier in the batch. The response carries the new `etag` and `count`.
- **`GET /v1/sessions/:id/entries?from=N&prevId=ID`** returns `{ session, etag, count, from, complete, prevId }`,
  where `session.entries` holds entries `N…` up to about 16 MB and `prevId` is the id of entry
  `N-1`. A client that already holds `N` entries sends the id of its entry `N-1`; if it differs,
  the server answers `409 prefix_mismatch` and the client downloads everything, because a
  whole-conversation write can rewrite history without changing the count. Clients repeat with
  `from` advanced until `complete` is true. `from` past the end is `409 range_not_satisfiable`.
- **`POST /v1/sessions/:id/lease?entries=none`** acquires the lease and returns the
  header, `etag` and `count` without entries.
- **Responses** to create and update carry `count` and may omit entries.

Limits apply per request (64 MB body) and per entry (32 MB), never to the conversation.
Clients enroll a conversation larger than one request as a first part followed by appends.

The server stores each conversation as an append-only log, so an append costs the
size of what it adds. A conversation stored by an older server as a single file is
converted on first use. It keeps reporting the older ETag until the next write, so
devices that already hold that ETag stay current through the upgrade.

Lease tokens are returned only by acquisition and are sent in
`X-Pi-Sync-Lease`. `Authorization: Bearer` and `X-Lease-Token` are accepted
as compatibility aliases. Updates must also send `If-Match` with the exact ETag
returned by acquisition or the previous update.

A workspace pointer may carry `"wip": { "commit": "<hex>", "branch": "<local branch>" }`:
a working-tree snapshot whose parent is the device's local HEAD, pushed by the
client to `refs/pi-sync/<sessionId>` on the repository's remote. The server
only stores and validates the pointer; it never touches Git.

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
