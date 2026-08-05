import type { Pool, PoolClient } from "pg";
import type { ValidLogEntry } from "../types/log";
import type { LogQuery } from "../services/queryParams";

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
    query: LogQuery,
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
}