import { describe, it, expect } from "vitest";
import {
  parseLogQuery,
  encodeCursor,
  decodeCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../src/services/queryParams";

describe("parseLogQuery", () => {
  it("accepts an empty query and applies the default limit", () => {
    const result = parseLogQuery({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limit).toBe(DEFAULT_LIMIT);
    expect(result.value.attributes).toEqual({});
  });

  it("parses every filter together", () => {
    const result = parseLogQuery({
      service: "checkout",
      level: "error",
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-02T00:00:00Z",
      q: "declined",
      limit: "50",
      "attr.user_id": "42",
      "attr.region": "eu-west",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.service).toBe("checkout");
    expect(result.value.level).toBe("error");
    expect(result.value.q).toBe("declined");
    expect(result.value.limit).toBe(50);
    expect(result.value.attributes).toEqual({ user_id: "42", region: "eu-west" });
  });

  describe("level", () => {
    it("accepts the four contract levels", () => {
      for (const level of ["debug", "info", "warn", "error"]) {
        expect(parseLogQuery({ level }).ok).toBe(true);
      }
    });

    it("rejects anything else, including different casing", () => {
      for (const level of ["critical", "ERROR", "", "trace"]) {
        expect(parseLogQuery({ level }).ok).toBe(false);
      }
    });
  });

  describe("timestamps", () => {
    it("accepts ISO 8601 in several shapes", () => {
      for (const since of [
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00.123Z",
        "2026-08-01T02:00:00+02:00",
        "2026-08-01",
      ]) {
        expect(parseLogQuery({ since }).ok).toBe(true);
      }
    });

    it("rejects malformed timestamps", () => {
      for (const since of ["not-a-date", "08/01/2026", "2026-13-01T00:00:00Z", ""]) {
        expect(parseLogQuery({ since }).ok).toBe(false);
      }
    });

    it("rejects until earlier than since", () => {
      const result = parseLogQuery({
        since: "2026-08-02T00:00:00Z",
        until: "2026-08-01T00:00:00Z",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/until/);
    });

    it("accepts until equal to since", () => {
      expect(
        parseLogQuery({ since: "2026-08-01T00:00:00Z", until: "2026-08-01T00:00:00Z" }).ok,
      ).toBe(true);
    });
  });

  describe("limit", () => {
    it("accepts the boundaries", () => {
      expect(parseLogQuery({ limit: "1" }).ok).toBe(true);
      expect(parseLogQuery({ limit: String(MAX_LIMIT) }).ok).toBe(true);
    });

    it("rejects values outside the range", () => {
      expect(parseLogQuery({ limit: "0" }).ok).toBe(false);
      expect(parseLogQuery({ limit: String(MAX_LIMIT + 1) }).ok).toBe(false);
    });

    it("rejects non-integer forms that Number would otherwise accept", () => {
      for (const limit of ["abc", "1e3", "10.5", "-5", " 10 ", ""]) {
        expect(parseLogQuery({ limit }).ok).toBe(false);
      }
    });
  });

  describe("attributes", () => {
    it("collects every attr-prefixed parameter", () => {
      const result = parseLogQuery({ "attr.a": "1", "attr.b": "2", service: "x" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.attributes).toEqual({ a: "1", b: "2" });
    });

    it("rejects a bare attr. prefix with no key", () => {
      expect(parseLogQuery({ "attr.": "1" }).ok).toBe(false);
    });

    it("keeps values as strings, since the contract compares them as strings", () => {
      const result = parseLogQuery({ "attr.retries": "3" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.attributes.retries).toBe("3");
    });
  });

  it("ignores unknown parameters so optional features can add their own", () => {
    expect(parseLogQuery({ unknown: "x", service: "a" }).ok).toBe(true);
  });

  it("rejects repeated parameters, which arrive as arrays", () => {
    expect(parseLogQuery({ service: ["a", "b"] }).ok).toBe(false);
  });
});

describe("cursors", () => {
  it("round-trips a position", () => {
    const position = { ts: new Date("2026-08-05T12:00:00.000Z"), id: "12345" };
    const decoded = decodeCursor(encodeCursor(position));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.ts.toISOString()).toBe(position.ts.toISOString());
    expect(decoded.value.id).toBe(position.id);
  });

  it("rejects malformed cursors rather than throwing", () => {
    const malformed = [
      "not-base64!!!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from(JSON.stringify({ ts: "x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ts: "2026-08-05T12:00:00Z" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ts: "bad-date", id: "1" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ts: "2026-08-05T12:00:00Z", id: "abc" })).toString("base64url"),
      Buffer.from(JSON.stringify([1, 2])).toString("base64url"),
      "",
    ];

    for (const cursor of malformed) {
      expect(decodeCursor(cursor).ok).toBe(false);
    }
  });

  it("surfaces a malformed cursor as a query error rather than a crash", () => {
    const result = parseLogQuery({ cursor: "garbage!!!" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cursor/);
  });
});
