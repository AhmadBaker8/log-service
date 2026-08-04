-- Store and interpret all timestamps in UTC. Partition boundaries are
-- date-based, so a shifting server timezone would silently move them.
ALTER DATABASE logs SET timezone TO 'UTC';

-- Four fixed values defined by the API contract. An enum is 4 bytes,
-- compares as an integer, and rejects invalid input at the database
-- boundary as a second line of defence behind application validation.
CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');

-- CACHE 1000 lets each session claim a block of ids instead of touching
-- the sequence per row, removing a contention point at high insert rates.
-- The cost is gaps after a restart, which is irrelevant for opaque ids.
CREATE SEQUENCE logs_id_seq AS BIGINT CACHE 1000;

CREATE TABLE logs (
    id         BIGINT      NOT NULL DEFAULT nextval('logs_id_seq'),
    ts         TIMESTAMPTZ NOT NULL,
    level      log_level   NOT NULL,
    service    TEXT        NOT NULL,
    message    TEXT        NOT NULL,
    attributes JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- Postgres requires the partition key inside the primary key.
    -- (ts, id) also gives us the deterministic sort the contract
    -- demands: ts alone is not unique at 15k rows/sec, so ties would
    -- order arbitrarily and break cursor pagination.
    PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);

ALTER SEQUENCE logs_id_seq OWNED BY logs.id;

-- Indexes declared on the parent are created on every partition,
-- including ones added later.

-- Filtering by service, still ordered by time.
CREATE INDEX logs_service_ts_id_idx ON logs (service, ts DESC, id DESC);

-- Filtering by level, still ordered by time.
CREATE INDEX logs_level_ts_id_idx ON logs (level, ts DESC, id DESC);

-- jsonb_path_ops indexes hashed key/value paths rather than keys and
-- values separately. It supports only containment (@>), which is the
-- one operation attribute filtering needs, and is roughly 2-3x smaller
-- than the default jsonb_ops. Index size decides whether this stays
-- cached under a 1GB memory limit.
CREATE INDEX logs_attributes_idx ON logs USING GIN (attributes jsonb_path_ops);

-- Creates one daily partition if absent. Idempotent, so it is safe to
-- call before every batch insert.
--
-- format() with %I and %L is how dynamic SQL is built safely: %I quotes
-- and escapes identifiers, %L quotes and escapes literals. String
-- concatenation here would be a SQL injection vector.
CREATE OR REPLACE FUNCTION ensure_log_partition(target_date DATE)
RETURNS TEXT AS $$
DECLARE
    partition_name TEXT;
BEGIN
    partition_name := format('logs_%s', to_char(target_date, 'YYYY_MM_DD'));

    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = partition_name AND n.nspname = 'public'
    ) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            target_date::timestamptz,
            (target_date + 1)::timestamptz
        );
    END IF;

    RETURN partition_name;
END;
$$ LANGUAGE plpgsql;

-- Seed a window around today: 35 days back covers the 30-day retention
-- default with margin, and 2 days forward absorbs clock skew and the
-- 5-minute future tolerance the contract allows.
DO $$
DECLARE d DATE;
BEGIN
    FOR d IN
        SELECT generate_series(CURRENT_DATE - 35, CURRENT_DATE + 2, '1 day')::date
    LOOP
        PERFORM ensure_log_partition(d);
    END LOOP;
END $$;
