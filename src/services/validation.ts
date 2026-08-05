import {
  LOG_LEVELS,
  type LogLevel,
  type NormalisedAttributes,
  type ValidLogEntry,
} from "../types/log";

/**
 * Per-entry validation for ingestion.
 *
 * Returns a result rather than throwing: with partial acceptance an
 * invalid entry is an expected outcome, not an exceptional one, and
 * constructing exceptions for a large fraction of a batch is measurably
 * slower than returning data.
 */

export type ValidationResult =
  | { valid: true; entry: ValidLogEntry }
  | { valid: false; reason: string };

/**
 * The contract allows timestamps up to five minutes ahead, which absorbs
 * client clock skew.
 */
const MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * Not in the contract, but required by our storage design: partitions are
 * pre-created over a bounded window, and a row with no matching partition
 * raises an error that would fail an otherwise-valid batch. Documented in
 * the README as an implementation constraint.
 */
const MAX_AGE_DAYS = 35;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Bounds on unbounded input, so one request cannot exhaust 256MB. */
const MAX_SERVICE_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 8192;
const MAX_ATTRIBUTE_COUNT = 64;
const MAX_ATTRIBUTE_KEY_LENGTH = 128;
const MAX_ATTRIBUTE_VALUE_LENGTH = 1024;

/**
 * Date accepts many non-ISO formats, and does so inconsistently across
 * engines. The contract specifies ISO 8601, so the format is checked
 * before parsing.
 */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const VALID_LEVELS = new Set<string>(LOG_LEVELS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // typeof null is "object" and typeof [] is "object", so both need
  // explicit exclusion.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  // Whitespace-only is treated as empty: a service named "   " is
  // meaningless and would pollute group_by results.
  return typeof value === "string" && value.trim().length > 0;
}

function validateTimestamp(value: unknown, now: number): { ok: true; date: Date } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: false, reason: "timestamp is required" };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: "timestamp must be an ISO 8601 string" };
  }
  if (!ISO_8601_PATTERN.test(value)) {
    return { ok: false, reason: `invalid timestamp: '${value}' is not a valid ISO 8601 timestamp` };
  }

  const date = new Date(value);
  // Catches values that match the shape but are not real dates,
  // such as 2026-02-30.
  if (Number.isNaN(date.getTime())) {
    return { ok: false, reason: `invalid timestamp: '${value}' is not a valid date` };
  }

  const elapsed = date.getTime() - now;
  if (elapsed > MAX_FUTURE_MS) {
    return { ok: false, reason: "timestamp is more than 5 minutes in the future" };
  }
  if (-elapsed > MAX_AGE_MS) {
    return { ok: false, reason: `timestamp is older than the ${MAX_AGE_DAYS} day retention window` };
  }

  return { ok: true, date };
}

/**
 * Attribute values are stored as strings because the contract compares
 * them as strings. JSONB containment is type-aware, so a stored number 3
 * would not match a query for "3". Converting once at write time keeps
 * every attribute filter a single indexable containment check.
 */
function normaliseAttributes(
  value: unknown,
): { ok: true; attributes: NormalisedAttributes } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: true, attributes: {} };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: "attributes must be a flat object" };
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_ATTRIBUTE_COUNT) {
    return { ok: false, reason: `attributes exceed the maximum of ${MAX_ATTRIBUTE_COUNT} keys` };
  }

  const attributes: NormalisedAttributes = {};

  for (const [key, raw] of entries) {
    if (key.length === 0 || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
      return { ok: false, reason: `invalid attribute key: '${key}'` };
    }

    if (typeof raw === "string") {
      if (raw.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
        return { ok: false, reason: `attribute '${key}' exceeds the maximum value length` };
      }
      attributes[key] = raw;
    } else if (typeof raw === "number") {
      // NaN and Infinity are typeof "number" but are not representable
      // in JSON; JSON.stringify turns them into null.
      if (!Number.isFinite(raw)) {
        return { ok: false, reason: `attribute '${key}' must be a finite number` };
      }
      attributes[key] = String(raw);
    } else if (typeof raw === "boolean") {
      attributes[key] = String(raw);
    } else {
      return {
        ok: false,
        reason: `attribute '${key}' must be a string, number, or boolean`,
      };
    }
  }

  return { ok: true, attributes };
}

/**
 * `now` is injected rather than read inside, so tests can exercise the
 * future and retention boundaries deterministically.
 */
export function validateLogEntry(raw: unknown, now: number = Date.now()): ValidationResult {
  if (!isPlainObject(raw)) {
    return { valid: false, reason: "log entry must be an object" };
  }

  const timestamp = validateTimestamp(raw.timestamp, now);
  if (!timestamp.ok) {
    return { valid: false, reason: timestamp.reason };
  }

  if (raw.level === undefined || raw.level === null) {
    return { valid: false, reason: "level is required" };
  }
  if (typeof raw.level !== "string" || !VALID_LEVELS.has(raw.level)) {
    return { valid: false, reason: `invalid level: '${String(raw.level)}'` };
  }

  if (!isNonEmptyString(raw.service)) {
    return { valid: false, reason: "service is required and must be a non-empty string" };
  }
  if (raw.service.length > MAX_SERVICE_LENGTH) {
    return { valid: false, reason: `service exceeds the maximum length of ${MAX_SERVICE_LENGTH}` };
  }

  if (!isNonEmptyString(raw.message)) {
    return { valid: false, reason: "message is required and must be a non-empty string" };
  }
  if (raw.message.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, reason: `message exceeds the maximum length of ${MAX_MESSAGE_LENGTH}` };
  }

  const attributes = normaliseAttributes(raw.attributes);
  if (!attributes.ok) {
    return { valid: false, reason: attributes.reason };
  }

  return {
    valid: true,
    entry: {
      timestamp: timestamp.date,
      level: raw.level as LogLevel,
      service: raw.service,
      message: raw.message,
      attributes: attributes.attributes,
    },
  };
}