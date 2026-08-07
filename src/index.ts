import { loadConfig } from "./config/env";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { buildApp } from "./app";
import { LogRepository } from "./repositories/logRepository";
import { IngestionBatcher } from "./services/ingestionBatcher";
import { RetentionService, DEFAULT_RETENTION_INTERVAL_MS } from "./services/retentionService";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  // Completes before the server binds a port, so /health can never report
  // ready against an unmigrated database.
  await runMigrations(pool);

  const repository = new LogRepository(pool);
  const batcher = new IngestionBatcher(repository);
  const app = buildApp(pool, batcher, repository);

  const retention = new RetentionService(pool, {
    retentionDays: config.retentionDays,
    intervalMs: DEFAULT_RETENTION_INTERVAL_MS,
  });

  retention.start({
    onComplete: (dropped) => {
      if (dropped.length > 0) {
        app.log.info({ dropped }, "Dropped expired partitions");
      }
    },
    onError: (err) => {
      app.log.error({ err }, "Partition maintenance failed");
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    try {
      // Order matters: stop accepting requests, stop scheduled work,
      // flush what is buffered, then close the pool.
      await app.close();
      retention.stop();
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
  // Walks the cause chain so a wrapped error still reports its root
  // cause, including Postgres error codes attached further down.
  let current: unknown = err;
  while (current instanceof Error) {
    console.error(current.message);
    current = current.cause;
  }
  if (!(err instanceof Error)) {
    console.error(err);
  }
  process.exit(1);
});
