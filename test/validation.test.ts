import { describe, it, expect } from "vitest";
import { validateLogEntry } from "../src/services/validation";

/**
 * A fixed reference time so boundary cases around the five-minute future
 * allowance and the retention window are exact rather than racing the
 * real clock.
 */
const NOW = new Date("2026-08-05T12:00:00.000Z").getTime();
const NOW_ISO = "2026-08-05T12:00:00.000Z";

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: NOW_ISO,
    level: "error",
    service: "checkout",
    message: "payment declined",
    ...overrides,
  };
}

describe("validateLogEntry", () => {
  describe("the entry itself", () => {
    it("accepts a well-formed entry", () => {
      const result = validateLogEntry(validEntry(), NOW);
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      expect(result.entry.service).toBe("checkout");
      expect(result.entry.level).toBe("error");
      expect(result.entry.timestamp.toISOString()).toBe(NOW_ISO);
    });

    it("rejects non-objects, including the null and array traps", () => {
      for (const input of [null, undefined, [], "string", 42, true]) {
        expect(validateLogEntry(input, NOW).valid).toBe(false);
      }
    });
  });

  describe("timestamp", () => {
    it("is required", () => {
      const result = validateLogEntry(validEntry({ timestamp: undefined }), NOW);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.reason).toMatch(/required/);
    });

    it("accepts ISO 8601 with and without milliseconds and offsets", () => {
      for (const ts of [
        "2026-08-05T12:00:00Z",
        "2026-08-05T12:00:00.123Z",
        "2026-08-05T14:00:00+02:00",
      ]) {
        expect(validateLogEntry(validEntry({ timestamp: ts }), NOW).valid).toBe(true);
      }
    });

    it("rejects formats Date would otherwise accept loosely", () => {
      for (const ts of [
        "2026",
        "2026-08-05",
        "08/05/2026",
        "13/45/2026",
        "not a date",
        "",
      ]) {
        expect(validateLogEntry(validEntry({ timestamp: ts }), NOW).valid).toBe(false);
      }
    });

    it("rejects a well-formed but impossible date", () => {
      const result = validateLogEntry(validEntry({ timestamp: "2026-02-30T12:00:00Z" }), NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects non-string timestamps", () => {
      for (const ts of [NOW, new Date(NOW), {}, []]) {
        expect(validateLogEntry(validEntry({ timestamp: ts }), NOW).valid).toBe(false);
      }
    });

    it("allows up to five minutes in the future and rejects beyond it", () => {
      const withinLimit = new Date(NOW + 4 * 60 * 1000).toISOString();
      const pastLimit = new Date(NOW + 6 * 60 * 1000).toISOString();

      expect(validateLogEntry(validEntry({ timestamp: withinLimit }), NOW).valid).toBe(true);

      const rejected = validateLogEntry(validEntry({ timestamp: pastLimit }), NOW);
      expect(rejected.valid).toBe(false);
      if (rejected.valid) return;
      expect(rejected.reason).toMatch(/future/);
    });

    it("accepts past timestamps inside the retention window and rejects older ones", () => {
      const recent = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
      const ancient = new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString();

      expect(validateLogEntry(validEntry({ timestamp: recent }), NOW).valid).toBe(true);
      expect(validateLogEntry(validEntry({ timestamp: ancient }), NOW).valid).toBe(false);
    });
  });

  describe("level", () => {
    it("accepts each of the four contract levels", () => {
      for (const level of ["debug", "info", "warn", "error"]) {
        expect(validateLogEntry(validEntry({ level }), NOW).valid).toBe(true);
      }
    });

    it("rejects unknown levels using the phrasing from the contract", () => {
      const result = validateLogEntry(validEntry({ level: "critical" }), NOW);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.reason).toBe("invalid level: 'critical'");
    });

    it("is case sensitive", () => {
      expect(validateLogEntry(validEntry({ level: "ERROR" }), NOW).valid).toBe(false);
    });

    it("is required", () => {
      expect(validateLogEntry(validEntry({ level: undefined }), NOW).valid).toBe(false);
    });
  });

  describe("service and message", () => {
    it("requires both to be present and non-empty", () => {
      for (const field of ["service", "message"]) {
        expect(validateLogEntry(validEntry({ [field]: undefined }), NOW).valid).toBe(false);
        expect(validateLogEntry(validEntry({ [field]: "" }), NOW).valid).toBe(false);
      }
    });

    it("treats whitespace-only as empty", () => {
      expect(validateLogEntry(validEntry({ service: "   " }), NOW).valid).toBe(false);
      expect(validateLogEntry(validEntry({ message: "\t\n " }), NOW).valid).toBe(false);
    });

    it("rejects non-string values", () => {
      for (const value of [42, true, {}, [], null]) {
        expect(validateLogEntry(validEntry({ service: value }), NOW).valid).toBe(false);
      }
    });

    it("enforces length limits", () => {
      expect(validateLogEntry(validEntry({ service: "a".repeat(255) }), NOW).valid).toBe(true);
      expect(validateLogEntry(validEntry({ service: "a".repeat(256) }), NOW).valid).toBe(false);
      expect(validateLogEntry(validEntry({ message: "a".repeat(8192) }), NOW).valid).toBe(true);
      expect(validateLogEntry(validEntry({ message: "a".repeat(8193) }), NOW).valid).toBe(false);
    });
  });

  describe("attributes", () => {
    it("defaults to an empty object when absent or null", () => {
      for (const value of [undefined, null]) {
        const result = validateLogEntry(validEntry({ attributes: value }), NOW);
        expect(result.valid).toBe(true);
        if (!result.valid) return;
        expect(result.entry.attributes).toEqual({});
      }
    });

    it("normalises every value to its string form", () => {
      const result = validateLogEntry(
        validEntry({
          attributes: { user_id: "42", retries: 3, cached: true, ratio: 1.5 },
        }),
        NOW,
      );
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      // Stored as strings because the contract compares attributes as
      // strings and JSONB containment is type-aware.
      expect(result.entry.attributes).toEqual({
        user_id: "42",
        retries: "3",
        cached: "true",
        ratio: "1.5",
      });
    });

    it("rejects arrays and non-objects", () => {
      for (const value of [[], "string", 42, true]) {
        expect(validateLogEntry(validEntry({ attributes: value }), NOW).valid).toBe(false);
      }
    });

    it("rejects nested objects and arrays as values", () => {
      const nested = validateLogEntry(validEntry({ attributes: { meta: { a: 1 } } }), NOW);
      expect(nested.valid).toBe(false);

      const arrayValue = validateLogEntry(validEntry({ attributes: { tags: ["a"] } }), NOW);
      expect(arrayValue.valid).toBe(false);
    });

    it("rejects null values", () => {
      expect(validateLogEntry(validEntry({ attributes: { x: null } }), NOW).valid).toBe(false);
    });

    it("rejects NaN and Infinity, which are typeof number but not valid JSON", () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const result = validateLogEntry(validEntry({ attributes: { n: value } }), NOW);
        expect(result.valid).toBe(false);
      }
    });

    it("enforces count and length limits", () => {
      const tooMany: Record<string, string> = {};
      for (let i = 0; i < 65; i++) tooMany[`k${i}`] = "v";
      expect(validateLogEntry(validEntry({ attributes: tooMany }), NOW).valid).toBe(false);

      expect(
        validateLogEntry(validEntry({ attributes: { ["k".repeat(129)]: "v" } }), NOW).valid,
      ).toBe(false);

      expect(
        validateLogEntry(validEntry({ attributes: { k: "v".repeat(1025) } }), NOW).valid,
      ).toBe(false);
    });

    it("accepts an empty attributes object", () => {
      const result = validateLogEntry(validEntry({ attributes: {} }), NOW);
      expect(result.valid).toBe(true);
    });
  });
});