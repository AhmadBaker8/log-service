import { Pool } from "pg";
import type { AppConfig } from "../config/env";

/**
 * Why a small pool rather than the pg default of 10:
 *
 * PostgreSQL is capped at 1 vCPU in this deployment. Connections beyond
 * a handful do not add parallelism on a single core; they add context
 * switching, plus per-connection memory against a 1GB limit. A larger
 * pool typically makes throughput worse here, not better.
 *
 * 8 is a starting point, not a validated number. It is revisited with
 * real measurements during the load-testing step and documented in the
 * README either way.
 */
const MAX_POOL_SIZE = 8;

export function createPool(config: AppConfig): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: MAX_POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  /**
   * Fires when an idle client errors, typically because the server
   * closed the connection. Without this listener Node treats it as an
   * unhandled error event and terminates the process, which under load
   * would be indistinguishable from a crash.
   */
  pool.on("error", (err) => {
    console.error("Unexpected error on idle PostgreSQL client:", err.message);
  });

  return pool;
}