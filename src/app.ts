import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerHealthRoute } from "./routes/health";
import { registerLogRoutes } from "./routes/logs";
import { registerQueryRoutes } from "./routes/queryLogs";
import type { IngestionBatcher } from "./services/ingestionBatcher";
import type { LogRepository } from "./repositories/logRepository";
import type { RollupService } from "./services/rollupService";
import { registerAggregateRoutes } from "./routes/aggregate";

export function buildApp(
  pool: Pool,
  batcher: IngestionBatcher,
  repository: LogRepository,
  rollups: RollupService,
): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 4 * 1024 * 1024,
  });

  registerHealthRoute(app, pool);
  registerLogRoutes(app, batcher);
  registerQueryRoutes(app, repository);
  registerAggregateRoutes(app, repository, rollups);

  return app;
}