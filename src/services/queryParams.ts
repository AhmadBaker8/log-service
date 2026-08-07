import { LOG_LEVELS, type LogLevel } from "../types/log";

/**
 * Parsing and validation for query-string parameters.
 *
 * Kept separate from both the route and the repository: the route deals
 * in HTTP, the repository in SQL, and this module turns untrusted
 * strings into a validated, typed shape that neither has to re-check.
 */

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

export interface CursorPosition {
  ts: Date;
  id: string;
}

export interface LogFilters {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  attributes: Record<string, string>;
  q?: string;
}

export interface LogQuery extends LogFilters {
  limit: number;
  cursor?: CursorPosition;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const VALID_LEVELS = new Set<string>(LOG_LEVELS);

const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$/;

function parseTimestamp(raw: string, name: string): ParseResult<Date> {
  if (!ISO_8601_PATTERN.test(raw)) {
    return { ok: false, error: `invalid ${name}: '${raw}' is not a valid ISO 8601 timestamp` };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: `invalid ${name}: '${raw}' is not a valid date` };
  }
  return { ok: true, value: date };
}

/**
 * Cursors are base64 JSON rather than a signed token. A cursor encodes
 * only a position in a public result set, so forging one yields a page
 * the caller could already request via since/until. No privilege is
 * carried, so signing would add cost without adding safety.
 *
 * It must still be validated: the contract requires 400 for a malformed
 * cursor, and unvalidated input reaching the query builder would be far
 * worse than a rejected request.
 */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ ts: position.ts.toISOString(), id: position.id })).toString(
    "base64url",
  );
}

export function decodeCursor(raw: string): ParseResult<CursorPosition> {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(decoded);

    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, error: "invalid cursor" };
    }

    const { ts, id } = parsed as Record<string, unknown>;
    if (typeof ts !== "string" || typeof id !== "string") {
      return { ok: false, error: "invalid cursor" };
    }

    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, error: "invalid cursor" };
    }

    // ids are generated from a bigint sequence; anything else is forged
    // or corrupt.
    if (!/^\d+$/.test(id)) {
      return { ok: false, error: "invalid cursor" };
    }

    return { ok: true, value: { ts: date, id } };
  } catch {
    return { ok: false, error: "invalid cursor" };
  }
}

export function parseLogQuery(raw: Record<string, unknown>): ParseResult<LogQuery> {
  const attributes: Record<string, string> = {};
  let service: string | undefined;
  let level: LogLevel | undefined;
  let since: Date | undefined;
  let until: Date | undefined;
  let q: string | undefined;
  let limit = DEFAULT_LIMIT;
  let cursor: CursorPosition | undefined;

  for (const [key, value] of Object.entries(raw)) {
    // Repeated parameters arrive as arrays; the contract defines each as
    // a single value, so this is a client error rather than something to
    // silently resolve.
    if (typeof value !== "string") {
      return { ok: false, error: `parameter '${key}' must be a single value` };
    }

    if (key.startsWith("attr.")) {
      const attrKey = key.slice(5);
      if (attrKey.length === 0) {
        return { ok: false, error: "attribute filter requires a key after 'attr.'" };
      }
      attributes[attrKey] = value;
      continue;
    }

    switch (key) {
      case "service": {
        if (value.length === 0) {
          return { ok: false, error: "service must not be empty" };
        }
        service = value;
        break;
      }
      case "level": {
        if (!VALID_LEVELS.has(value)) {
          return { ok: false, error: `invalid level: '${value}'` };
        }
        level = value as LogLevel;
        break;
      }
      case "since": {
        const parsed = parseTimestamp(value, "since");
        if (!parsed.ok) return parsed;
        since = parsed.value;
        break;
      }
      case "until": {
        const parsed = parseTimestamp(value, "until");
        if (!parsed.ok) return parsed;
        until = parsed.value;
        break;
      }
      case "q": {
        if (value.length === 0) {
          return { ok: false, error: "q must not be empty" };
        }
        q = value;
        break;
      }
      case "limit": {
        // Number() accepts "1e3" and " 5 "; the contract asks for an
        // integer, so the format is checked before conversion.
        if (!/^\d+$/.test(value)) {
          return { ok: false, error: `invalid limit: '${value}' is not a number` };
        }
        const parsed = Number(value);
        if (parsed < 1 || parsed > MAX_LIMIT) {
          return { ok: false, error: `limit must be between 1 and ${MAX_LIMIT}` };
        }
        limit = parsed;
        break;
      }
      case "cursor": {
        const parsed = decodeCursor(value);
        if (!parsed.ok) return parsed;
        cursor = parsed.value;
        break;
      }
      default:
        // Unknown parameters are ignored rather than rejected, so that
        // optional features can add parameters without breaking clients
        // that do not know about them.
        break;
    }
  }

  if (since !== undefined && until !== undefined && until.getTime() < since.getTime()) {
    return { ok: false, error: "until must not be earlier than since" };
  }

  const query: LogQuery = { attributes, limit };
  if (service !== undefined) query.service = service;
  if (level !== undefined) query.level = level;
  if (since !== undefined) query.since = since;
  if (until !== undefined) query.until = until;
  if (q !== undefined) query.q = q;
  if (cursor !== undefined) query.cursor = cursor;

  return { ok: true, value: query };
}

/**
 * Bucket sizes from the contract, mapped to widths in seconds. The
 * width is passed as a query parameter, so bucket size never reaches
 * the SQL string.
 */
export const BUCKET_SECONDS = {
  "1m": 60,
  "5m": 300,
  "1h": 3600,
  "1d": 86400,
} as const;

export type BucketSize = keyof typeof BUCKET_SECONDS;

/**
 * group_by names a column, and placeholders cannot substitute
 * identifiers. An allowlist maps the request value to a constant
 * defined here, so the identifier reaching the SQL string always
 * originates in this file rather than in the URL.
 */
export const GROUP_BY_COLUMNS = {
  service: "service",
  level: "level",
} as const;

export type GroupByField = keyof typeof GROUP_BY_COLUMNS;

export interface AggregateQuery extends LogFilters {
  since: Date;
  until: Date;
  bucketSeconds: number;
  groupBy?: GroupByField;
}

export function parseAggregateQuery(
  raw: Record<string, unknown>,
): ParseResult<AggregateQuery> {
  // Filter parsing is shared with GET /logs, so the two endpoints cannot
  // diverge in how they interpret service, level, q, or attributes.
  const base = parseLogQuery(raw);
  if (!base.ok) return base;

  const { since, until } = base.value;

  if (since === undefined) {
    return { ok: false, error: "since is required" };
  }
  if (until === undefined) {
    return { ok: false, error: "until is required" };
  }

  const bucket = raw.bucket;
  if (typeof bucket !== "string" || bucket.length === 0) {
    return { ok: false, error: "bucket is required" };
  }
  if (!(bucket in BUCKET_SECONDS)) {
    return {
      ok: false,
      error: `invalid bucket: '${bucket}' must be one of 1m, 5m, 1h, 1d`,
    };
  }

  let groupBy: GroupByField | undefined;
  const rawGroupBy = raw.group_by;
  if (rawGroupBy !== undefined) {
    if (typeof rawGroupBy !== "string" || !(rawGroupBy in GROUP_BY_COLUMNS)) {
      return {
        ok: false,
        error: `invalid group_by: '${String(rawGroupBy)}' must be one of service, level`,
      };
    }
    groupBy = rawGroupBy as GroupByField;
  }

  const query: AggregateQuery = {
    since,
    until,
    bucketSeconds: BUCKET_SECONDS[bucket as BucketSize],
    attributes: base.value.attributes,
  };

  if (base.value.service !== undefined) query.service = base.value.service;
  if (base.value.level !== undefined) query.level = base.value.level;
  if (base.value.q !== undefined) query.q = base.value.q;
  if (groupBy !== undefined) query.groupBy = groupBy;

  return { ok: true, value: query };
}