import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

/**
 * Forward-only SQL migration runner.
 *
 * Each migration runs inside a transaction together with the insert
 * that records it as applied, so a failure can never leave a migration
 * marked complete but only partially executed.
 */

// Resolved relative to this file so it works identically from src/ during
// development and from dist/ inside the container. This is why the project
// emits CommonJS: __dirname does not exist under ES modules.
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

// Arbitrary but fixed. Any concurrent runner contends on the same value.
const MIGRATION_LOCK_ID = 947_201_553;

interface AppliedMigration {
  filename: string;
  checksum: string;
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<AppliedMigration>(
    "SELECT filename, checksum FROM schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.filename, row.checksum]));
}

/**
 * Filenames are zero-padded (0001_, 0002_) so a lexicographic sort gives
 * the correct execution order. Without padding, 10_ would sort before 2_.
 */
function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * An already-applied migration whose contents changed means the file and
 * the database have diverged. Refusing to start turns silent schema drift
 * into an obvious failure.
 */
function verifyChecksums(files: string[], applied: Map<string, string>): void {
  for (const file of files) {
    const recorded = applied.get(file);
    if (recorded === undefined) continue;

    const current = checksum(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    if (current !== recorded) {
      throw new Error(
        `Migration ${file} has been modified after it was applied. ` +
          `Create a new migration instead of editing an existing one.`,
      );
    }
  }
}

async function applyMigration(client: PoolClient, file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
      file,
      checksum(sql),
    ]);
    await client.query("COMMIT");
    console.log(`Applied migration: ${file}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Migration failed: ${file}\n${(err as Error).message}`);
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    /**
     * Serialises concurrent startups. Without it, two instances booting
     * together would both see an empty schema_migrations and both try to
     * apply the same file. The second blocks here, then finds nothing to do.
     */
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = getMigrationFiles();

    verifyChecksums(files, applied);

    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log("Migrations up to date.");
      return;
    }

    for (const file of pending) {
      await applyMigration(client, file);
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}