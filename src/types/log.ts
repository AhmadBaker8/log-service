/**
 * Shared types for log entries.
 *
 * The distinction between a raw entry and a validated one is enforced by
 * the type system: repositories accept only ValidLogEntry, so unvalidated
 * data cannot reach the database without a compile error.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Attribute values after normalisation. See normaliseAttributes. */
export type NormalisedAttributes = Record<string, string>;

/** An entry that has passed every validation rule. */
export interface ValidLogEntry {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: NormalisedAttributes;
}

/** Rejection detail for one entry, as required by the response contract. */
export interface RejectedEntry {
  index: number;
  reason: string;
}