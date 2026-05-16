#!/usr/bin/env bash
# Smoke test for production routing — checks SPA routes resolve and API routes stay protected.
# Usage: ./scripts/smoke-test.sh           (tests production)
#        ./scripts/smoke-test.sh local     (tests localhost:3000)

set -u

BASE="https://tusharjayanti.io"
if [ "${1:-}" = "local" ]; then
  BASE="http://localhost:3000"
fi

# Use absolute path to curl — PATH is unreliable in some shell sessions
CURL=/usr/bin/curl
if [ ! -x "$CURL" ]; then
  CURL=$(command -v curl) || { echo "curl not found"; exit 1; }
fi

echo "Smoke testing: $BASE"
echo "----------------------------------------"

# SPA routes — expect 200 (rewrite serves index.html)
for path in /terminal /cv /privacy; do
  code=$("$CURL" -s -o /dev/null -w "%{http_code}" "$BASE$path")
  if [ "$code" = "200" ]; then
    echo "  PASS  $path → $code"
  else
    echo "  FAIL  $path → $code  (expected 200)"
  fi
done

# API routes — expect non-200 (protected / method-specific), NOT app HTML
for path in /api/cron/digest; do
  code=$("$CURL" -s -o /dev/null -w "%{http_code}" "$BASE$path")
  if [ "$code" != "200" ]; then
    echo "  PASS  $path → $code  (correctly not rewritten)"
  else
    echo "  FAIL  $path → $code  (rewrite caught an API route)"
  fi
done

echo "----------------------------------------"
