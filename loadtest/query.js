import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

/**
 * Query load, intended to run concurrently with ingest.js.
 *
 * The contract requires one aggregation per second during the ingestion
 * test, with the aggregation returning under one second at p95. Measuring
 * queries against an idle database would not exercise the contention that
 * matters: reads and writes share a single PostgreSQL CPU here.
 *
 *   BASE_URL   target                (default http://localhost:8080)
 *   DURATION   how long to run       (default 60s)
 *   RATE       requests per second   (default 1)
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const DURATION = __ENV.DURATION || "60s";
const RATE = Number(__ENV.RATE || 1);

// Separate trends per query shape, so a slow aggregation is not hidden by
// fast point lookups in a combined percentile.
const aggregate1h = new Trend("q_aggregate_1day_1h", true);
const aggregate5m = new Trend("q_aggregate_1day_5m", true);
const listRecent = new Trend("q_list_recent", true);
const listFiltered = new Trend("q_list_filtered", true);
const listAttr = new Trend("q_list_attribute", true);

export const options = {
  scenarios: {
    query: {
      // constant-arrival-rate holds the request rate steady regardless of
      // response time. A VU-based executor would slow down as latency
      // rose, masking the degradation being measured.
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    q_aggregate_1day_1h: ["p(95)<1000"],
    q_aggregate_1day_5m: ["p(95)<1000"],
    http_req_failed: ["rate<0.01"],
  },
};

const SERVICES = ["checkout", "auth", "search", "payments", "inventory"];

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function timed(url, trend, name) {
  const res = http.get(url, { tags: { name: name } });
  trend.add(res.timings.duration);
  check(res, { [`${name} is 200`]: (r) => r.status === 200 });
  return res;
}

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`Service is not healthy: ${res.status}`);
  }
}

export default function () {
  const since = isoDaysAgo(1);
  const until = isoDaysAgo(0);
  const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];

  // The primary aggregation: one day, hourly buckets, grouped.
  timed(
    `${BASE_URL}/logs/aggregate?since=${since}&until=${until}&bucket=1h&group_by=service`,
    aggregate1h,
    "aggregate_1h",
  );

  // Same window at finer granularity, which produces 12x the groups.
  timed(
    `${BASE_URL}/logs/aggregate?since=${since}&until=${until}&bucket=5m&group_by=level`,
    aggregate5m,
    "aggregate_5m",
  );

  timed(`${BASE_URL}/logs?limit=100`, listRecent, "list_recent");

  timed(
    `${BASE_URL}/logs?service=${service}&level=error&limit=100`,
    listFiltered,
    "list_filtered",
  );

  // Exercises the GIN jsonb_path_ops index.
  timed(
    `${BASE_URL}/logs?attr.region=eu-west&limit=100`,
    listAttr,
    "list_attribute",
  );
}
