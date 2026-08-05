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
