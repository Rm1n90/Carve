#!/usr/bin/env bash
# End-to-end smoke test: register, login, /me, refresh, /admin/ping.
set -euo pipefail

API="${API:-http://localhost:8000}"
EMAIL="smoke-$(date +%s)@example.com"
PASS="hunter22-smoke"

echo ">>> health"
curl -fsS "$API/health" | jq

echo ">>> register"
curl -fsS -X POST "$API/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | jq

echo ">>> login"
TOK=$(curl -fsS -X POST "$API/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
ACCESS=$(echo "$TOK" | jq -r .access_token)
REFRESH=$(echo "$TOK" | jq -r .refresh_token)

echo ">>> /auth/me"
curl -fsS "$API/auth/me" -H "Authorization: Bearer $ACCESS" | jq

echo ">>> /auth/refresh"
NEW=$(curl -fsS -X POST "$API/auth/refresh" \
  -H 'content-type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}" | jq -r .access_token)
echo "new access token starts with: ${NEW:0:20}..."

echo ">>> /admin/ping"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$API/admin/ping" \
  -H "Authorization: Bearer $ACCESS")
echo "got $HTTP"
# First registered user becomes admin → expect 200. If you've already registered
# a different first user before running this script, the smoke user is a member
# and will receive 403; in that case uncomment the second branch below.
[ "$HTTP" = "200" ] || { echo "FAIL: expected 200 from /admin/ping, got $HTTP"; exit 1; }

echo ">>> done"
