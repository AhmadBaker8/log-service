import type { Pool } from "pg";

/**
 * Maintains pre-aggregated minute counts in the background.
 *
 * Maintenance is deliberately asynchronous. Updating rollups inside the
 * ingestion transaction would add an upsert per group to every flush, on
 * a write path already measured at 7,744 logs/sec under concurrent load.
 * The contract allows 20 seconds before data must be queryable, which is
 * ample room for a lagging summary.
 *
 * The cost of that choice is staleness, handled by the query layer: a
 * watermark records how far rollups are complete, and ranges above it are
 * served from raw rows.
 */

const ROLLUP_LOCK_ID = 947_201_555;

export interface RollupOptions {
  /**
   * How far behind now() to stop. A minute is only safe to summarise once
   * no further rows can land in it; ingestion accepts timestamps up to
   * five minutes ahead, so the default clears that window.
   */
  lagSeconds: number;
  /** Bounds work per pass so a backfill cannot hold a long transaction. */
  maxMinutesPerPass: number;
  intervalMs: number;
}

export const DEFAULT_ROLLUP_OPTIONS: RollupOptions = {
  lagSeconds: 360,
  maxMinutesPerPass: 240,
  intervalMs: 60_000,
};

export interface RollupResult {
  rowsWritten: number;
  watermark: Date;
}

export class RollupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: RollupOptions = DEFAULT_ROLLUP_OPTIONS,
  ) {}

  async runOnce(): Promise<RollupResult | null> {
    const client = await this.pool.connect();

    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [ROLLUP_LOCK_ID],
      );

      // If another instance holds the lock the work is already happening,
      // so there is nothing to wait for.
      if (lock.rows[0]?.acquired !== true) {
        return null;
      }

      try {
        const result = await client.query<{ rows_written: string; new_watermark: Date }>(
          "SELECT rows_written, new_watermark FROM refresh_log_rollups($1, $2)",
          [this.options.lagSeconds, this.options.maxMinutesPerPass],
        );

        const row = result.rows[0];
        if (row === undefined) return null;

        return {
          rowsWritten: Number(row.rows_written),
          watermark: row.new_watermark,
        };
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [ROLLUP_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }

  /** Read by the query layer to decide which source a range can use. */
  async getWatermark(): Promise<Date | null> {
    const result = await this.pool.query<{ watermark: Date }>(
      "SELECT watermark FROM rollup_state WHERE id",
    );
    return result.rows[0]?.watermark ?? null;
  }

  start(handlers: {
    onComplete: (result: RollupResult | null) => void;
    onError: (err: unknown) => void;
  }): void {
    if (this.timer !== null) return;

    const tick = async (): Promise<void> => {
      // Skips rather than queues, so a slow pass cannot pile up.
      if (this.running) return;
      this.running = true;

      try {
        handlers.onComplete(await this.runOnce());
      } catch (err) {
        // A failed pass must not stop the schedule. The watermark is only
        // advanced on success, so the next pass retries the same range.
        handlers.onError(err);
      } finally {
        this.running = false;
      }
    };

    void tick();
    this.timer = setInterval(() => void tick(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
