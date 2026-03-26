import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeGatewayConfigHash } from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import {
  runRestoreOracleCycle,
  type RestoreOracleDeps,
} from "@/server/sandbox/restore-oracle";
import type { PrepareRestoreResult } from "@/server/sandbox/lifecycle";
import { createDefaultMeta, type SingleMeta } from "@/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseMeta(overrides: Partial<SingleMeta> = {}): SingleMeta {
  const base = createDefaultMeta(1_000_000, "gw-token");
  return {
    ...base,
    status: "running",
    sandboxId: "sbx_123",
    snapshotId: "snap_old",
    lastAccessedAt: 0,
    snapshotDynamicConfigHash: "stale-snapshot-hash",
    runtimeDynamicConfigHash: "fresh-runtime-hash",
    snapshotAssetSha256: "stale-asset-hash",
    runtimeAssetSha256: "fresh-runtime-asset-hash",
    restorePreparedStatus: "dirty",
    restorePreparedReason: "dynamic-config-changed",
    restorePreparedAt: null,
    restoreOracle: {
      status: "idle",
      pendingReason: "dynamic-config-changed",
      lastEvaluatedAt: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastBlockedReason: null,
      lastError: null,
      consecutiveFailures: 0,
      lastResult: null,
    },
    ...overrides,
  };
}

function buildDeps(
  meta: SingleMeta,
  overrides: Partial<RestoreOracleDeps> = {},
): { deps: RestoreOracleDeps; getMeta: () => SingleMeta } {
  let current = meta;

  const deps: RestoreOracleDeps = {
    getMeta: async () => current,
    mutate: async (fn) => {
      const draft = structuredClone(current);
      const result = fn(draft);
      current = (result ?? draft) as SingleMeta;
      return current;
    },
    probe: async () => ({ ready: true }),
    prepare: async () => {
      throw new Error("prepare should not run");
    },
    now: () => 1_000_000,
    ...overrides,
  };

  return { deps, getMeta: () => current };
}

const successPrepare: PrepareRestoreResult = {
  ok: true,
  destructive: true,
  state: "ready",
  reason: "prepared",
  snapshotId: "snap_new",
  snapshotDynamicConfigHash: "new-hash",
  runtimeDynamicConfigHash: "new-hash",
  snapshotAssetSha256: "new-asset-hash",
  runtimeAssetSha256: "new-asset-hash",
  preparedAt: 1_000_000,
  actions: [],
};

const failedPrepare: PrepareRestoreResult = {
  ok: false,
  destructive: true,
  state: "failed",
  reason: "prepare-failed",
  snapshotId: null,
  snapshotDynamicConfigHash: null,
  runtimeDynamicConfigHash: null,
  snapshotAssetSha256: null,
  runtimeAssetSha256: null,
  preparedAt: null,
  actions: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRestoreOracleCycle", () => {
  test("skips when restore target is already reusable", async () => {
    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    const meta = baseMeta({
      snapshotDynamicConfigHash: desiredConfigHash,
      runtimeDynamicConfigHash: desiredConfigHash,
      snapshotAssetSha256: desiredAssetSha256,
      runtimeAssetSha256: desiredAssetSha256,
      restorePreparedStatus: "ready",
      restorePreparedReason: "prepared",
    });

    const { deps, getMeta } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "already-ready");
    assert.equal(result.attestation.reusable, true);
    assert.equal(result.prepare, null);
    assert.equal(getMeta().restoreOracle.status, "ready");
    assert.equal(getMeta().restoreOracle.lastResult, "already-ready");
  });

  test("blocks when sandbox was active too recently", async () => {
    const meta = baseMeta({
      lastAccessedAt: 990_000,
    });

    const { deps, getMeta } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      {
        origin: "https://app.example.com",
        reason: "test",
        minIdleMs: 30_000,
      },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "sandbox-recently-active");
    assert.equal(result.idleMs, 10_000);
    assert.equal(result.minIdleMs, 30_000);
    assert.equal(getMeta().restoreOracle.status, "blocked");
    assert.equal(getMeta().restoreOracle.lastResult, "blocked");
    assert.ok(
      getMeta().restoreOracle.lastBlockedReason?.includes("10000ms ago"),
    );
  });

  test("blocks when sandbox is not running", async () => {
    const meta = baseMeta({
      status: "stopped",
      sandboxId: null,
    });

    const { deps, getMeta } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "sandbox-not-running");
    assert.equal(getMeta().restoreOracle.status, "blocked");
  });

  test("blocks when oracle is already running", async () => {
    const meta = baseMeta({
      restoreOracle: {
        status: "running",
        pendingReason: "dynamic-config-changed",
        lastEvaluatedAt: 500_000,
        lastStartedAt: 500_000,
        lastCompletedAt: null,
        lastBlockedReason: null,
        lastError: null,
        consecutiveFailures: 0,
        lastResult: null,
      },
    });

    const { deps } = buildDeps(meta);

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "already-running");
  });

  test("blocks when gateway probe fails", async () => {
    const meta = baseMeta();

    const { deps, getMeta } = buildDeps(meta, {
      probe: async () => ({ ready: false, error: "Connection refused" }),
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "gateway-not-ready");
    assert.equal(getMeta().restoreOracle.status, "blocked");
    assert.equal(
      getMeta().restoreOracle.lastBlockedReason,
      "Connection refused",
    );
  });

  test("executes prepare when sandbox is running, idle, dirty, and probe-ready", async () => {
    const meta = baseMeta({
      lastAccessedAt: 0,
    });

    let prepareCalled = false;
    const { deps, getMeta } = buildDeps(meta, {
      prepare: async (input) => {
        prepareCalled = true;
        assert.equal(input.destructive, true);
        assert.equal(input.origin, "https://app.example.com");
        return successPrepare;
      },
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "watchdog:restore-prepare" },
      deps,
    );

    assert.equal(prepareCalled, true);
    assert.equal(result.executed, true);
    assert.equal(result.blockedReason, null);
    assert.equal(result.prepare?.ok, true);
    assert.equal(result.prepare?.snapshotId, "snap_new");
    assert.equal(getMeta().restoreOracle.status, "ready");
    assert.equal(getMeta().restoreOracle.lastResult, "prepared");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 0);
  });

  test("records failure when prepare returns ok=false", async () => {
    const meta = baseMeta();

    const { deps, getMeta } = buildDeps(meta, {
      prepare: async () => failedPrepare,
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, true);
    assert.equal(result.blockedReason, null);
    assert.equal(result.prepare?.ok, false);
    assert.equal(getMeta().restoreOracle.status, "failed");
    assert.equal(getMeta().restoreOracle.lastResult, "failed");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 1);
    assert.ok(getMeta().restoreOracle.lastError?.includes("prepare failed"));
  });

  test("records failure and rethrows when prepare throws", async () => {
    const meta = baseMeta();

    const { deps, getMeta } = buildDeps(meta, {
      prepare: async () => {
        throw new Error("Sandbox API unreachable");
      },
    });

    await assert.rejects(
      () =>
        runRestoreOracleCycle(
          { origin: "https://app.example.com", reason: "test" },
          deps,
        ),
      { message: "Sandbox API unreachable" },
    );

    assert.equal(getMeta().restoreOracle.status, "failed");
    assert.equal(getMeta().restoreOracle.lastResult, "failed");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 1);
    assert.equal(
      getMeta().restoreOracle.lastError,
      "Sandbox API unreachable",
    );
  });

  test("force=true bypasses idle gating", async () => {
    const meta = baseMeta({
      lastAccessedAt: 999_999,
    });

    let prepareCalled = false;
    const { deps } = buildDeps(meta, {
      prepare: async () => {
        prepareCalled = true;
        return successPrepare;
      },
    });

    const result = await runRestoreOracleCycle(
      {
        origin: "https://app.example.com",
        reason: "launch-verify:restore-prepare",
        force: true,
        minIdleMs: 300_000,
      },
      deps,
    );

    assert.equal(prepareCalled, true);
    assert.equal(result.executed, true);
    assert.equal(result.blockedReason, null);
  });

  test("consecutive failures increment on repeated failures", async () => {
    const meta = baseMeta({
      restoreOracle: {
        status: "failed",
        pendingReason: "dynamic-config-changed",
        lastEvaluatedAt: 800_000,
        lastStartedAt: 800_000,
        lastCompletedAt: 800_000,
        lastBlockedReason: null,
        lastError: "previous error",
        consecutiveFailures: 2,
        lastResult: "failed",
      },
    });

    const { deps, getMeta } = buildDeps(meta, {
      prepare: async () => failedPrepare,
    });

    await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(getMeta().restoreOracle.consecutiveFailures, 3);
  });

  test("successful prepare resets consecutive failures", async () => {
    const meta = baseMeta({
      restoreOracle: {
        status: "failed",
        pendingReason: "dynamic-config-changed",
        lastEvaluatedAt: 800_000,
        lastStartedAt: 800_000,
        lastCompletedAt: 800_000,
        lastBlockedReason: null,
        lastError: "previous error",
        consecutiveFailures: 5,
        lastResult: "failed",
      },
    });

    const { deps, getMeta } = buildDeps(meta, {
      prepare: async () => successPrepare,
    });

    await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(getMeta().restoreOracle.status, "ready");
    assert.equal(getMeta().restoreOracle.consecutiveFailures, 0);
    assert.equal(getMeta().restoreOracle.lastError, null);
  });

  test("sets lastEvaluatedAt on every cycle", async () => {
    const meta = baseMeta({
      status: "stopped",
      sandboxId: null,
    });

    const { deps, getMeta } = buildDeps(meta);

    await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(getMeta().restoreOracle.lastEvaluatedAt, 1_000_000);
  });

  test("null lastAccessedAt does not block idle gating", async () => {
    const meta = baseMeta({
      lastAccessedAt: null,
    });

    let prepareCalled = false;
    const { deps } = buildDeps(meta, {
      prepare: async () => {
        prepareCalled = true;
        return successPrepare;
      },
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test", minIdleMs: 300_000 },
      deps,
    );

    assert.equal(prepareCalled, true);
    assert.equal(result.executed, true);
    assert.equal(result.idleMs, null);
  });

  test("CAS race on beginOracleRun returns already-running", async () => {
    const meta = baseMeta();

    // Simulate a race: the first mutate in beginOracleRun sees status !== "running",
    // but by the time it runs the mutator, another worker has set it to "running".
    let mutateCallCount = 0;
    const { deps } = buildDeps(meta, {
      mutate: async (fn) => {
        mutateCallCount++;
        // The 2nd mutate call is beginOracleRun. Simulate a race by setting
        // status to "running" just before the mutator runs.
        if (mutateCallCount === 2) {
          meta.restoreOracle.status = "running";
        }
        const draft = structuredClone(meta);
        fn(draft);
        return meta;
      },
    });

    const result = await runRestoreOracleCycle(
      { origin: "https://app.example.com", reason: "test" },
      deps,
    );

    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, "already-running");
  });
});
