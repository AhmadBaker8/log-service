import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerHealthRoute } from "./routes/health";

/**
 * Builds the Fastify instance without starting it.
 *
 * Kept separate from index.ts so tests can construct an app and drive it
 * with app.inject(), exercising real routing and serialisation without
 * binding a port.
 *
 * Dependencies are passed in explicitly rather than resolved from a
 * container, so every wiring decision is visible in the code.
 */
export function buildApp(pool: Pool): FastifyInstance {
  const app = Fastify({
    logger: {
      // Request logging is meaningful overhead at 15k req/s. Configurable
      // so load tests can quantify the cost and lower it if warranted.
      level: process.env.LOG_LEVEL ?? "info",
    },
    // Reject bodies above 4MB. Without a ceiling, a single oversized
    // request could exhaust the 256MB container budget.
    bodyLimit: 4 * 1024 * 1024,
  });

  registerHealthRoute(app, pool);

  // Ingestion, query, and aggregation routes follow in later steps.

  return app;
}