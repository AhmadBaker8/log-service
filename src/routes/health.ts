import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

/**
 * GET /health
 *
 * The contract requires healthy to mean: database connected, migrations
 * applied, ready to accept logs.
 *
 * Migrations are guaranteed by ordering rather than checked here. The
 * runner completes before listen() is called, so this route cannot be
 * reached until migrations have succeeded.
 *
 * Connectivity is checked live on every call rather than cached at
 * startup. A cached flag would keep reporting 200 after PostgreSQL
 * became unreachable, which is precisely when the truth matters.
 *
 * SELECT 1 touches no table, so ingestion load cannot slow it down.
 */
export function registerHealthRoute(app: FastifyInstance, pool: Pool): void {
  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return reply.code(200).send({ status: "ok" });
    } catch (err) {
      app.log.error({ err }, "Health check failed: database unreachable");
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}