#!/usr/bin/env bash
#
# Verifies the required API contract against a running service.
#
# Checks the behaviours the load generator depends on: the four
# endpoints, partial acceptance with indexed rejections, status codes for
# invalid input, and cursor pagination. Run against a stack started with
# `docker compose up`.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
FAILURES=0

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; echo "        $2"; FAILURES=$((FAILURES + 1)); }

expect_status() {
  local description="$1" expected="$2" actual="$3" body="$4"
  if [ "$actual" = "$expected" ]; then
    pass "$description"
  else
    fail "$description" "expected $expected, got $actual: $body"
  fi
}

expect_contains() {
  local description="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) pass "$description" ;;
    *) fail "$description" "expected to contain '$needle', got: $haystack" ;;
  esac
}

TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

echo "GET /health"
CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/health")
expect_status "returns 200" 200 "$CODE" "$(cat /tmp/body)"

echo
echo "POST /logs"
CODE=$(curl -s -o /tmp/body -w "%{http_code}" -X POST "$BASE_URL/logs" \
  -H "Content-Type: application/json" \
  -d "{\"logs\":[{\"timestamp\":\"$TS\",\"level\":\"error\",\"service\":\"contract-test\",\"message\":\"payment declined\",\"attributes\":{\"user_id\":\"42\",\"retries\":3}}]}")
expect_status "accepts a valid batch" 200 "$CODE" "$(cat /tmp/body)"
expect_contains "reports the accepted count" '"accepted":1' "$(cat /tmp/body)"

# The contract requires an invalid entry not to fail the batch, and each
# rejection to carry its index in the input array.
CODE=$(curl -s -o /tmp/body -w "%{http_code}" -X POST "$BASE_URL/logs" \
  -H "Content-Type: application/json" \
  -d "{\"logs\":[{\"timestamp\":\"$TS\",\"level\":\"info\",\"service\":\"contract-test\",\"message\":\"ok\"},{\"timestamp\":\"$TS\",\"level\":\"critical\",\"service\":\"contract-test\",\"message\":\"bad\"}]}")
expect_status "accepts a partially valid batch" 200 "$CODE" "$(cat /tmp/body)"
expect_contains "counts only the valid entries" '"accepted":1' "$(cat /tmp/body)"
expect_contains "reports the rejected index" '"index":1' "$(cat /tmp/body)"

CODE=$(curl -s -o /tmp/body -w "%{http_code}" -X POST "$BASE_URL/logs" \
  -H "Content-Type: application/json" -d '{"logs":[{"level":"nope"}]}')
expect_status "rejects a fully invalid batch with 400" 400 "$CODE" "$(cat /tmp/body)"

CODE=$(curl -s -o /tmp/body -w "%{http_code}" -X POST "$BASE_URL/logs" \
  -H "Content-Type: application/json" -d '{"logs":[')
expect_status "rejects malformed JSON with 400" 400 "$CODE" "$(cat /tmp/body)"

CODE=$(curl -s -o /tmp/body -w "%{http_code}" -X POST "$BASE_URL/logs" \
  -H "Content-Type: application/json" -d '{"entries":[]}')
expect_status "rejects the wrong top-level shape with 400" 400 "$CODE" "$(cat /tmp/body)"

# Ingestion is buffered and flushed on a timer, so allow it to commit.
sleep 3

echo
echo "GET /logs"
CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/logs?limit=10")
expect_status "returns 200" 200 "$CODE" "$(cat /tmp/body)"
expect_contains "includes a logs array" '"logs":' "$(cat /tmp/body)"
expect_contains "includes next_cursor" '"next_cursor":' "$(cat /tmp/body)"

CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/logs?service=contract-test&level=error&attr.user_id=42&q=declined&limit=5")
expect_status "accepts combined filters" 200 "$CODE" "$(cat /tmp/body)"

for PARAM in "level=critical" "limit=0" "limit=1001" "limit=abc" "cursor=garbage" "since=2026-08-02T00:00:00Z&until=2026-08-01T00:00:00Z"; do
  CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/logs?$PARAM")
  expect_status "rejects $PARAM with 400" 400 "$CODE" "$(cat /tmp/body)"
done

CURSOR=$(curl -s "$BASE_URL/logs?limit=1" | grep -o '"next_cursor":"[^"]*"' | cut -d'"' -f4)
if [ -n "$CURSOR" ]; then
  CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/logs?limit=1&cursor=$CURSOR")
  expect_status "follows a cursor" 200 "$CODE" "$(cat /tmp/body)"
fi

echo
echo "GET /logs/aggregate"
SINCE=$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)
UNTIL=$(date -u -d '1 day' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1d +%Y-%m-%dT%H:%M:%SZ)

CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/logs/aggregate?since=$SINCE&until=$UNTIL&bucket=1h")
expect_status "returns 200" 200 "$CODE" "$(cat /tmp/body)"
expect_contains "includes a buckets array" '"buckets":' "$(cat /tmp/body)"

CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/logs/aggregate?since=$SINCE&until=$UNTIL&bucket=1h&group_by=service")
expect_status "accepts group_by" 200 "$CODE" "$(cat /tmp/body)"

for PARAM in "until=$UNTIL&bucket=1h" "since=$SINCE&bucket=1h" "since=$SINCE&until=$UNTIL" "since=$SINCE&until=$UNTIL&bucket=7m" "since=$SINCE&until=$UNTIL&bucket=1h&group_by=message"; do
  CODE=$(curl -s -o /tmp/body -w "%{http_code}" "$BASE_URL/logs/aggregate?$PARAM")
  expect_status "rejects $PARAM with 400" 400 "$CODE" "$(cat /tmp/body)"
done

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All contract checks passed."
  exit 0
fi

echo "$FAILURES contract check(s) failed."
exit 1
