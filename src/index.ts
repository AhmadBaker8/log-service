import { loadConfig } from "./config/env";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  // Migrations complete before the server binds a port, so /health can
  // never report ready against an unmigrated database.
  await runMigrations(pool);

  const app = buildApp(pool);

  /**
   * docker compose down sends SIGTERM and waits before SIGKILL.
   * Draining in-flight requests and closing the pool cleanly avoids
   * severing responses mid-flight.
   */
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // 0.0.0.0, not localhost: binding to loopback inside a container means
  // only the container itself can connect, and the published port
  // reaches nothing.
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});