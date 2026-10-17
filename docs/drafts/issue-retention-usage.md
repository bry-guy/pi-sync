Title: pi-syncd: session retention and usage metrics

## Problem

pi-syncd keeps every synced session and entry forever. There is no retention, pruning, or session delete; the only DELETE routes release leases.

- Today: 61 sessions, 154 MB on a 1 Gi PVC (`pi-sync-data`). Heavy sessions reach ~3,400 entries.
- At current use the PVC fills in months.
- Unknown: whether request handling loads whole transcripts, which would slow down as sessions grow.

## Wanted

### Retention
- Configurable policy, e.g. archive (compressed) or drop sessions untouched for N days.
- Explicit session delete endpoint.
- Optionally compress stored logs at rest.
- Metrics or a status endpoint for storage used.

### Usage metrics
- pi-syncd is the only place that sees sessions from every device, and stored assistant entries keep `usage` (input/output/cacheRead/cacheWrite/totalTokens/cost) plus provider/model/timestamp.
- Add an endpoint such as `GET /v1/usage?from=&to=&groupBy=day,model` that returns token and cost totals.
- De-duplicate forked sessions (copied entries) so totals don't double-count.
- Usage should survive retention: keep per-day aggregates when a session is archived or dropped.
- Per-device attribution needs the producing device on each entry; `Record.Devices` only lists devices that touched the session.

## Consumers
- pi-ez-web Settings → Usage page (tokens and cost per model per day, all devices).
