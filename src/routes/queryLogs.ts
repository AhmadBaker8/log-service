import type { FastifyInstance } from "fastify";
import { parseLogQuery, encodeCursor } from "../services/queryParams";
import type { LogRepository, LogRow } from "../repositories/logRepository";

/**
 * GET /logs
 *
 * All filters are optional and freely combinable. Results are ordered by
 * timestamp descending, with id as a tiebreaker so ordering stays total
 * when many rows share a timestamp - which is the common case at high
 * ingest rates, and what makes cursor pagination correct.
 */

interface LogResponse {
  id: string;
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, string>;
}

function toResponse(row: LogRow): LogResponse {
  return {
    id: row.id,
    // The column is named ts to avoid colliding with the SQL type name;
    // the contract calls it timestamp, so the mapping happens here.
    timestamp: row.ts.toISOString(),
    level: row.level,
    service: row.service,
    message: row.message,
    attributes: row.attributes,
  };
}

export function registerQueryRoutes(app: FastifyInstance, repository: LogRepository): void {
  app.get("/logs", async (request, reply) => {
    const parsed = parseLogQuery(request.query as Record<string, unknown>);

    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const query = parsed.value;

    try {
      // One row beyond the limit is requested, so the presence of a
      // further page is known without a separate count.
      const rows = await repository.findLogs(query);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;

      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last !== undefined ? encodeCursor({ ts: last.ts, id: last.id }) : null;

      return reply.code(200).send({
        logs: page.map(toResponse),
        next_cursor: nextCursor,
      });
    } catch (err) {
      app.log.error({ err }, "Failed to query logs");
      return reply.code(500).send({ error: "failed to query logs" });
    }
  });
}