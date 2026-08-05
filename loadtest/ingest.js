import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

/**
 * Ingestion load test.
 *
 * Configurable via environment variables so one script covers several
 * batch sizes and concurrency levels:
 *   BATCH_SIZE  entries per request      (default 100)
 *   VUS         concurrent virtual users (default 20)
 *   DURATION    steady-state duration    (default 60s)
 *   BASE_URL    target                   (default http://localhost:8080)
 */

const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 100);
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || "60s";
const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

// Counts entries actually accepted rather than requests sent. The target
// is expressed in logs per second, and a request may be partly rejected.
const logsAccepted = new Counter("logs_accepted");
const acceptedPerRequest = new Trend("accepted_per_request");

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

const SERVICES = ["checkout", "auth", "search", "payments", "inventory"];
const LEVELS = ["debug", "info", "warn", "error"];
const REGIONS = ["eu-west", "us-east", "ap-south"];
const MESSAGES = [
  "payment declined",
  "request completed",
  "cache miss",
  "connection reset by peer",
  "user session expired",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildBatch(size) {
  const now = Date.now();
  const logs = new Array(size);

  for (let i = 0; i < size; i++) {
    logs[i] = {
      // Spread over the last hour so rows are not identical, while
      // staying inside a single daily partition.
      timestamp: new Date(now - Math.floor(Math.random() * 3600000)).toISOString(),
      level: pick(LEVELS),
      service: pick(SERVICES),
      message: pick(MESSAGES),
      attributes: {
        user_id: String(Math.floor(Math.random() * 100000)),
        request_id: "req-" + Math.floor(Math.random() * 1000000),
        region: pick(REGIONS),
        retries: Math.floor(Math.random() * 5),
      },
    };
  }

  return { logs: logs };
}

export function setup() {
  const res = http.get(BASE_URL + "/health");
  if (res.status !== 200) {
    throw new Error("Service is not healthy: " + res.status);
  }
  console.log("Starting: batch=" + BATCH_SIZE + " vus=" + VUS + " duration=" + DURATION);
}

export default function () {
  const payload = JSON.stringify(buildBatch(BATCH_SIZE));

  const res = http.post(BASE_URL + "/logs", payload, {
    headers: { "Content-Type": "application/json" },
  });

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
  });

  if (ok) {
    try {
      const body = JSON.parse(res.body);
      logsAccepted.add(body.accepted);
      acceptedPerRequest.add(body.accepted);
    } catch (e) {
      // Unparseable body; the check above already recorded the failure.
    }
  }
}
