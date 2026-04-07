#!/usr/bin/env node

/**
 * Direct SDK benchmark: create sandbox → install openclaw → snapshot → restore loop.
 *
 * Unlike benchmark-restore.mjs which goes through the app's HTTP API, this
 * script uses the @vercel/sandbox SDK directly to measure raw platform + app
 * bootstrap overhead without any proxy or admin layer.
 *
 * Requires OIDC credentials: run `vercel link && vercel env pull` first.
 *
 * Usage:
 *   node scripts/bench-sandbox-direct.mjs --cycles=5
 *   node scripts/bench-sandbox-direct.mjs --cycles=5 --vcpus=2
 *   node scripts/bench-sandbox-direct.mjs --cycles=5 --vcpus=1,2,4 --skip-bootstrap
 *   node scripts/bench-sandbox-direct.mjs --snapshot-id=snap_abc --cycles=10
 *
 * Environment:
 *   OPENCLAW_PACKAGE_SPEC — package to install (default: openclaw@latest)
 *   VERCEL_OIDC_TOKEN — set automatically by `vercel env pull`
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// .env.local loader (same pattern as .demo/lib/env.ts)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const envPath = resolve(__dirname, "../.env.local");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      let val = trimmed.slice(eq + 1);
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env.local not found — rely on already-set env vars
  }
}

loadEnv();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    cycles: { type: "string", default: "5" },
    vcpus: { type: "string", default: "1" },
    "snapshot-id": { type: "string", default: "" },
    "skip-bootstrap": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "300000" },
    "readiness-timeout": { type: "string", default: "30" },
    format: { type: "string", default: "text" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`bench-sandbox-direct — direct SDK restore benchmark

USAGE
  node scripts/bench-sandbox-direct.mjs [options]

OPTIONS
  --cycles              Restore cycles per vCPU setting (default: 5)
  --vcpus               Comma-separated vCPU values to sweep (default: 1)
  --snapshot-id         Reuse an existing snapshot (skip bootstrap)
  --skip-bootstrap      Skip npm install, just create + snapshot empty sandbox
  --timeout-ms          Sandbox timeout in ms (default: 300000)
  --readiness-timeout   Gateway readiness timeout in seconds (default: 30)
  --format              Output format: text | json (default: text)
  --help                Show this message

ENVIRONMENT
  OPENCLAW_PACKAGE_SPEC — package spec (default: openclaw@latest)
  VERCEL_OIDC_TOKEN     — from \`vercel env pull\`
`);
  process.exit(0);
}

const CYCLES = Number(values.cycles);
const VCPU_LIST = values.vcpus.split(",").map(Number).filter((n) => [1, 2, 4, 8].includes(n));
const TIMEOUT_MS = Number(values["timeout-ms"]);
const READINESS_TIMEOUT = values["readiness-timeout"];
const PACKAGE_SPEC = process.env.OPENCLAW_PACKAGE_SPEC || "openclaw@latest";
const EXISTING_SNAPSHOT_ID = values["snapshot-id"];
const SKIP_BOOTSTRAP = values["skip-bootstrap"] || Boolean(EXISTING_SNAPSHOT_ID);
const FORMAT = values.format;

// Sandbox filesystem paths — must match src/server/openclaw/config.ts.
// These are duplicated here because this .mjs script cannot import TypeScript.
const SANDBOX_PATHS = {
  OPENCLAW_BIN: "/home/vercel-sandbox/.global/npm/bin/openclaw",
  OPENCLAW_STATE_DIR: "/home/vercel-sandbox/.openclaw",
  OPENCLAW_CONFIG_PATH: "/home/vercel-sandbox/.openclaw/openclaw.json",
  OPENCLAW_GATEWAY_TOKEN_PATH: "/home/vercel-sandbox/.openclaw/.gateway-token",
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH: "/home/vercel-sandbox/.openclaw/.force-pair.mjs",
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH: "/home/vercel-sandbox/.openclaw/.fast-restore.sh",
  OPENCLAW_STARTUP_SCRIPT_PATH: "/vercel/sandbox/.on-restore.sh",
  OPENCLAW_LOG_FILE: "/tmp/openclaw.log",
  BUN_BIN: "/home/vercel-sandbox/.bun/bin/bun",
};

if (VCPU_LIST.length === 0) {
  process.stderr.write("ERROR: --vcpus must contain valid values (1, 2, 4, 8)\n");
  process.exit(2);
}

function log(msg) {
  if (FORMAT !== "json") {
    process.stderr.write(`${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// SDK import (lazy so env is loaded first)
// ---------------------------------------------------------------------------

const { Sandbox } = await import("@vercel/sandbox");

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap: create a sandbox, install openclaw, snapshot it
// ---------------------------------------------------------------------------

async function bootstrapAndSnapshot(vcpus) {
  log(`\n--- Bootstrap: creating sandbox (vcpus=${vcpus}) ---`);
  const t0 = Date.now();

  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus },
  });
  const createMs = Date.now() - t0;
  log(`  created sandbox ${sandbox.name} in ${createMs}ms`);

  if (!SKIP_BOOTSTRAP) {
    // Install openclaw
    log(`  installing ${PACKAGE_SPEC}...`);
    const installStart = Date.now();
    const installResult = await sandbox.runCommand("npm", [
      "install", "-g", PACKAGE_SPEC, "--ignore-scripts",
    ]);
    const installMs = Date.now() - installStart;
    if (installResult.exitCode !== 0) {
      const output = await installResult.output("both");
      throw new Error(`npm install failed (${installResult.exitCode}): ${output}`);
    }
    log(`  installed in ${installMs}ms`);

    // Write a minimal config + startup script
    log(`  writing config files...`);
    const gatewayToken = `bench-gw-${Date.now()}`;

    // Minimal gateway config — matches the shape from
    // src/server/openclaw/config.ts buildGatewayConfig()
    const config = JSON.stringify({
      gateway: {
        mode: "local",
        auth: { mode: "token" },
        trustedProxies: ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
        controlUi: { dangerouslyDisableDeviceAuth: true },
        http: { endpoints: { chatCompletions: { enabled: true } } },
      },
    }, null, 2);

    // Minimal startup script that reads token from file and starts gateway
    const startupScript = `#!/bin/bash
set -euo pipefail
gateway_token="$(cat ${SANDBOX_PATHS.OPENCLAW_GATEWAY_TOKEN_PATH})"
export OPENCLAW_CONFIG_PATH="${SANDBOX_PATHS.OPENCLAW_CONFIG_PATH}"
export OPENCLAW_GATEWAY_TOKEN="$gateway_token"
pkill -f "openclaw.gateway" || true
setsid ${SANDBOX_PATHS.OPENCLAW_BIN} gateway --port 3000 --bind loopback >> ${SANDBOX_PATHS.OPENCLAW_LOG_FILE} 2>&1 &
`;

    // Fast-restore script with readiness loop (same as the app uses).
    // Force-pair runs AFTER readiness — gateway serves the initial page
    // without needing device pairing, so we don't block boot on node startup.
    const fastRestoreScript = `#!/bin/bash
set -euo pipefail
gateway_token="$(cat ${SANDBOX_PATHS.OPENCLAW_GATEWAY_TOKEN_PATH})"
export OPENCLAW_CONFIG_PATH="${SANDBOX_PATHS.OPENCLAW_CONFIG_PATH}"
export OPENCLAW_GATEWAY_TOKEN="$gateway_token"
pkill -f "openclaw.gateway" || true
setsid ${SANDBOX_PATHS.OPENCLAW_BIN} gateway --port 3000 --bind loopback >> ${SANDBOX_PATHS.OPENCLAW_LOG_FILE} 2>&1 &
_ready_timeout="\${1:-30}"
_start_epoch=$(date +%s%N 2>/dev/null || echo 0)
_attempts=0
_ready=0
_deadline=$(( $(date +%s) + _ready_timeout ))
while [ "$(date +%s)" -lt "$_deadline" ]; do
  _attempts=$((_attempts + 1))
  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q 'openclaw-app'; then
    _ready=1
    break
  fi
  sleep 0.1
done
_end_epoch=$(date +%s%N 2>/dev/null || echo 0)
_ready_ms=0
if [ "$_start_epoch" != "0" ] && [ "$_end_epoch" != "0" ]; then
  _ready_ms=$(( (_end_epoch - _start_epoch) / 1000000 ))
fi
if [ "$_ready" = "1" ]; then
  node ${SANDBOX_PATHS.OPENCLAW_FORCE_PAIR_SCRIPT_PATH} ${SANDBOX_PATHS.OPENCLAW_STATE_DIR} >> ${SANDBOX_PATHS.OPENCLAW_LOG_FILE} 2>&1 || true
  printf '{"ready":true,"attempts":%d,"readyMs":%d}\\n' "$_attempts" "$_ready_ms"
else
  printf '{"ready":false,"attempts":%d,"readyMs":%d}\\n' "$_attempts" "$_ready_ms"
  exit 1
fi
`;

    await sandbox.writeFiles([
      { path: SANDBOX_PATHS.OPENCLAW_CONFIG_PATH, content: Buffer.from(config) },
      { path: SANDBOX_PATHS.OPENCLAW_GATEWAY_TOKEN_PATH, content: Buffer.from(gatewayToken) },
      { path: SANDBOX_PATHS.OPENCLAW_STARTUP_SCRIPT_PATH, content: Buffer.from(startupScript) },
      { path: SANDBOX_PATHS.OPENCLAW_FAST_RESTORE_SCRIPT_PATH, content: Buffer.from(fastRestoreScript) },
    ]);

    // Make scripts executable
    await sandbox.runCommand("chmod", ["+x", SANDBOX_PATHS.OPENCLAW_STARTUP_SCRIPT_PATH, SANDBOX_PATHS.OPENCLAW_FAST_RESTORE_SCRIPT_PATH]);

    // Run startup and wait for gateway
    log(`  starting gateway...`);
    const startupStart = Date.now();
    const startResult = await sandbox.runCommand("bash", [SANDBOX_PATHS.OPENCLAW_STARTUP_SCRIPT_PATH]);
    if (startResult.exitCode !== 0) {
      const output = await startResult.output("both");
      throw new Error(`Startup failed (${startResult.exitCode}): ${output}`);
    }

    // Poll for readiness (from the host side, for bootstrap only)
    let ready = false;
    for (let i = 0; i < 120; i++) {
      const probe = await sandbox.runCommand("curl", ["-s", "-f", "--max-time", "2", "http://localhost:3000/"]);
      const body = await probe.output();
      if (probe.exitCode === 0 && body.includes("openclaw-app")) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const startupMs = Date.now() - startupStart;

    if (!ready) {
      // Collect diagnostics
      const logTail = await sandbox.runCommand("tail", ["-100", SANDBOX_PATHS.OPENCLAW_LOG_FILE]);
      const logOutput = await logTail.output();
      log(`  --- gateway logs ---\n${logOutput}\n  --- end logs ---`);
      const ps = await sandbox.runCommand("ps", ["aux"]);
      log(`  --- processes ---\n${await ps.output()}\n  --- end processes ---`);
      const probe = await sandbox.runCommand("curl", ["-sS", "http://localhost:3000/"]);
      log(`  --- probe ---\n  exit=${probe.exitCode} body=${(await probe.output()).slice(0, 500)}\n  --- end probe ---`);
      throw new Error("Gateway never became ready during bootstrap");
    }
    log(`  gateway ready in ${startupMs}ms`);
  }

  // Snapshot
  log(`  snapshotting...`);
  const snapStart = Date.now();
  const snap = await sandbox.snapshot();
  const snapMs = Date.now() - snapStart;
  log(`  snapshot ${snap.snapshotId} (${snap.sizeBytes} bytes) in ${snapMs}ms`);

  return {
    snapshotId: snap.snapshotId,
    sizeBytes: snap.sizeBytes,
    bootstrapCreateMs: createMs,
    snapMs,
  };
}

// ---------------------------------------------------------------------------
// Restore benchmark: restore from snapshot, run fast-restore, measure timings
// ---------------------------------------------------------------------------

async function benchmarkRestore(snapshotId, vcpus, cycle) {
  const totalStart = Date.now();

  // Phase 1: Sandbox.create from snapshot
  const createStart = Date.now();
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus },
  });
  const sandboxCreateMs = Date.now() - createStart;

  // Phase 2: Run fast-restore script (gateway start + readiness polling inside sandbox)
  const restoreScriptStart = Date.now();
  const restoreResult = await sandbox.runCommand("bash", [
    SANDBOX_PATHS.OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
    READINESS_TIMEOUT,
  ]);
  const restoreScriptMs = Date.now() - restoreScriptStart;

  let scriptOutput = {};
  if (restoreResult.exitCode === 0) {
    try {
      const stdout = await restoreResult.output("stdout");
      scriptOutput = JSON.parse(stdout.trim());
    } catch {
      scriptOutput = { ready: true, parseError: true };
    }
  } else {
    const output = await restoreResult.output("both");
    scriptOutput = { ready: false, exitCode: restoreResult.exitCode, output: output.slice(0, 500) };
  }

  // Phase 3: External readiness probe (measures true public reachability)
  const publicStart = Date.now();
  let publicReady = false;
  const domain = sandbox.domain(3000);
  for (let i = 0; i < 40; i++) {
    try {
      const resp = await fetch(domain, {
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: `Bearer bench-gateway-token-0` }, // won't match but tests reachability
      });
      if (resp.ok || resp.status === 401) {
        // 401 = gateway is running but token doesn't match (expected)
        publicReady = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const publicReadyMs = Date.now() - publicStart;

  const totalMs = Date.now() - totalStart;

  // Re-snapshot for next cycle
  const snapStart = Date.now();
  const snap = await sandbox.snapshot();
  const reSnapMs = Date.now() - snapStart;

  return {
    cycle,
    vcpus,
    sandboxCreateMs,
    restoreScriptMs,
    scriptOutput,
    publicReadyMs,
    publicReady,
    totalMs,
    reSnapMs,
    nextSnapshotId: snap.snapshotId,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`bench-sandbox-direct`);
  log(`  package: ${PACKAGE_SPEC}`);
  log(`  cycles:  ${CYCLES}`);
  log(`  vcpus:   ${VCPU_LIST.join(",")}`);
  log(`  format:  ${FORMAT}`);

  const results = {};

  for (const vcpus of VCPU_LIST) {
    log(`\n========== vCPU=${vcpus} ==========`);

    // Get or create snapshot
    let snapshotId = EXISTING_SNAPSHOT_ID;
    let bootstrap = null;

    if (!snapshotId) {
      bootstrap = await bootstrapAndSnapshot(vcpus);
      snapshotId = bootstrap.snapshotId;
    } else {
      log(`  using existing snapshot: ${snapshotId}`);
    }

    // Run restore cycles
    const samples = [];
    for (let i = 1; i <= CYCLES; i++) {
      log(`\n  cycle ${i}/${CYCLES} (vcpus=${vcpus})`);
      try {
        const result = await benchmarkRestore(snapshotId, vcpus, i);
        samples.push(result);
        snapshotId = result.nextSnapshotId;

        log(
          `    create=${result.sandboxCreateMs}ms ` +
          `script=${result.restoreScriptMs}ms ` +
          `readyMs=${result.scriptOutput.readyMs ?? "?"}ms ` +
          `attempts=${result.scriptOutput.attempts ?? "?"} ` +
          `public=${result.publicReadyMs}ms ` +
          `total=${result.totalMs}ms`
        );
      } catch (err) {
        log(`    ❌ cycle ${i} failed: ${err.message}`);
        samples.push({
          cycle: i,
          vcpus,
          error: err.message,
          totalMs: Date.now(),
        });
      }
    }

    // Compute stats
    const successSamples = samples.filter((s) => !s.error);
    results[vcpus] = {
      vcpus,
      bootstrap,
      samples,
      summary: successSamples.length > 0 ? {
        sandboxCreateMs: summarize(successSamples.map((s) => s.sandboxCreateMs)),
        restoreScriptMs: summarize(successSamples.map((s) => s.restoreScriptMs)),
        inSandboxReadyMs: summarize(successSamples.map((s) => s.scriptOutput?.readyMs ?? s.restoreScriptMs)),
        publicReadyMs: summarize(successSamples.map((s) => s.publicReadyMs)),
        totalMs: summarize(successSamples.map((s) => s.totalMs)),
        reSnapMs: summarize(successSamples.map((s) => s.reSnapMs)),
        successRate: successSamples.length / samples.length,
      } : null,
    };

    // Print summary for this vCPU
    const s = results[vcpus].summary;
    if (s) {
      log(`\n  --- summary (vcpus=${vcpus}) ---`);
      log(`    sandboxCreate p50=${s.sandboxCreateMs.p50}ms p95=${s.sandboxCreateMs.p95}ms`);
      log(`    restoreScript p50=${s.restoreScriptMs.p50}ms p95=${s.restoreScriptMs.p95}ms`);
      log(`    inSandboxReady p50=${s.inSandboxReadyMs.p50}ms p95=${s.inSandboxReadyMs.p95}ms`);
      log(`    publicReady   p50=${s.publicReadyMs.p50}ms p95=${s.publicReadyMs.p95}ms`);
      log(`    total         p50=${s.totalMs.p50}ms p95=${s.totalMs.p95}ms`);
      log(`    reSnapshot    p50=${s.reSnapMs.p50}ms p95=${s.reSnapMs.p95}ms`);
    }
  }

  // Final report
  const report = {
    schemaVersion: 1,
    packageSpec: PACKAGE_SPEC,
    cycles: CYCLES,
    vcpuList: VCPU_LIST,
    timestamp: new Date().toISOString(),
    results,
  };

  if (FORMAT === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    log(`\n========== FINAL REPORT ==========`);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
