#!/bin/bash
set -euo pipefail

# Bun compatibility verification for openclaw gateway.
# Run inside a Vercel Sandbox with openclaw installed.
#
# Usage: bash scripts/bun-verify.sh
#
# Environment:
#   OPENCLAW_GATEWAY_TOKEN — gateway auth token (required, or token file must exist)
#   BUN_VERSION — pinned Bun version (default: 1.3.11)

BUN_VERSION="${BUN_VERSION:-1.3.11}"
BUN_DOWNLOAD_SHA256="${BUN_DOWNLOAD_SHA256:-8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed}"
failures=0
gw_pid=""

cleanup() {
  if [ -n "$gw_pid" ]; then
    kill "$gw_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Install bun if needed (pinned version, hash-verified)
if ! command -v bun &>/dev/null; then
  export PATH="/home/vercel-sandbox/.bun/bin:$PATH"
fi
if ! command -v bun &>/dev/null; then
  BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
  curl -fsSL --max-time 60 --connect-timeout 10 -o /tmp/bun.zip "$BUN_URL"
  printf '%s  /tmp/bun.zip\n' "$BUN_DOWNLOAD_SHA256" | sha256sum -c
  mkdir -p /home/vercel-sandbox/.bun/bin
  unzip -o -j /tmp/bun.zip -d /home/vercel-sandbox/.bun/bin
  chmod +x /home/vercel-sandbox/.bun/bin/bun
  rm -f /tmp/bun.zip
  export PATH="/home/vercel-sandbox/.bun/bin:$PATH"
fi
echo "bun version: $(bun --version)"

export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json

# Read token from file; fail if neither env var nor file is available
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  if [ -f /home/vercel-sandbox/.openclaw/.gateway-token ]; then
    OPENCLAW_GATEWAY_TOKEN="$(cat /home/vercel-sandbox/.openclaw/.gateway-token)"
  else
    echo "ERROR: OPENCLAW_GATEWAY_TOKEN not set and token file not found"
    exit 1
  fi
fi
export OPENCLAW_GATEWAY_TOKEN

# Start gateway with bun
bun /home/vercel-sandbox/.global/npm/bin/openclaw gateway --port 3000 --bind loopback >> /tmp/openclaw.log 2>&1 &
gw_pid=$!

# Wait for ready
ready=0
for i in $(seq 1 120); do
  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q 'openclaw-app'; then
    ready=1
    echo "gateway ready after $i attempts"
    break
  fi
  sleep 0.1
done
if [ "$ready" = "0" ]; then
  echo "FAIL: gateway never became ready"
  tail -20 /tmp/openclaw.log 2>/dev/null || true
  exit 1
fi

echo "=== TEST 1: Homepage serves openclaw-app marker ==="
homepage=$(curl -s http://localhost:3000/)
if echo "$homepage" | grep -q 'openclaw-app'; then
  echo "PASS"
else
  echo "FAIL: missing marker"
  echo "body: ${homepage:0:500}"
  failures=$((failures + 1))
fi

echo "=== TEST 2: /v1/chat/completions endpoint responds ==="
chat_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -d '{"messages":[{"role":"user","content":"say hi"}],"model":"test","stream":false}' 2>/dev/null)
echo "chat status: $chat_status"
if [ "$chat_status" != "000" ]; then
  echo "PASS: endpoint responded"
else
  echo "FAIL: no response"
  failures=$((failures + 1))
fi

echo "=== TEST 3: Force-pair script works under node ==="
if node /home/vercel-sandbox/.openclaw/.force-pair.mjs /home/vercel-sandbox/.openclaw 2>&1; then
  echo "PASS"
  if [ -f /home/vercel-sandbox/.openclaw/devices/paired.json ]; then
    echo "paired.json exists, size: $(wc -c < /home/vercel-sandbox/.openclaw/devices/paired.json) bytes"
  else
    echo "FAIL: paired.json not created"
    failures=$((failures + 1))
  fi
else
  echo "FAIL: force-pair exited non-zero"
  failures=$((failures + 1))
fi

echo "=== TEST 4: Process still alive ==="
if kill -0 "$gw_pid" 2>/dev/null; then
  echo "PASS: pid $gw_pid alive"
else
  echo "FAIL: gateway died"
  failures=$((failures + 1))
fi

echo "=== TEST 5: Log errors ==="
error_lines=$(grep -ci 'panic\|crash\|abort\|segfault\|SIGSEGV' /tmp/openclaw.log 2>/dev/null || echo 0)
echo "Critical error lines: $error_lines"
if [ "$error_lines" = "0" ]; then
  echo "PASS"
else
  grep -i 'panic\|crash\|abort\|segfault\|SIGSEGV' /tmp/openclaw.log | tail -5
  echo "FAIL"
  failures=$((failures + 1))
fi

echo "=== TEST 6: Static assets served ==="
asset_status=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/__openclaw__/canvas/ 2>/dev/null)
echo "canvas status: $asset_status"
if [ "$asset_status" = "200" ] || [ "$asset_status" = "304" ]; then
  echo "PASS"
else
  echo "INFO: canvas status $asset_status (non-critical)"
fi

echo "=== RESULTS: $failures failure(s) ==="
exit "$failures"
