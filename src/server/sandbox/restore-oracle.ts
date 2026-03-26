import { logInfo, logWarn } from "@/server/log";
import type {
  PrepareRestoreResult,
  ProbeResult,
} from "@/server/sandbox/lifecycle";
import {
  buildRestoreTargetAttestation,
  buildRestoreTargetPlan,
} from "@/server/sandbox/restore-attestation";
import type { RestoreTargetAttestation } from "@/shared/launch-verification";
import type { RestoreTargetPlan } from "@/shared/launch-verification";
import type {
  OperationContext,
  RestorePreparedReason,
  SingleMeta,
} from "@/shared/types";

const DEFAULT_RESTORE_ORACLE_MIN_IDLE_MS = 5 * 60_000;

export type RestoreOracleBlockedReason =
  | "already-ready"
  | "already-running"
  | "sandbox-not-running"
  | "sandbox-recently-active"
  | "gateway-not-ready";

export type RestoreOracleCycleResult = {
  executed: boolean;
  blockedReason: RestoreOracleBlockedReason | null;
  idleMs: number | null;
  minIdleMs: number;
  attestation: RestoreTargetAttestation;
  plan: RestoreTargetPlan;
  prepare: PrepareRestoreResult | null;
};

export type RestoreOracleDeps = {
  getMeta: () => Promise<SingleMeta>;
  mutate: (
    mutator: (meta: SingleMeta) => SingleMeta | void,
  ) => Promise<SingleMeta>;
  probe: (options?: { timeoutMs?: number }) => Promise<ProbeResult>;
  prepare: (input: {
    origin: string;
    reason: string;
    destructive?: boolean;
    op?: OperationContext;
  }) => Promise<PrepareRestoreResult>;
  now: () => number;
};

function toIdleMs(lastAccessedAt: number | null, now: number): number | null {
  return typeof lastAccessedAt === "number"
    ? Math.max(0, now - lastAccessedAt)
    : null;
}

function blockedMessage(
  reason: RestoreOracleBlockedReason,
  idleMs: number | null,
  minIdleMs: number,
): string {
  switch (reason) {
    case "already-ready":
      return "Restore target already reusable.";
    case "already-running":
      return "Restore oracle already running in another worker.";
    case "sandbox-not-running":
      return "Sandbox is not running; destructive prepare skipped.";
    case "sandbox-recently-active":
      return `Sandbox was active ${idleMs ?? 0}ms ago; need at least ${minIdleMs}ms of idle time.`;
    case "gateway-not-ready":
      return "Gateway is not healthy enough to seal a fresh restore target.";
  }
}

async function markOracleBlocked(
  deps: RestoreOracleDeps,
  message: string,
  now: number,
): Promise<void> {
  await deps.mutate((meta) => {
    if (meta.restoreOracle.status !== "running") {
      meta.restoreOracle.status = "blocked";
    }
    meta.restoreOracle.lastCompletedAt = now;
    meta.restoreOracle.lastBlockedReason = message;
    meta.restoreOracle.lastResult = "blocked";
  });
}

async function markOracleReady(
  deps: RestoreOracleDeps,
  now: number,
  lastResult: "already-ready" | "prepared",
): Promise<void> {
  await deps.mutate((meta) => {
    meta.restoreOracle.status = "ready";
    meta.restoreOracle.pendingReason = null;
    meta.restoreOracle.lastCompletedAt = now;
    meta.restoreOracle.lastBlockedReason = null;
    meta.restoreOracle.lastError = null;
    meta.restoreOracle.consecutiveFailures = 0;
    meta.restoreOracle.lastResult = lastResult;
  });
}

async function markOracleFailed(
  deps: RestoreOracleDeps,
  now: number,
  errorMessage: string,
): Promise<void> {
  await deps.mutate((meta) => {
    meta.restoreOracle.status = "failed";
    meta.restoreOracle.lastCompletedAt = now;
    meta.restoreOracle.lastError = errorMessage;
    meta.restoreOracle.lastResult = "failed";
    meta.restoreOracle.consecutiveFailures =
      (meta.restoreOracle.consecutiveFailures ?? 0) + 1;
  });
}

async function beginOracleRun(
  deps: RestoreOracleDeps,
  now: number,
  pendingReason: RestorePreparedReason | null,
): Promise<void> {
  await deps.mutate((meta) => {
    if (meta.restoreOracle.status === "running") {
      throw new Error("RESTORE_ORACLE_ALREADY_RUNNING");
    }
    meta.restoreOracle.status = "running";
    meta.restoreOracle.pendingReason = pendingReason;
    meta.restoreOracle.lastStartedAt = now;
    meta.restoreOracle.lastBlockedReason = null;
    meta.restoreOracle.lastError = null;
  });
}

export async function runRestoreOracleCycle(
  input: {
    origin: string;
    reason: string;
    force?: boolean;
    minIdleMs?: number;
    op?: OperationContext;
  },
  deps: RestoreOracleDeps,
): Promise<RestoreOracleCycleResult> {
  const now = deps.now();
  const minIdleMs = input.minIdleMs ?? DEFAULT_RESTORE_ORACLE_MIN_IDLE_MS;
  const meta = await deps.getMeta();
  const attestation = buildRestoreTargetAttestation(meta);
  const plan = buildRestoreTargetPlan({
    attestation,
    status: meta.status,
    sandboxId: meta.sandboxId,
  });
  const idleMs = toIdleMs(meta.lastAccessedAt, now);

  await deps.mutate((next) => {
    next.restoreOracle.lastEvaluatedAt = now;
  });

  logInfo("sandbox.restore_oracle.cycle_evaluated", {
    reason: input.reason,
    force: input.force ?? false,
    idleMs,
    minIdleMs,
    reusable: attestation.reusable,
    oracleStatus: meta.restoreOracle.status,
    sandboxStatus: meta.status,
  });

  if (attestation.reusable) {
    await markOracleReady(deps, now, "already-ready");
    logInfo("sandbox.restore_oracle.already_ready", {
      reason: input.reason,
    });
    return {
      executed: false,
      blockedReason: "already-ready",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
    };
  }

  if (meta.restoreOracle.status === "running") {
    const message = blockedMessage("already-running", idleMs, minIdleMs);
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "already-running",
      message,
    });
    return {
      executed: false,
      blockedReason: "already-running",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
    };
  }

  if (meta.status !== "running" || !meta.sandboxId) {
    const message = blockedMessage("sandbox-not-running", idleMs, minIdleMs);
    await markOracleBlocked(deps, message, now);
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "sandbox-not-running",
      sandboxStatus: meta.status,
      message,
    });
    return {
      executed: false,
      blockedReason: "sandbox-not-running",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
    };
  }

  if (!input.force && idleMs !== null && idleMs < minIdleMs) {
    const message = blockedMessage(
      "sandbox-recently-active",
      idleMs,
      minIdleMs,
    );
    await markOracleBlocked(deps, message, now);
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "sandbox-recently-active",
      idleMs,
      minIdleMs,
      message,
    });
    return {
      executed: false,
      blockedReason: "sandbox-recently-active",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
    };
  }

  const probe = await deps.probe();
  if (!probe.ready) {
    const message =
      probe.error ?? blockedMessage("gateway-not-ready", idleMs, minIdleMs);
    await markOracleBlocked(deps, message, now);
    logInfo("sandbox.restore_oracle.blocked", {
      reason: "gateway-not-ready",
      probeError: probe.error ?? null,
      message,
    });
    return {
      executed: false,
      blockedReason: "gateway-not-ready",
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare: null,
    };
  }

  try {
    await beginOracleRun(deps, now, meta.restorePreparedReason);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RESTORE_ORACLE_ALREADY_RUNNING"
    ) {
      logInfo("sandbox.restore_oracle.blocked", {
        reason: "already-running",
        message: "Lost CAS race for oracle lock.",
      });
      return {
        executed: false,
        blockedReason: "already-running",
        idleMs,
        minIdleMs,
        attestation,
        plan,
        prepare: null,
      };
    }
    throw error;
  }

  logInfo("sandbox.restore_oracle.run_started", {
    reason: input.reason,
    force: input.force ?? false,
    idleMs,
    minIdleMs,
    attestationReasons: attestation.reasons,
    restorePreparedStatus: meta.restorePreparedStatus,
    restorePreparedReason: meta.restorePreparedReason,
  });

  try {
    const prepare = await deps.prepare({
      origin: input.origin,
      reason: input.reason,
      destructive: true,
      op: input.op,
    });

    if (!prepare.ok) {
      const errorMessage = `prepare failed: ${prepare.reason ?? "unknown"}`;
      await markOracleFailed(deps, deps.now(), errorMessage);
      logWarn("sandbox.restore_oracle.run_failed", {
        error: errorMessage,
        state: prepare.state,
        snapshotId: prepare.snapshotId,
      });
      return {
        executed: true,
        blockedReason: null,
        idleMs,
        minIdleMs,
        attestation,
        plan,
        prepare,
      };
    }

    await markOracleReady(deps, deps.now(), "prepared");
    logInfo("sandbox.restore_oracle.run_completed", {
      snapshotId: prepare.snapshotId,
      state: prepare.state,
      reason: prepare.reason,
    });

    return {
      executed: true,
      blockedReason: null,
      idleMs,
      minIdleMs,
      attestation,
      plan,
      prepare,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markOracleFailed(deps, deps.now(), errorMessage);
    logWarn("sandbox.restore_oracle.run_threw", { error: errorMessage });
    throw error;
  }
}
