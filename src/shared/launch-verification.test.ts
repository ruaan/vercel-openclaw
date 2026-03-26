import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  resolveRestorePreparedPhase,
  type RestoreTargetAttestation,
} from "@/shared/launch-verification";

function makeAttestation(
  overrides: Partial<RestoreTargetAttestation> = {},
): RestoreTargetAttestation {
  return {
    desiredDynamicConfigHash: "desired-config",
    desiredAssetSha256: "desired-assets",
    snapshotDynamicConfigHash: "snapshot-config",
    runtimeDynamicConfigHash: "runtime-config",
    snapshotAssetSha256: "snapshot-assets",
    runtimeAssetSha256: "runtime-assets",
    restorePreparedStatus: "dirty",
    restorePreparedReason: "dynamic-config-changed",
    restorePreparedAt: null,
    runtimeConfigFresh: false,
    snapshotConfigFresh: false,
    runtimeAssetsFresh: false,
    snapshotAssetsFresh: false,
    reusable: false,
    needsPrepare: true,
    reasons: [
      "runtime-config-stale",
      "snapshot-config-stale",
      "snapshot-assets-stale",
      "restore-target-dirty",
    ],
    ...overrides,
  };
}

describe("resolveRestorePreparedPhase", () => {
  test("passes through an already reusable restore target", () => {
    const reusable = makeAttestation({
      restorePreparedStatus: "ready",
      restorePreparedReason: "prepared",
      runtimeConfigFresh: true,
      snapshotConfigFresh: true,
      runtimeAssetsFresh: true,
      snapshotAssetsFresh: true,
      reusable: true,
      needsPrepare: false,
      reasons: [],
    });

    assert.deepEqual(
      resolveRestorePreparedPhase({
        blockedReason: "already-ready",
        initialAttestation: reusable,
        finalAttestation: reusable,
        prepare: null,
      }),
      {
        ok: true,
        message: "Restore target already reusable.",
      },
    );
  });

  test("passes only when the final attestation is reusable", () => {
    const initial = makeAttestation();
    const final = makeAttestation({
      restorePreparedStatus: "ready",
      restorePreparedReason: "prepared",
      runtimeConfigFresh: true,
      snapshotConfigFresh: true,
      runtimeAssetsFresh: true,
      snapshotAssetsFresh: true,
      reusable: true,
      needsPrepare: false,
      reasons: [],
    });

    assert.deepEqual(
      resolveRestorePreparedPhase({
        blockedReason: null,
        initialAttestation: initial,
        finalAttestation: final,
        prepare: {
          ok: true,
          snapshotId: "snap_123",
          actions: [{ status: "completed", message: "snapshot created" }],
        },
      }),
      {
        ok: true,
        message: "Prepared restore target sealed and verified (snap_123).",
      },
    );
  });

  test("does not trust prepare.ok when final attestation is still not reusable", () => {
    const result = resolveRestorePreparedPhase({
      blockedReason: null,
      initialAttestation: makeAttestation(),
      finalAttestation: makeAttestation({
        reasons: ["snapshot-config-stale", "restore-target-failed"],
      }),
      prepare: {
        ok: true,
        snapshotId: "snap_123",
        actions: [{ status: "completed", message: "snapshot created" }],
      },
    });

    assert.deepEqual(result, {
      ok: false,
      message:
        "Restore target not reusable: snapshot-config-stale, restore-target-failed",
    });
  });

  test("prefers the failed prepare action when reporting failure", () => {
    const result = resolveRestorePreparedPhase({
      blockedReason: null,
      initialAttestation: makeAttestation(),
      finalAttestation: makeAttestation({
        reasons: ["restore-target-failed"],
      }),
      prepare: {
        ok: false,
        snapshotId: null,
        actions: [{ status: "failed", message: "gateway not ready" }],
      },
    });

    assert.deepEqual(result, {
      ok: false,
      message: "Restore target not reusable: gateway not ready",
    });
  });
});
