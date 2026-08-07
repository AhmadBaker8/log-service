-- Pre-aggregated minute counts.
--
-- Aggregation queries compete with ingestion for disk I/O: measured at
-- 2.25s p95 under concurrent load against 142ms idle, with PostgreSQL
-- never exceeding 45% CPU. The bottleneck is reading rows whose pages
-- ingestion keeps evicting, so the remedy is to read fewer rows.
--
-- Only service and level are pre-aggregated. Attribute values and
-- message text cannot be: including a single attribute with 100,000
-- distinct values would make the rollup larger than the raw data. Any
-- query filtering on attr.* or q therefore falls back to raw rows.
--
-- 1m is the finest bucket the contract defines, and 5m, 1h, and 1d are
-- whole multiples of it, so all four sizes derive from this one table.
CREATE TABLE log_rollup_1m (
    bucket   TIMESTAMPTZ NOT NULL,
    service  TEXT        NOT NULL,
    level    log_level   NOT NULL,
    count    BIGINT      NOT NULL,
    PRIMARY KEY (bucket, service, level)
) PARTITION BY RANGE (bucket);

CREATE INDEX log_rollup_1m_bucket_idx ON log_rollup_1m (bucket);

CREATE OR REPLACE FUNCTION ensure_rollup_partition(target_date DATE)
RETURNS TEXT AS $$
DECLARE
    partition_name TEXT;
BEGIN
    partition_name := format('log_rollup_1m_%s', to_char(target_date, 'YYYY_MM_DD'));

    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = partition_name AND n.nspname = 'public'
    ) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF log_rollup_1m FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            target_date::timestamptz,
            (target_date + 1)::timestamptz
        );
    END IF;

    RETURN partition_name;
END;
$$ LANGUAGE plpgsql;

-- Single-row table. The boolean primary key with CHECK (id) makes a
-- second row impossible at the schema level rather than by convention.
CREATE TABLE rollup_state (
    id        BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    watermark TIMESTAMPTZ NOT NULL
);

-- Starts at the beginning of retention. The first pass backfills.
INSERT INTO rollup_state (watermark) VALUES (CURRENT_DATE - 35);

-- Aggregates sealed minutes from the watermark forward and advances it.
--
-- lag_seconds keeps the job away from minutes that can still receive
-- writes. Ingestion accepts timestamps up to five minutes in the future
-- and buffers for up to 100ms, so a minute is only safe to summarise
-- once no further rows can land in it. Rolling up the current minute
-- would freeze a partial count below the watermark, and the rows
-- arriving afterwards would never appear in any aggregation.
--
-- max_minutes bounds the work per pass so a large backfill does not
-- hold a long transaction against ingestion.
CREATE OR REPLACE FUNCTION refresh_log_rollups(
    lag_seconds INTEGER,
    max_minutes INTEGER
)
RETURNS TABLE (rows_written BIGINT, new_watermark TIMESTAMPTZ) AS $$
DECLARE
    current_mark TIMESTAMPTZ;
    seal_before  TIMESTAMPTZ;
    window_end   TIMESTAMPTZ;
    written      BIGINT := 0;
    d            DATE;
BEGIN
    SELECT watermark INTO current_mark FROM rollup_state WHERE id;

    -- Truncated to the minute so buckets align with those the query
    -- layer computes.
    seal_before := date_trunc('minute', now() - make_interval(secs => lag_seconds));
    window_end := LEAST(seal_before, current_mark + make_interval(mins => max_minutes));

    IF window_end <= current_mark THEN
        RETURN QUERY SELECT 0::BIGINT, current_mark;
        RETURN;
    END IF;

    FOR d IN
        SELECT generate_series(current_mark::date, window_end::date, '1 day')::date
    LOOP
        PERFORM ensure_rollup_partition(d);
    END LOOP;

    -- ON CONFLICT keeps the pass idempotent: a retry after a failure
    -- overwrites rather than doubling counts.
    WITH aggregated AS (
        SELECT date_trunc('minute', ts) AS bucket,
               service,
               level,
               count(*) AS n
        FROM logs
        WHERE ts >= current_mark AND ts < window_end
        GROUP BY 1, 2, 3
    ), upserted AS (
        INSERT INTO log_rollup_1m (bucket, service, level, count)
        SELECT bucket, service, level, n FROM aggregated
        ON CONFLICT (bucket, service, level)
        DO UPDATE SET count = EXCLUDED.count
        RETURNING 1
    )
    SELECT count(*) INTO written FROM upserted;

    UPDATE rollup_state SET watermark = window_end WHERE id;

    RETURN QUERY SELECT written, window_end;
END;
$$ LANGUAGE plpgsql;

-- Rollup partitions are dropped on the same schedule as log partitions,
-- for the same reason: DROP is a catalog operation, DELETE is not.
CREATE OR REPLACE FUNCTION drop_expired_rollup_partitions(retention_days INTEGER)
RETURNS TABLE (dropped_partition TEXT) AS $$
DECLARE
    cutoff DATE;
    partition_record RECORD;
BEGIN
    cutoff := CURRENT_DATE - retention_days;

    FOR partition_record IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname = 'log_rollup_1m'
          AND c.relkind = 'r'
          AND c.relname ~ '^log_rollup_1m_\d{4}_\d{2}_\d{2}$'
          AND to_date(substring(c.relname FROM 15), 'YYYY_MM_DD') < cutoff
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I', partition_record.relname);
        dropped_partition := partition_record.relname;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
