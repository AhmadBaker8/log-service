# Log Ingestion and Query Service

[![CI](https://github.com/AhmadBaker8/log-service/actions/workflows/ci.yml/badge.svg)](https://github.com/AhmadBaker8/log-service/actions/workflows/ci.yml)

A structured log ingestion and query service built on PostgreSQL. Accepts
batched log entries over HTTP, stores them in a time-partitioned table,
and serves filtered queries and time-bucketed aggregations.

Written in TypeScript on Node.js, with PostgreSQL as the sole source of
truth for both reads and writes.

## Quick start

```bash
docker compose up
```

That is the entire setup. No environment file, no arguments, no manual
steps. The service applies its migrations on startup and listens on
`localhost:8080`.

Verify it is running:

```bash
curl localhost:8080/health
# {"status":"ok"}
```

Send a log:

```bash
curl -X POST localhost:8080/logs \
  -H "Content-Type: application/json" \
  -d '{"logs":[{
        "timestamp":"2026-08-09T14:32:01.123Z",
        "level":"error",
        "service":"checkout",
        "message":"payment declined",
        "attributes":{"user_id":"42","region":"eu-west"}
      }]}'
# {"accepted":1,"rejected":[]}
```

Query it back:

```bash
curl "localhost:8080/logs?service=checkout&level=error&limit=10"
```

### Requirements

Docker with Compose v2. Nothing else; Node and PostgreSQL run inside
containers.

### Ports

| Port | Purpose |
|------|---------|
| 8080 | The service |
| 55432 | PostgreSQL, exposed for inspection during development |

PostgreSQL is published on 55432 rather than 5432 because a local
PostgreSQL install commonly occupies the default port. The application
does not use this path: it reaches the database over the compose network
at `postgres:5432`.

### Development

```bash
npm install
npm run build      # compile TypeScript
npm test           # unit tests
npm run lint
npm run typecheck
```

Running the service outside Docker requires a reachable PostgreSQL and
`DATABASE_URL` set accordingly. See `.env.example`.

## Architecture
+---------------------------------+
HTTP ----------->| Routes (src/routes) |
| parse, validate, format |
+---------------------------------+
| Services (src/services) |
| validation, batching, rollups, |
| retention |
+---------------------------------+
| Repository (src/repositories) |
| all SQL, parameterised |
+----------------+----------------+
|
+----------------v----------------+
| PostgreSQL |
| logs (partitioned by day) |
| log_rollup_1m (partitioned) |
+---------------------------------+
Route handlers never build SQL, and the repository knows nothing about
HTTP. Validation and query-parameter parsing are pure functions over
plain objects, which is what allows them to be unit tested without a
database or a running server.

### Layout
src/
├── config/env.ts typed environment loading
├── db/
│ ├── pool.ts connection pool
│ └── migrate.ts migration runner
├── routes/ HTTP handlers
├── services/
│ ├── validation.ts per-entry validation
│ ├── queryParams.ts query-string parsing
│ ├── ingestionBatcher.ts request coalescing
│ ├── rollupService.ts pre-aggregation
│ └── retentionService.ts partition maintenance
├── repositories/ SQL
└── types/ shared interfaces
migrations/ numbered .sql files
loadtest/ k6 scripts and results
scripts/contract-test.sh API contract verification
## API

### `GET /health`

Returns 200 once the database is reachable. Migrations run to completion
before the server binds a port, so this endpoint cannot be reached
against an unmigrated database.

Connectivity is checked on every call rather than cached at startup, so
the endpoint reports 503 if PostgreSQL becomes unreachable later rather
than continuing to claim health.
### `POST /logs`

Ingests a batch. A batch of one is valid.

```json
{
  "logs": [
    {
      "timestamp": "2026-08-09T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42", "retries": 3 }
    }
  ]
}
```

**Validation**

| Field | Rules |
|-------|-------|
| `timestamp` | Required. ISO 8601. Not more than 5 minutes in the future, and not older than the retention window |
| `level` | Required. One of `debug`, `info`, `warn`, `error` |
| `service` | Required. Non-empty string, max 255 characters |
| `message` | Required. Non-empty string, max 8192 characters |
| `attributes` | Optional. Flat object; values may be strings, numbers, or booleans. Max 64 keys |

Whitespace-only strings count as empty. Nested objects, arrays, and null
attribute values are rejected, as are `NaN` and `Infinity`, which are
typed as numbers in JavaScript but are not representable in JSON.

The lower bound on `timestamp` is not in the specification. It exists
because rows are routed to daily partitions: a row with no matching
partition raises an error that aborts the entire insert transaction,
which would defeat partial acceptance. Rejecting such entries at
validation returns a clean per-entry error instead.

**Responses**

An invalid entry does not fail the batch. Each rejection carries its
index in the input array.

```json
{ "accepted": 9, "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }] }
```

- `200` when at least one entry is accepted
- `400` when every entry is rejected, the JSON is malformed, or the body
  does not contain a `logs` array

A 200 is returned only after the transaction containing those rows has
committed. See [Ingestion](#ingestion) for how that is made fast.

### `GET /logs`

All parameters are optional and may be combined freely.

| Parameter | Meaning | Example |
|-----------|---------|---------|
| `service` | Exact match | `service=checkout` |
| `level` | Exact match | `level=error` |
| `since` | Inclusive start | `since=2026-08-09T14:00:00Z` |
| `until` | Exclusive end | `until=2026-08-09T15:00:00Z` |
| `attr.<key>` | Attribute equality, compared as strings | `attr.user_id=42` |
| `q` | Case-insensitive substring on `message` | `q=declined` |
| `limit` | 1 to 1000, default 100 | `limit=500` |
| `cursor` | Opaque cursor from a previous response | `cursor=eyJ0cyI6...` |

Results are ordered by timestamp descending, with `id` as a tiebreaker.
The tiebreaker is not cosmetic: at high ingest rates many rows share a
timestamp, and without a total ordering pagination would skip and repeat
rows.

```json
{
  "logs": [
    {
      "id": "868001",
      "timestamp": "2026-08-09T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42" }
    }
  ],
  "next_cursor": "eyJ0cyI6..."
}
```

`next_cursor` is `null` when no further results exist.

Unknown query parameters are ignored rather than rejected, so that
optional features can add parameters without breaking existing clients.

**Errors** return `400` with `{"error": "<description>"}`: unparseable
timestamps, `until` earlier than `since`, unsupported levels, non-numeric
or out-of-range limits, and malformed cursors.

### `GET /logs/aggregate`

Time-bucketed counts. Supports the same filters as `GET /logs`.

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `since` | Yes | Inclusive start |
| `until` | Yes | Exclusive end |
| `bucket` | Yes | `1m`, `5m`, `1h`, or `1d` |
| `group_by` | No | `service` or `level` |

`since` and `until` are required because both bounds are what allow
partition pruning to eliminate partitions before any rows are read. An
open-ended range cannot be pruned at the upper end and would scan the
whole table.

```json
{
  "buckets": [
    { "start": "2026-08-09T14:00:00Z", "group": "checkout", "count": 118 },
    { "start": "2026-08-09T14:00:00Z", "group": "auth", "count": 42 }
  ]
}
```

Buckets are ordered ascending by start time. Empty buckets are omitted.
`group` is `null` when `group_by` is absent.

Buckets align to absolute epoch boundaries rather than to `since`, so a
given log falls in the same bucket regardless of the query window.
Aligning to `since` would shift boundaries per request and make results
from different queries incomparable.
