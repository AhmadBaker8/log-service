import type { FastifyInstance } from "fastify";
import { parseAggregateQuery } from "../services/queryParams";
import type { LogRepository } from "../repositories/logRepository";
import type { RollupService } from "../services/rollupService";

/**
 * GET /logs/aggregate
 *
 * since and until are required because both bounds are what allow
 * partition pruning to eliminate partitions before any rows are read.
 *
 * Where possible the query is served from pre-aggregated minute counts.
 * If the watermark is unavailable the raw path is used instead, so a
 * missing summary degrades performance rather than correctness.
 */
export function registerAggregateRoutes(
  app: FastifyInstance,
  repository: LogRepository,
  rollups: RollupService,
): void {
  app.get("/logs/aggregate", async (request, reply) => {
    const parsed = parseAggregateQuery(request.query as Record<string, unknown>);

    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    try {
      const watermark = await rollups.getWatermark();

      const rows =
        watermark !== null
          ? await repository.aggregateWithRollups(parsed.value, watermark)
          : await repository.aggregateLogs(parsed.value);

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
