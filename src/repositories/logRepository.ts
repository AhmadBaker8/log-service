import type { Pool, PoolClient } from "pg";
import type { ValidLogEntry } from "../types/log";

/**
 * All SQL for the logs table lives here. HTTP handlers never build
 * queries, and this module knows nothing about requests or responses.
 */

const COLUMNS_PER_ROW = 5;

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
}