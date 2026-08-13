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

## Performance

All figures below were measured against the containerised stack with the
resource limits the specification mandates, enforced by cgroup v2.

### Test environment

| | |
|---|---|
| Host | WSL2 (Ubuntu 26.04) on Windows, 8 CPU, 7.63 GB |
| App container | 0.5 CPU, 256 MB |
| PostgreSQL container | 1.0 CPU, 1 GB, postgres:16-alpine |
| Load generator | k6 v2.1.0, running on the host |
| Dataset | ~1,000,000 rows spread across 30 daily partitions |
| Batch size | 100 entries per request, 4 attributes each |

The load generator runs on the host rather than in a container, leaving
6.5 CPUs free, so the generator is not itself the bottleneck.

### Methodology

Two k6 scripts, in `loadtest/`:

- `ingest.js` posts batches at a configurable size and concurrency. It
  counts **accepted log entries**, not requests, because the target is
  expressed in logs per second and a request may be partially rejected.
- `query.js` issues aggregations and log queries at a fixed rate. It uses
  a `constant-arrival-rate` executor rather than a VU-based one: a
  VU-based executor slows its own request rate as latency rises, which
  would hide the degradation being measured.

The database volume is reset between measurements. Early runs were
invalid because it was not: each run faced a larger table than the last,
and the resulting decay was initially misread as a configuration effect.
Identical configuration measured 17,668 logs/sec on an empty table and
9,281 logs/sec at ~3.5M rows.

Run-to-run variance is roughly 10%. Differences smaller than that are not
treated as significant.

### Results

**Ingestion, no concurrent queries**

| Batch | VUs | logs/sec | p95 | Failures |
|-------|-----|----------|-----|----------|
| 100 | 10 | 6,136 | 186ms | 0 |
| 100 | 20 | **18,242** | 186ms | 0 |
| 100 | 50 | 12,132 | 2.08s | 0 |
| 500 | 20 | 11,213 | 2.56s | 0 |

Throughput peaks at 20 VUs and falls as load increases further. That is
congestion collapse rather than saturation: at 20 VUs × 100 entries the
buffer reaches its 2,000-row flush threshold exactly, so flushes trigger
on size rather than on the timer. Beyond that, requests queue behind a
saturated event loop.

**Aggregation, idle database, 1,003,400 rows over 30 days**

| Window | Bucket | Rows scanned | Time |
|--------|--------|--------------|------|
| 1 day | 1h | ~33,000 | 32ms |
| 2 days | 1h | ~67,000 | 81ms |
| 30 days | 1h | ~1,003,000 | 1.17s |
| 30 days | 1m | ~1,003,000 | 4.02s |

Time scales with rows scanned at roughly 1.3µs per row. Bucket size
barely matters until the window is large: at 1m over 30 days the query
produces 43,200 buckets × 5 services = 216,000 groups, against 3,600 for
1h, and that cardinality is what separates 1.17s from 4.02s.

**Queries during active ingestion**

This is the condition the specification actually tests, and the isolated
figures above do not predict it.

| Query | Idle | Under ingestion, before rollups | Under ingestion, with rollups |
|-------|------|----------------------------------|-------------------------------|
| aggregate 1 day, 1h | 142ms | 2.25s | **883ms** |
| aggregate 1 day, 5m | 133ms | 1.22s | **496ms** |
| list recent | 77ms | 101ms | 98ms |
| list filtered | 47ms | 204ms | 55ms |
| list by attribute | 53ms | 96ms | 60ms |
| ingestion throughput | 18,242/s | 7,744/s | 7,038/s |

Zero failed requests in every run.

### Bottleneck analysis

**Ingestion alone is application-CPU-bound.** `docker stats` during a
saturating ingestion run:

```text
log-service-app        49.88% CPU   40.69MiB / 256MiB
log-service-postgres   81.87% CPU   554.8MiB / 1GiB
```

Docker reports CPU relative to a single core, so 49.88% is full
saturation of a 0.5 CPU allocation. The cost is JSON parsing and
per-entry validation on Node's single thread. Memory is not a
constraint at 16% of the limit.

**Under concurrent load the constraint moves to disk.** During the
combined test neither container is CPU-bound — PostgreSQL at 65%, the
application at 36% of its allocation — while block I/O accumulated to
tens of gigabytes. Aggregation was reading rows whose pages ingestion
kept evicting from cache, on a disk already saturated by writes.

The latency distribution confirms queueing rather than uniformly slower
work: `min=76ms, median=148ms, p95=2.02s`. Most queries were fast; a
minority landed during a checkpoint and waited seconds.

### Optimisations applied

**Request coalescing on ingestion.** Entries from concurrent requests are
buffered and committed in shared transactions, flushing at 2,000 rows or
100ms. Transaction overhead — WAL write, fsync, commit bookkeeping — is
largely fixed regardless of row count, so committing 2,000 rows costs
little more than committing 20.

Durability is not traded away. Each caller's promise resolves only after
the transaction containing its rows has committed, so a 200 always means
the data is on disk. What is amortised is the transaction, not the
acknowledgement. This is visible in the single-request case: one log
takes about 130ms, because it waits for the flush timer. Under load the
buffer fills in milliseconds and the timer never fires.

**Pre-aggregated rollups.** Described under [Pre-aggregation](#pre-aggregation).
Reduced concurrent aggregation p95 from 2.25s to 883ms, a 2.5× improvement
that took the query from failing the target to meeting it.

### Optimisations tested and rejected

Both were measured and reverted. They are recorded because the negative
results are part of the evidence.

**PostgreSQL memory settings.** `shared_buffers` 128MB → 256MB,
`work_mem` 4MB → 16MB.

| | shared hit | shared read | temp | Execution |
|---|---|---|---|---|
| Default | 769 | 17,300 | none | 1088ms |
| Increased | 135 | 17,940 | 2762r / 2765w | 1252ms |

Slower. Large sequential scans use a small ring buffer by design so they
do not evict the rest of the cache, which means `shared_buffers` does not
help them. The higher `work_mem` shifted the planner to a strategy that
spilled roughly 22MB to temporary files.

**Connection pool size.** 8 → 20 connections.

| Pool | aggregate 1h p95 | ingestion |
|------|------------------|-----------|
| 8 | 2.25s | 7,744/s |
| 20 | 2.02s | 6,222/s |

Aggregation improved by about 10%, within run-to-run variance.
Ingestion dropped 20%. On a database limited to one CPU, additional
connections buy context switching rather than parallelism.

**Rollup refresh interval.** 10s → 60s changed ingestion by 8%, also
within variance, so the refresh job was never the dominant write cost.
60s was kept because it costs nothing: the contract allows 20 seconds
before data must be queryable, and the hybrid read path serves recent
data from raw rows regardless.

## Known limitations

**Ingestion throughput under concurrent query load.** The service sustains
18,242 logs/sec in isolation, above the 15,000 target. With one
aggregation per second running concurrently it sustains approximately
7,038 logs/sec, below it. At that point neither container is CPU-bound,
so the constraint is disk I/O.

This measurement was taken on WSL2, where Docker stores container data in
a virtual disk layered over NTFS. That path is materially slower than
native Linux storage, and the ceiling observed here may not reflect other
hardware. The gap is real and is not claimed to be resolved.

**Aggregation over very wide windows at fine granularity.** A 30-day
window at 1m granularity produces 216,000 groups and takes about 4
seconds on raw data. Rollups reduce the rows scanned but not the group
count. Narrower windows, which are the realistic case, are well inside
target: a 1-day window returns in 32ms idle and 883ms under ingestion.

**Attribute types are not preserved.** Values are normalised to strings at
ingestion, so a log sent with `"retries": 3` is returned as
`"retries": "3"`. This is deliberate — see [Attribute storage](#attribute-storage)
— but it is a visible difference between what is sent and what is read
back.

**Attribute and message filters cannot use rollups.** Queries using
`attr.*` or `q` fall back to scanning raw rows, because those dimensions
are discarded when rows are collapsed into counts and cannot be
pre-aggregated without unbounded cardinality.

**`q` cannot use an index.** Case-insensitive substring matching compiles
to `ILIKE '%value%'`, and a leading wildcard cannot use a B-tree index.
The scan is bounded by whatever the other filters and partition pruning
leave. A trigram index would make it indexable but would add
substantially to write cost on the path that is already the constraint,
so it was not added.

**Timestamps outside the retention window are rejected.** The contract
only constrains future timestamps. Entries older than the partition
window are also rejected, because a row with no matching partition
aborts the entire insert transaction rather than the single row, which
would defeat partial acceptance.

**The ingestion batcher is not unit tested.** Its behaviour is exercised
by the contract smoke test and by load testing, but promise chaining and
timer interaction are not covered by isolated tests.

## Optional features

None are enabled. `docker compose up` with no configuration produces the
plain, unauthenticated core service described in the specification.

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | 8080 | Listening port |
| `DATABASE_URL` | set in compose | PostgreSQL connection string |
| `RETENTION_DAYS` | 30 | Age at which partitions are dropped |
| `LOG_LEVEL` | info | Fastify log verbosity |
| `AUTH_ENABLED` | false | Reserved; no authentication is implemented |
| `LOADGEN_API_KEY` | unset | Reserved; unused while `AUTH_ENABLED` is false |

Authentication, API keys, multi-tenancy, and rate limiting are **not
implemented**. `AUTH_ENABLED` and `LOADGEN_API_KEY` are read by the
configuration loader and validated, but no code consumes them, so setting
them changes nothing. All four required endpoints accept unauthenticated
requests, and an unrecognised `Authorization` header is ignored rather
than rejected.

No rate limit, quota, or tenancy restriction exists.

Pre-aggregated rollup tables are implemented and always on. They are not
optional in the contract sense: they change no endpoint, parameter, or
response shape, and the service produces identical results with or
without them, verified by comparing rollup and raw totals directly.

## Testing

```bash
npm test                      # 44 unit tests
./scripts/contract-test.sh    # 28 API contract checks
```

Unit tests cover validation and query-parameter parsing. Both are pure
functions, so they run without a database or a server.

`contract-test.sh` runs against a live stack and asserts the behaviours
the load generator depends on: all four endpoints, partial acceptance
with indexed rejections, cursor pagination, and the 400 cases for invalid
input.

CI runs both, then builds and starts the full stack with
`docker compose up` and runs the contract test against it. The second
stage is what verifies the deliverable rather than just the unit tests:
it proves the service builds and serves the required API from a clean
checkout.
