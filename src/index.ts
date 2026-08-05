import { loadConfig } from "./config/env";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";

/**
 * Temporary entrypoint. Loads configuration and applies migrations.
 * Replaced with the real server bootstrap once the HTTP layer exists.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  try {
    await runMigrations(pool);
    console.log("Database ready.");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  // Non-zero exit is how Docker distinguishes a failed start from a
  // successful one, so a broken schema stops the container rather than
  // letting it serve traffic against the wrong database.
  process.exit(1);
});