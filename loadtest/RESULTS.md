# Load Test Results

## Environment
- Host: WSL2 (Ubuntu 26.04), 8 CPU, 7.63 GB
- App container: 0.5 CPU, 256 MB (enforced, cgroup v2)
- Postgres container: 1.0 CPU, 1 GB, postgres:16-alpine
- Generator: k6 v2.1.0, running on the host
- Batch: 100 entries/request, 4 attributes each

## Headline
19,252 logs/sec sustained, p95 196ms, 0 failed requests,
starting from an empty table.

## Methodology note
Early runs were invalid: the volume was not reset between them, so each
run faced a larger table than the last and the decay was misread as a
configuration effect. All results below start from a fresh volume.

## Table size dominates throughput
Identical configuration (batch=100, 20 VUs, 45s):

| Rows at start | logs/sec | p95    |
|---------------|----------|--------|
| 0             | 17,668   | 283ms  |
| ~3.5M         | 9,281    | 598ms  |

Index maintenance cost grows with table size. Four indexes are updated
per inserted row, and as the table grows they no longer fit comfortably
in Postgres's 1 GB.

## Logging overhead: tested, not significant
Both runs on a fresh volume:

| LOG_LEVEL | logs/sec |
|-----------|----------|
| warn      | 17,668   |
| info      | 19,252   |

info measured faster, which is not physically meaningful. The
conclusion is that run-to-run variance (~10%) exceeds the effect.
Logging is not a bottleneck at this scale and was left at info.

## Bottleneck
docker stats during a saturating run:

    log-service-app        49.88% CPU   40.69MiB / 256MiB
    log-service-postgres   81.87% CPU   554.8MiB / 1GiB

Docker reports CPU relative to one core, so 49.88% is full saturation
of a 0.5 CPU allocation. The application is the bottleneck; Postgres
has headroom. Memory is not a constraint at 16% of the app limit.

## Durability
Across five runs totalling 2,571,700 accepted logs, the row count
matched exactly. No batch was acknowledged without being committed.

## Open
Sustained throughput against a pre-populated ~1M row table has not yet
been measured. That is the figure the graded load generator will
produce, and it is expected to sit below the empty-table number.

## Aggregation performance (1,003,400 rows over 30 days)

Data spread across 30 daily partitions, ~33,400 rows/day.

| Window  | Bucket | Rows scanned | Time   |
|---------|--------|--------------|--------|
| 1 day   | 1h     | ~33,000      | 0.032s |
| 2 days  | 1h     | ~67,000      | 0.081s |
| 30 days | 1d     | ~1,003,000   | 1.116s |
| 30 days | 1h     | ~1,003,000   | 1.172s |
| 30 days | 5m     | ~1,003,000   | 1.428s |
| 30 days | 1m     | ~1,003,000   | 4.018s |

Realistic windows are 12-30x inside the 1s target. Partition pruning
limits a 1-day query to a single partition.

The 30-day case exceeds the target. Two costs stack: scanning 1M rows
(~1.3us/row, unavoidable), and group cardinality. At 1m over 30 days
the query produces 43,200 buckets x 5 services = 216,000 groups,
against 3,600 for 1h. That 60x difference explains the jump from 1.17s
to 4.02s.

Remedy would be pre-aggregated rollup tables. Not implemented: the
ingestion path is already CPU-saturated at 49.88% of its 0.5 CPU
allocation, and maintaining rollups on write risks the 15,000 logs/sec
target. Documented as a known limitation instead.

## Rejected optimisation: PostgreSQL memory settings

shared_buffers 128MB -> 256MB, work_mem 4MB -> 16MB.

| Setting   | shared hit | shared read | temp        | Execution |
|-----------|------------|-------------|-------------|-----------|
| Default   | 769        | 17,300      | none        | 1088ms    |
| Increased | 135        | 17,940      | 2762r/2765w | 1252ms    |

Slower. Large sequential scans use a small ring buffer by design so
they do not evict the cache, so shared_buffers does not help them. The
higher work_mem shifted the planner to a strategy that spilled ~22MB to
temporary files. Reverted.

## Ingestion with data spread over 30 days
16,701 logs/sec, p95 202ms, 0 failures, writing across 30 partitions.
Spreading writes over many partitions did not degrade throughput.
