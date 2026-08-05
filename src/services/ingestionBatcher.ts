import type { ValidLogEntry } from "../types/log";
import type { LogRepository } from "../repositories/logRepository";

/**
 * Coalesces entries from concurrent requests into shared transactions.
 *
 * Transaction overhead - WAL write, fsync, commit bookkeeping - is
 * largely fixed regardless of row count, so committing 2000 rows costs
 * little more than committing 20. Grouping requests amortises that cost
 * across all of them.
 *
 * Durability is not traded away. Each caller's promise resolves only
 * after the transaction containing its rows has committed.
 */

interface PendingWrite {
  entries: ValidLogEntry[];
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface BatcherOptions {
  /** Flush once the buffer reaches this many rows. */
  maxRows: number;
  /** Flush after this long, even if the buffer is not full. */
  intervalMs: number;
}

export const DEFAULT_BATCHER_OPTIONS: BatcherOptions = {
  /**
   * Postgres caps a statement at 65535 parameters. At five columns per
   * row the ceiling is ~13000; 2000 leaves wide margin and bounds the
   * memory a single transaction holds under a 256MB limit.
   */
  maxRows: 2000,
  /**
   * Only matters under light load, when the buffer never fills. The
   * contract allows 20 seconds before data must be queryable, so this
   * is far inside budget and costs nothing at high throughput.
   */
  intervalMs: 100,
};

export class IngestionBatcher {
  private buffer: PendingWrite[] = [];
  private bufferedRows = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly repository: LogRepository,
    private readonly options: BatcherOptions = DEFAULT_BATCHER_OPTIONS,
  ) {}

  /**
   * Resolves once the entries have been committed. Rejects if the
   * transaction containing them failed.
   */
  submit(entries: ValidLogEntry[]): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Batcher is shutting down"));
    }
    if (entries.length === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.buffer.push({ entries, resolve, reject });
      this.bufferedRows += entries.length;

      if (this.bufferedRows >= this.options.maxRows) {
        this.scheduleFlush();
      } else if (this.timer === null) {
        this.timer = setTimeout(() => this.scheduleFlush(), this.options.intervalMs);
      }
    });
  }

  /**
   * Chains flushes so at most one runs at a time. Concurrent
   * transactions would compete for the same single database CPU, and
   * serialising them keeps the write path predictable.
   */
  private scheduleFlush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    this.bufferedRows = 0;

    this.flushing = this.flushing.then(() => this.flush(batch));
  }

  private async flush(batch: PendingWrite[]): Promise<void> {
    const entries = batch.flatMap((write) => write.entries);

    try {
      await this.repository.insertBatch(entries);
      for (const write of batch) write.resolve();
    } catch (err) {
      // Every caller in this transaction is told the write failed.
      // Acknowledging a batch that did not commit would be worse than
      // an error: the client would believe data was stored.
      const error = err instanceof Error ? err : new Error(String(err));
      for (const write of batch) write.reject(error);
    }
  }

  /** Flushes what is buffered and waits for in-flight writes to finish. */
  async close(): Promise<void> {
    this.closed = true;
    this.scheduleFlush();
    await this.flushing;
  }
}