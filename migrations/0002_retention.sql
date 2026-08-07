-- Drops partitions whose entire range falls before the cutoff.
--
-- DROP TABLE on a partition is a catalog operation: Postgres unlinks the
-- files and updates system tables. Nothing is scanned, no dead tuples are
-- produced, and no index maintenance or vacuum follows. A bulk DELETE of
-- the same rows would leave dead tuples for autovacuum to reclaim,
-- competing with ingestion for the same single CPU, and would leave index
-- pages allocated afterwards.
--
-- Only partitions strictly older than the cutoff are dropped, so the lock
-- taken is never contended: nothing reads or writes data outside the
-- retention window.
CREATE OR REPLACE FUNCTION drop_expired_log_partitions(retention_days INTEGER)
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
        WHERE parent.relname = 'logs'
          AND c.relkind = 'r'
          -- Partition names carry their date: logs_YYYY_MM_DD. Parsing the
          -- name avoids reading pg_get_expr and re-parsing bound syntax.
          AND c.relname ~ '^logs_\d{4}_\d{2}_\d{2}$'
          AND to_date(substring(c.relname FROM 6), 'YYYY_MM_DD') < cutoff
    LOOP
        -- %I quotes and escapes the identifier. The name comes from the
        -- catalog rather than from user input, but the safe form is used
        -- regardless.
        EXECUTE format('DROP TABLE IF EXISTS %I', partition_record.relname);
        dropped_partition := partition_record.relname;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Creates partitions ahead of time so ingestion never encounters a
-- timestamp with no matching partition, which would abort the entire
-- insert transaction and break partial acceptance.
CREATE OR REPLACE FUNCTION ensure_future_log_partitions(days_ahead INTEGER)
RETURNS INTEGER AS $$
DECLARE
    d DATE;
    created INTEGER := 0;
BEGIN
    FOR d IN
        SELECT generate_series(CURRENT_DATE, CURRENT_DATE + days_ahead, '1 day')::date
    LOOP
        PERFORM ensure_log_partition(d);
        created := created + 1;
    END LOOP;

    RETURN created;
END;
$$ LANGUAGE plpgsql;
