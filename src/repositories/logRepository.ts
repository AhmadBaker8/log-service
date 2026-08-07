import type { Pool, PoolClient } from "pg";
import type { ValidLogEntry } from "../types/log";
import type { LogQuery, LogFilters, AggregateQuery } from "../services/queryParams";
import { GROUP_BY_COLUMNS } from "../services/queryParams";
/**
 * All SQL for the logs table lives here. HTTP handlers never build
 * queries, and this module knows nothing about requests or responses.
 */

const COLUMNS_PER_ROW = 5;
export interface LogRow {
  id: string;
  ts: Date;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, string>;
}

export interface AggregateRow {
  bucket_start: Date;
  group_value: string | null;
  count: string;
}

export class LogRepository {
  /**
   * Dates known to have a partition. A row with no matching partition
   * aborts the entire transaction, so this is checked before every
   * write; caching means one extra query per new day rather than per batch.
   */
  private readonly knownPartitionDates = new Set<string>();

  constructor(private readonly pool: Pool) {}

  private static toDateKey(timestamp: Date): string {
    // UTC because the database session runs in UTC and partition
    // boundaries are UTC dates. Using local time here would misroute
    // rows near midnight.
    return timestamp.toISOString().slice(0, 10);
  }

  private async ensurePartitions(client: PoolClient, entries: ValidLogEntry[]): Promise<void> {
    const missing = new Set<string>();

    for (const entry of entries) {
      const key = LogRepository.toDateKey(entry.timestamp);
      if (!this.knownPartitionDates.has(key)) {
        missing.add(key);
      }
    }

    for (const date of missing) {
      await client.query("SELECT ensure_log_partition($1::date)", [date]);
      this.knownPartitionDates.add(date);
    }
  }

  /**
   * Inserts every entry in a single statement inside one transaction.
   *
   * Placeholders are generated from the row count; values are always
   * passed separately as parameters. Interpolating values into the SQL
   * string would be an injection vector.
   */
  async insertBatch(entries: ValidLogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await this.ensurePartitions(client, entries);

      const placeholders: string[] = [];
      const values: unknown[] = [];

      entries.forEach((entry, rowIndex) => {
        const base = rowIndex * COLUMNS_PER_ROW;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
        );
        values.push(
          entry.timestamp,
          entry.level,
          entry.service,
          entry.message,
          JSON.stringify(entry.attributes),
        );
      });

      await client.query(
        `INSERT INTO logs (ts, level, service, message, attributes)
         VALUES ${placeholders.join(", ")}`,
        values,
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Builds the WHERE clause for a filter set.
   *
   * Placeholders are generated from the parameter count; values are
   * always appended to the parameter array and never interpolated into
   * the SQL string. This includes attribute keys, which arrive from the
   * URL and are passed as part of a JSONB parameter rather than as
   * identifiers.
   */
  private static buildFilters(
    query: LogFilters & { since?: Date; until?: Date },
    params: unknown[],
  ): string[] {
    const conditions: string[] = [];

    if (query.since !== undefined) {
      params.push(query.since);
      conditions.push(`ts >= $${params.length}`);
    }
    if (query.until !== undefined) {
      params.push(query.until);
      conditions.push(`ts < $${params.length}`);
    }
    if (query.service !== undefined) {
      params.push(query.service);
      conditions.push(`service = $${params.length}`);
    }
    if (query.level !== undefined) {
      params.push(query.level);
      conditions.push(`level = $${params.length}::log_level`);
    }
    if (query.q !== undefined) {
      // A leading wildcard cannot use a B-tree index, so this scans the
      // rows surviving the other filters. Documented as a known
      // limitation; time bounds keep the scan partition-local.
      params.push(`%${query.q}%`);
      conditions.push(`message ILIKE $${params.length}`);
    }

    const attrKeys = Object.keys(query.attributes);
    if (attrKeys.length > 0) {
      // One containment check covering every requested attribute, which
      // the GIN jsonb_path_ops index can satisfy directly.
      params.push(JSON.stringify(query.attributes));
      conditions.push(`attributes @> $${params.length}::jsonb`);
    }

    return conditions;
  }

  async findLogs(query: LogQuery): Promise<LogRow[]> {
    const params: unknown[] = [];
    const conditions = LogRepository.buildFilters(query, params);

    if (query.cursor !== undefined) {
      // Row-value comparison rather than "ts < a OR (ts = a AND id < b)".
      // The two are logically identical, but this form is optimised into
      // a direct index seek on the (ts, id) primary key.
      params.push(query.cursor.ts, query.cursor.id);
      conditions.push(`(ts, id) < ($${params.length - 1}, $${params.length})`);
    }

    // One extra row reveals whether a further page exists, without a
    // second count query.
    params.push(query.limit + 1);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await this.pool.query<LogRow>(
      `SELECT id::text, ts, level, service, message, attributes
       FROM logs
       ${where}
       ORDER BY ts DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );

    return result.rows;
  }

  /**
   * Buckets are computed by epoch arithmetic rather than date_trunc,
   * because date_trunc has no five-minute unit and the contract requires
   * one. Dividing the epoch by the bucket width and multiplying back
   * handles all four sizes with the width supplied as a parameter.
   *
   * Buckets align to absolute epoch boundaries rather than to `since`,
   * so the same log always falls in the same bucket regardless of the
   * query window. Aligning to `since` would make results from different
   * requests incomparable.
   */
  /**
   * Aggregates using pre-computed rollups where possible.
   *
   * Rollups store only (bucket, service, level), so a query filtering on
   * attributes or message text cannot use them: those dimensions were
   * discarded when the rows were collapsed into counts, and including
   * them would make the rollup larger than the raw data.
   *
   * `watermark` is the timestamp up to which rollups are complete.
   * Everything below it comes from the summary, everything above from
   * raw rows. The two ranges are disjoint by construction, so no row is
   * counted twice and none is missed.
   */
  async aggregateWithRollups(
    query: AggregateQuery,
    watermark: Date,
  ): Promise<AggregateRow[]> {
    const usesRawOnlyFilters =
      query.q !== undefined || Object.keys(query.attributes).length > 0;

    if (usesRawOnlyFilters) {
      return this.aggregateLogs(query);
    }

    const rollupEnd = new Date(Math.min(watermark.getTime(), query.until.getTime()));
    const needsRollup = rollupEnd > query.since;
    const needsRaw = query.until > watermark;

    if (!needsRollup) {
      return this.aggregateLogs(query);
    }

    const groupColumn =
      query.groupBy !== undefined ? GROUP_BY_COLUMNS[query.groupBy] : null;
    const groupSelect = groupColumn !== null ? `${groupColumn}::text` : "NULL::text";
    const groupClause = groupColumn !== null ? `, ${groupColumn}` : "";

    const params: unknown[] = [];

    const rollupConditions: string[] = [];
    params.push(query.since);
    rollupConditions.push(`bucket >= $${params.length}`);
    params.push(rollupEnd);
    rollupConditions.push(`bucket < $${params.length}`);
    if (query.service !== undefined) {
      params.push(query.service);
      rollupConditions.push(`service = $${params.length}`);
    }
    if (query.level !== undefined) {
      params.push(query.level);
      rollupConditions.push(`level = $${params.length}::log_level`);
    }

    params.push(query.bucketSeconds);
    const rollupBucketParam = `$${params.length}`;

    // sum(count) rather than count(*): rollup rows already carry a count.
    let sql = `SELECT to_timestamp(floor(extract(epoch FROM bucket) / ${rollupBucketParam}) * ${rollupBucketParam}) AS bucket_start,
                      ${groupSelect} AS group_value,
                      sum(count) AS subtotal
               FROM log_rollup_1m
               WHERE ${rollupConditions.join(" AND ")}
               GROUP BY bucket_start${groupClause}`;

    if (needsRaw) {
      const rawStart = new Date(Math.max(watermark.getTime(), query.since.getTime()));
      const rawConditions: string[] = [];
      params.push(rawStart);
      rawConditions.push(`ts >= $${params.length}`);
      params.push(query.until);
      rawConditions.push(`ts < $${params.length}`);
      if (query.service !== undefined) {
        params.push(query.service);
        rawConditions.push(`service = $${params.length}`);
      }
      if (query.level !== undefined) {
        params.push(query.level);
        rawConditions.push(`level = $${params.length}::log_level`);
      }

      params.push(query.bucketSeconds);
      const rawBucketParam = `$${params.length}`;

      sql += `
               UNION ALL
               SELECT to_timestamp(floor(extract(epoch FROM ts) / ${rawBucketParam}) * ${rawBucketParam}) AS bucket_start,
                      ${groupSelect} AS group_value,
                      count(*) AS subtotal
               FROM logs
               WHERE ${rawConditions.join(" AND ")}
               GROUP BY bucket_start${groupClause}`;
    }

    // The two sources can contribute to the same output bucket when the
    // watermark falls inside one, so subtotals are summed again.
    const result = await this.pool.query<AggregateRow>(
      `SELECT bucket_start,
              group_value,
              sum(subtotal)::text AS count
       FROM (${sql}) AS combined
       GROUP BY bucket_start, group_value
       ORDER BY bucket_start ASC`,
      params,
    );

    return result.rows;
  }

  async aggregateLogs(query: AggregateQuery): Promise<AggregateRow[]> {
    const params: unknown[] = [];
    const conditions = LogRepository.buildFilters(query, params);

    params.push(query.bucketSeconds);
    const bucketParam = `$${params.length}`;
    const bucketExpr = `to_timestamp(floor(extract(epoch FROM ts) / ${bucketParam}) * ${bucketParam})`;

    // The identifier comes from a constant in queryParams, selected by
    // an allowlist. No URL value reaches the SQL string here.
    const groupColumn =
      query.groupBy !== undefined ? GROUP_BY_COLUMNS[query.groupBy] : null;

    const groupSelect = groupColumn !== null ? `${groupColumn}::text` : "NULL::text";
    const groupClause = groupColumn !== null ? `, ${groupColumn}` : "";

    const result = await this.pool.query<AggregateRow>(
      `SELECT ${bucketExpr} AS bucket_start,
              ${groupSelect} AS group_value,
              count(*)::text AS count
       FROM logs
       WHERE ${conditions.join(" AND ")}
       GROUP BY bucket_start${groupClause}
       ORDER BY bucket_start ASC`,
      params,
    );

    return result.rows;
  }
}