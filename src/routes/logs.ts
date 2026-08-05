import type { FastifyInstance } from "fastify";
import { validateLogEntry } from "../services/validation";
import type { IngestionBatcher } from "../services/ingestionBatcher";
import type { RejectedEntry, ValidLogEntry } from "../types/log";

/**
 * POST /logs
 *
 * Always a batch, even of one. Entries are validated individually so a
 * single bad entry cannot fail the rest, and rejections are returned
 * with their index and reason.
 */

interface IngestRequestBody {
  logs?: unknown;
}

export function registerLogRoutes(app: FastifyInstance, batcher: IngestionBatcher): void {
  app.post<{ Body: IngestRequestBody }>("/logs", async (request, reply) => {
    const body = request.body;

    // Only the top-level shape is rejected outright; per-entry problems
    // are reported individually.
    if (body === null || typeof body !== "object" || !Array.isArray(body.logs)) {
      return reply.code(400).send({ error: "request body must be an object with a 'logs' array" });
    }

    const rawEntries = body.logs;
    if (rawEntries.length === 0) {
      return reply.code(400).send({ error: "'logs' must contain at least one entry" });
    }

    // One clock reading for the whole batch, so entries are judged
    // against the same instant regardless of validation time.
    const now = Date.now();

    const valid: ValidLogEntry[] = [];
    const rejected: RejectedEntry[] = [];

    for (let index = 0; index < rawEntries.length; index++) {
      const result = validateLogEntry(rawEntries[index], now);
      if (result.valid) {
        valid.push(result.entry);
      } else {
        rejected.push({ index, reason: result.reason });
      }
    }

    if (valid.length === 0) {
      return reply.code(400).send({ accepted: 0, rejected });
    }

    try {
      // Resolves only after the transaction containing these rows has
      // committed, so a 200 always means the data is durable.
      await batcher.submit(valid);
      return reply.code(200).send({ accepted: valid.length, rejected });
    } catch (err) {
      app.log.error({ err }, "Failed to persist log batch");
      return reply.code(500).send({ error: "failed to persist logs" });
    }
  });
}