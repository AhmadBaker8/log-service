import type { Pool } from "pg";

/**
 * Periodic partition maintenance.
 *
 * Two jobs run together on the same schedule:
 *   - drop partitions older than the retention window
 *   - create partitions ahead of the current date
 *
 * The second matters as much as the first. Partitions are created by the
 * initial migration over a bounded window; without ongoing creation the
 * service would eventually receive a timestamp with no matching
 * partition, which aborts the whole insert transaction rather than the
 * single row.
 */

// Arbitrary but fixed. Concurrent instances contend on the same value so
// only one performs maintenance at a time.
const RETENTION_LOCK_ID = 947_201_554;

// Enough margin to absorb clock skew, the five-minute future tolerance in
// the contract, and a missed run.
const DAYS_AHEAD = 3;

export interface RetentionOptions {
  retentionDays: number;
  intervalMs: number;
}

export const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export class RetentionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: RetentionOptions,
  ) {}

  /**
   * Runs one maintenance pass. Returns the partitions dropped, which the
   * caller logs; returning rather than logging internally keeps this
   * testable without capturing output.
   */
  async runOnce(): Promise<string[]> {
    const client = await this.pool.connect();

    try {
      // Advisory lock rather than a table lock: it is session-scoped,
      // costs nothing when uncontended, and prevents two instances from
      // performing maintenance simultaneously.
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [RETENTION_LOCK_ID],
      );

      // try rather than blocking: if another instance holds the lock the
      // work is already being done, so there is nothing to wait for.
      if (lock.rows[0]?.acquired !== true) {
        return [];
      }

      try {
        await client.query("SELECT ensure_future_log_partitions($1)", [DAYS_AHEAD]);

        const result = await client.query<{ dropped_partition: string }>(
          "SELECT dropped_partition FROM drop_expired_log_partitions($1)",
          [this.options.retentionDays],
        );

        return result.rows.map((row) => row.dropped_partition);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [RETENTION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * `onError` and `onComplete` are injected so this class has no
   * dependency on a logger, keeping it usable in tests.
   */
  start(handlers: {
    onComplete: (dropped: string[]) => void;
    onError: (err: unknown) => void;
  }): void {
    if (this.timer !== null) return;

    const tick = async (): Promise<void> => {
      // Skips rather than queues if the previous pass is still running,
      // so a slow run cannot pile up behind itself.
      if (this.running) return;
      this.running = true;

      try {
        const dropped = await this.runOnce();
        handlers.onComplete(dropped);
      } catch (err) {
        // A failed pass must not stop the schedule: the next run will
        // retry, and partitions accumulating for an hour is recoverable
        // where a stopped job is not.
        handlers.onError(err);
      } finally {
        this.running = false;
      }
    };

    // Runs once at startup so a service that has been down longer than
    // the interval catches up immediately.
    void tick();

    this.timer = setInterval(() => void tick(), this.options.intervalMs);

    // Prevents the interval from holding the process open during shutdown.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
