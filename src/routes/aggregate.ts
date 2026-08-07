import type { FastifyInstance } from "fastify";
import { parseAggregateQuery } from "../services/queryParams";
import type { LogRepository } from "../repositories/logRepository";

/**
 * GET /logs/aggregate
 *
 * since and until are required rather than optional because both bounds
 * are what allow partition pruning to eliminate irrelevant partitions
 * before any rows are read. An open-ended range would scan the whole
 * table.
 */
export function registerAggregateRoutes(
  app: FastifyInstance,
  repository: LogRepository,
): void {
  app.get("/logs/aggregate", async (request, reply) => {
    const parsed = parseAggregateQuery(request.query as Record<string, unknown>);

    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    try {
      const rows = await repository.aggregateLogs(parsed.value);

      return reply.code(200).send({
        buckets: rows.map((row) => ({
          start: row.bucket_start.toISOString(),
          group: row.group_value,
          count: Number(row.count),
        })),
      });
    } catch (err) {
      app.log.error({ err }, "Failed to aggregate logs");
      return reply.code(500).send({ error: "failed to aggregate logs" });
    }
  });
}