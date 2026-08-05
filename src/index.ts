import { loadConfig } from "./config/env";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { buildApp } from "./app";
import { LogRepository } from "./repositories/logRepository";
import { IngestionBatcher } from "./services/ingestionBatcher";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  await runMigrations(pool);

  const repository = new LogRepository(pool);
  const batcher = new IngestionBatcher(repository);
  const app = buildApp(pool, batcher, repository);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    try {
      // Order matters: stop accepting requests, flush what is buffered,
      // then close the pool. Reversing this would strand buffered rows.
      await app.close();
      await batcher.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});