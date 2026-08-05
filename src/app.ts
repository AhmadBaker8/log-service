import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerHealthRoute } from "./routes/health";
import { registerLogRoutes } from "./routes/logs";
import type { IngestionBatcher } from "./services/ingestionBatcher";

export function buildApp(pool: Pool, batcher: IngestionBatcher): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 4 * 1024 * 1024,
  });

  registerHealthRoute(app, pool);
  registerLogRoutes(app, batcher);

  return app;
}