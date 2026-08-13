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

```text
                    ┌─────────────────────────────┐
   HTTP ──────────▶│  Routes          (src/routes)   │
                    │  parse, validate, format        │
                    ├──────────────────────────────┤
                    │  Services        (src/services) │
                    │  validation, batching, rollups, │
                    │  retention                      │
                    ├──────────────────────────────┤
                    │  Repository (src/repositories)  │
                    │  all SQL, parameterised         │
                    └────────────────┬───────────────┘
                                     │
                    ┌────────────────▼───────────────┐
                    │  PostgreSQL                     │
                    │  logs (partitioned by day)      │
                    │  log_rollup_1m (partitioned)    │
                    └──────────────────────────────┘

```

Route handlers never build SQL, and the repository knows nothing about
HTTP. Validation and query-parameter parsing are pure functions over
plain objects, which is what allows them to be unit tested without a
database or a running server.

### Layout

```text
src/
├── config/env.ts              typed environment loading
├── db/
│   ├── pool.ts                connection pool
│   └── migrate.ts             migration runner
├── routes/                    HTTP handlers
├── services/
│   ├── validation.ts          per-entry validation
│   ├── queryParams.ts         query-string parsing
│   ├── ingestionBatcher.ts    request coalescing
│   ├── rollupService.ts       pre-aggregation
│   └── retentionService.ts    partition maintenance
├── repositories/              SQL
└── types/                     shared interfaces
migrations/                    numbered .sql files
loadtest/                      k6 scripts and results
scripts/contract-test.sh       API contract verification

```

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
from different queries incomparable.\n

## Schema design

The schema follows from the access patterns. Every query in the contract
is time-bounded: `since` and `until` are required on aggregation and
present on most log queries. Time is the dominant dimension, and the
schema is organised around that.

### The logs table

```sql
CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');

CREATE TABLE logs (
    id         BIGINT      NOT NULL DEFAULT nextval('logs_id_seq'),
    ts         TIMESTAMPTZ NOT NULL,
    level      log_level   NOT NULL,
    service    TEXT        NOT NULL,
    message    TEXT        NOT NULL,
    attributes JSONB       NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);

```

**Daily range partitioning.** This is the decision the rest of the design
rests on, and it solves two problems at once.

Retention becomes `DROP TABLE`, a catalog operation that unlinks files
and updates system tables. A bulk `DELETE` of the same rows would mark
them dead under MVCC, leave them occupying disk until autovacuum
reclaimed them, invalidate four index entries per row, and compete with
ingestion for a single database CPU. Dropping five partitions containing
roughly 167,000 rows measured at **34ms** with the service still serving
traffic.

Partition pruning then makes time-bounded queries cheap. A one-hour
aggregation eliminates 37 of 38 partitions before reading a row:

```text
EXPLAIN SELECT count(*) FROM logs
WHERE ts >= now() - interval '1 hour' AND ts < now();

 Aggregate
   ->  Append
         Subplans Removed: 37
         ->  Bitmap Heap Scan on logs_2026_08_05
               ->  Bitmap Index Scan on logs_2026_08_05_pkey

```

The same query without `until` prunes far less, because an open-ended
range cannot be bounded at the upper end. That is why the contract makes
both bounds required on `/logs/aggregate`, and it is a performance
requirement expressed as an API constraint.

Partitions are created three days ahead by a scheduled job and on demand
before each write. A row with no matching partition raises an error that
aborts the entire insert transaction rather than the single row, which
would defeat partial acceptance.

**`PRIMARY KEY (ts, id)`.** PostgreSQL requires the partition key to be
part of the primary key, so `ts` must be included. Including `id` is not
merely a consequence: it gives the total ordering the contract requires.
At high ingest rates many rows share a timestamp, and ordering by `ts`
alone would let PostgreSQL return ties in any order, so a cursor could
skip or repeat rows between pages.

**`level` as an enum.** Four values, fixed by the contract. An enum
stores as 4 bytes, compares as an integer, and rejects invalid values at
the database boundary as a second line of defence behind application
validation.

**`ts`, not `timestamp`.** `timestamp` is a type name in SQL. Legal as a
column name, but it makes cast and `date_trunc` expressions ambiguous to
read. The API still uses `timestamp`; the mapping happens in the
repository layer.

**An explicit sequence with `CACHE 1000`.** Each session claims a block
of ids rather than touching the sequence per row, removing a contention
point at high insert rates. The cost is gaps in the id sequence after a
restart, which does not matter for an opaque identifier.

### Index design

Four indexes, declared on the parent so they propagate to every
partition including ones created later.

| Index | Serves |
|-------|--------|
| `PRIMARY KEY (ts, id)` | Time-range scans and cursor pagination |
| `(service, ts DESC, id DESC)` | `service` filter, still ordered by time |
| `(level, ts DESC, id DESC)` | `level` filter, still ordered by time |
| `GIN (attributes jsonb_path_ops)` | `attr.<key>` equality |

The two composite indexes lead with the filter column and continue with
the sort key, so a filtered query can be satisfied without a separate
sort step.

**`jsonb_path_ops` rather than the default `jsonb_ops`.** The default
indexes keys and values separately and supports key-existence operators
we never use. `jsonb_path_ops` indexes hashes of complete key/value
paths, supports only containment, and is roughly two to three times
smaller. Under a 1 GB memory limit, index size decides whether the
working set stays cached, so the smaller index is the better one here.

Index count is a deliberate trade-off. Every index is additional work on
every insert, and ingestion is the throughput-critical path. Four is the
minimum that covers the contract's filters without leaving one to a
sequential scan.

## Attribute storage

Attributes are an arbitrary flat map of string, number, and boolean
values, filterable by exact key. Three approaches were considered.

**A separate key/value table** would allow a plain B-tree index on
`(key, value)`, which is fast for equality. It was rejected on write
amplification: the contract's own example carries three attributes, so at
15,000 logs per second the database would receive 15,000 log rows plus
45,000 attribute rows. Every query would also need a join, and multiple
attribute filters would need several.

**JSONB with a GIN index** keeps one row per log, matches the schemaless
shape exactly, and returns attributes in responses without reassembly.

**JSONB with values normalised to strings at ingestion** is what the
service does, and the normalisation is the important part.

The contract specifies that attribute filters are compared as strings, so
`attr.retries=3` arrives as the string `"3"`. JSONB containment is
type-aware: a log ingested with `"retries": 3` as a number would not
match `attributes @> '{"retries":"3"}'`. The query would silently return
nothing.

Casting at query time would fix the match but bypass the GIN index,
forcing a sequential scan over a million rows and losing the sub-second
target. Converting once at write time keeps every attribute filter a
single indexable containment check:

```sql
attributes @> '{"user_id":"42","region":"eu-west"}'::jsonb

```

One condition covers any number of attribute filters, and the attribute
keys are passed as part of a JSONB parameter rather than as SQL
identifiers.

The cost is that original types are not preserved on read: a log
ingested with `"retries": 3` is returned as `"retries": "3"`. This is
listed under [Known limitations](#known-limitations).

## Retention

Retention is configured by `RETENTION_DAYS`, defaulting to 30.

An hourly job performs two tasks together:

- drops partitions whose entire range falls before the cutoff
- creates partitions three days ahead

The second matters as much as the first. Partitions are created over a
bounded window by the initial migration, and without ongoing creation the
service would eventually receive a timestamp with no matching partition.

Dropping is a catalog operation, so expired data is removed without
scanning rows, without producing dead tuples for autovacuum to reclaim,
and without index maintenance. Only partitions entirely outside the
retention window are dropped, so the `ACCESS EXCLUSIVE` lock taken is
never contended: nothing reads or writes data outside the window.

Rollup partitions are dropped on the same schedule for the same reason.

The job runs once at startup so a service that has been down longer than
the interval catches up immediately. It takes an advisory lock rather
than a blocking one, so if another instance is already performing
maintenance this one skips rather than waits. A failed pass logs and
lets the schedule continue; the next run retries.

## Pre-aggregation

Aggregation queries were measured at 2.25s p95 under concurrent
ingestion against 142ms on an idle database, with PostgreSQL never
exceeding 45% CPU and 30 GB of block I/O accumulated. The system was not
compute-bound: aggregation was reading rows whose pages ingestion kept
evicting from cache, on a disk already saturated by writes. The remedy is
to read fewer rows.

`log_rollup_1m` stores counts per minute, service, and level, partitioned
by day like `logs`:

```sql
CREATE TABLE log_rollup_1m (
    bucket   TIMESTAMPTZ NOT NULL,
    service  TEXT        NOT NULL,
    level    log_level   NOT NULL,
    count    BIGINT      NOT NULL,
    PRIMARY KEY (bucket, service, level)
) PARTITION BY RANGE (bucket);

```

One minute is the finest bucket the contract defines, and 5m, 1h, and 1d
are whole multiples of it, so all four sizes derive from this one table.

**Only `service` and `level` are pre-aggregated.** Attribute values and
message text cannot be. Including a single attribute with 100,000
distinct values would multiply the rollup by that factor and make it
larger than the raw data it summarises, and the contract allows arbitrary
attribute keys, so there is no fixed set to precompute. Queries filtering
on `attr.*` or `q` fall back to raw rows.

**Maintenance is asynchronous.** Updating rollups inside the ingestion
transaction would add an upsert per group to every flush, on a write path
that is already the constraint. The contract allows 20 seconds before
data must be queryable, which is ample room for a lagging summary.

**The job stops six minutes behind `now()`.** A minute is only safe to
summarise once no further rows can land in it. Ingestion accepts
timestamps up to five minutes in the future, so rolling up the current
minute would freeze a partial count below the watermark, and every row
arriving afterwards would be silently absent from every aggregation.

**A watermark records how far rollups are complete.** Ranges below it are
served from the summary, ranges above from raw rows, and a query spanning
the boundary reads both and sums the subtotals. The two ranges are
disjoint by construction, so no row is counted twice and none is missed.

Each pass is idempotent: counts are written with `ON CONFLICT DO UPDATE`,
and the watermark advances only on success, so a failed pass retries the
same range rather than skipping it.

Correctness was verified by comparing rollup and raw totals both entirely
below the watermark and across it. Totals matched exactly in both cases.

