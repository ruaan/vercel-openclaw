"use client";

import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import {
  getFirstRunCallout,
  getLifecycleActionLabel,
  getLifecycleProgressDetail,
  getLifecycleProgressLabel,
} from "@/shared/sandbox-lifecycle-copy";
import type { StatusPayload, RunAction } from "@/components/admin-types";
import type { SingleStatus } from "@/shared/types";

type StatusPanelProps = {
  status: StatusPayload;
  busy: boolean;
  pendingAction: string | null;
  runAction: RunAction;
};

type LifecycleAwareStatus = StatusPayload & {
  lifecycle?: {
    restoreHistory?: unknown[];
  };
  snapshotHistory?: unknown[];
};

const NEEDS_RESTART = new Set<SingleStatus>(["error", "stopped", "uninitialized"]);
const IS_TRANSITIONAL = new Set<SingleStatus>([
  "creating",
  "restoring",
  "booting",
  "setup",
]);

function friendlyError(raw: string): { headline: string; detail: string } {
  const lower = raw.toLowerCase();
  if (lower.includes("gateway never became ready") || lower.includes("gateway_ready_timeout")) {
    return {
      headline: "Gateway didn't respond in time",
      detail: "This can happen after a deployment or token rotation. Restarting usually fixes it.",
    };
  }
  if (lower.includes("snapshot storage") || lower.includes("snapshot_not_found")) {
    return {
      headline: "Snapshot unavailable",
      detail: "The snapshot could not be loaded. Check your Upstash connection or create a new sandbox.",
    };
  }
  if (lower.includes("oidc") || lower.includes("token") || lower.includes("ai gateway")) {
    return {
      headline: "AI Gateway authentication failed",
      detail: "This usually resolves on the next attempt when a fresh token is issued.",
    };
  }
  if (lower.includes("command") && lower.includes("failed")) {
    return {
      headline: "A setup command failed during restore",
      detail: "The sandbox started but a configuration step failed. Restarting usually fixes it.",
    };
  }
  return {
    headline: "Sandbox encountered an error",
    detail: "An unexpected error occurred during the last operation.",
  };
}

export function StatusPanel({ status, busy, pendingAction, runAction }: StatusPanelProps) {
  const { confirm: confirmStop, dialogProps: stopDialogProps } = useConfirm();
  const { confirm: confirmSnapshot, dialogProps: snapshotDialogProps } =
    useConfirm();
  const { confirm: confirmReset, dialogProps: resetDialogProps } = useConfirm();

  const lifecycleStatus = status.status as SingleStatus;
  const lifecycleAwareStatus = status as LifecycleAwareStatus;
  const hasSnapshot = Boolean(status.snapshotId);
  const restoreHistory = Array.isArray(
    lifecycleAwareStatus.lifecycle?.restoreHistory,
  )
    ? lifecycleAwareStatus.lifecycle.restoreHistory
    : [];
  const snapshotHistoryCount = Array.isArray(lifecycleAwareStatus.snapshotHistory)
    ? lifecycleAwareStatus.snapshotHistory.length
    : null;
  const isFirstRun =
    snapshotHistoryCount != null
      ? snapshotHistoryCount === 0
      : !hasSnapshot && restoreHistory.length === 0;
  const primaryActionLabel = getLifecycleActionLabel(
    lifecycleStatus,
    hasSnapshot,
  );
  const progressLabel = getLifecycleProgressLabel(lifecycleStatus);
  const progressDetail = getLifecycleProgressDetail(lifecycleStatus, isFirstRun);
  const firstRunCallout =
    lifecycleStatus === "uninitialized" ? getFirstRunCallout() : null;

  function handleRestart(): void {
    void runAction("/api/admin/ensure", {
      label: primaryActionLabel,
      successMessage:
        lifecycleStatus === "uninitialized"
          ? "Sandbox creation initiated"
          : lifecycleStatus === "stopped"
            ? "Sandbox start initiated"
            : hasSnapshot
              ? "Sandbox restore initiated"
              : "Fresh sandbox creation initiated",
      method: "POST",
    });
  }

  async function handleStop(): Promise<void> {
    const ok = await confirmStop({
      title: "Stop sandbox?",
      description:
        "This will snapshot the current state and stop the sandbox. You can restore it later from the snapshot.",
      confirmLabel: "Snapshot & stop",
      variant: "danger",
    });
    if (!ok) return;
    void runAction("/api/admin/stop", {
      label: "Stop sandbox",
      successMessage: "Sandbox stopped",
      method: "POST",
    });
  }

  async function handleSnapshot(): Promise<void> {
    const ok = await confirmSnapshot({
      title: "Take snapshot?",
      description:
        "This will create a point-in-time snapshot of the running sandbox. The sandbox will continue running.",
      confirmLabel: "Take snapshot",
    });
    if (!ok) return;
    void runAction("/api/admin/snapshot", {
      label: "Take snapshot",
      successMessage: "Snapshot created",
      method: "POST",
    });
  }

  async function handleReset(): Promise<void> {
    const ok = await confirmReset({
      title: "Reset sandbox from scratch?",
      description:
        "This deletes the current sandbox and all saved snapshots, then starts a fresh install of OpenClaw. Unsaved runtime state, installed packages, and in-sandbox changes will be lost.",
      confirmLabel: "Reset Sandbox",
      variant: "danger",
    });
    if (!ok) return;

    void runAction("/api/admin/reset", {
      label: "Reset Sandbox",
      successMessage: "Sandbox reset initiated",
      method: "POST",
    });
  }

  const isStopping = pendingAction === "Stop sandbox";
  const displayStatus = isStopping ? "stopping" : lifecycleStatus;
  const showRestart = NEEDS_RESTART.has(lifecycleStatus);
  const showRunningActions = lifecycleStatus === "running" && !isStopping;
  const isLifecycleTransition = IS_TRANSITIONAL.has(lifecycleStatus);
  const isTransitional = isLifecycleTransition || isStopping;
  const isResetDisabled =
    busy || lifecycleStatus === "uninitialized" || isLifecycleTransition;
  const errorCopy = status.lastError ? friendlyError(status.lastError) : null;

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Sandbox</p>
          <h2>Sandbox status</h2>
        </div>
        <StatusBadge status={displayStatus} />
      </div>

      <dl className="metrics-grid">
        <div>
          <dt>Sandbox ID</dt>
          <dd>{status.sandboxId ?? "none"}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{status.snapshotId ?? "none"}</dd>
        </div>
        <div>
          <dt>Auth mode</dt>
          <dd>{status.authMode}</dd>
        </div>
        <div>
          <dt>Store</dt>
          <dd>
            {status.storeBackend}
            {status.persistentStore ? "" : " (memory only)"}
          </dd>
        </div>
        <div>
          <dt>Gateway</dt>
          <dd>{status.gatewayReady ? "Ready" : "Not ready"}</dd>
        </div>
        <div>
          <dt>Sleep after</dt>
          <dd>{Math.round(status.sleepAfterMs / 60_000)}m</dd>
        </div>
        {status.timeoutRemainingMs != null && (
          <div>
            <dt>Timeout left</dt>
            <dd>{Math.round(status.timeoutRemainingMs / 1000)}s</dd>
          </div>
        )}
        <div>
          <dt>Firewall</dt>
          <dd>{status.firewall.mode}</dd>
        </div>
      </dl>

      {firstRunCallout ? (
        <div
          className="border border-zinc-800 bg-zinc-900/50 rounded-lg p-4"
          style={{
            marginTop: 20,
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "rgba(24, 24, 27, 0.5)",
            padding: 16,
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>{firstRunCallout.headline}</p>
          {firstRunCallout.body.map((line) => (
            <p
              key={line}
              style={{
                margin: "8px 0 0",
                color: "var(--foreground-muted)",
                lineHeight: 1.5,
              }}
            >
              {line}
            </p>
          ))}
        </div>
      ) : null}

      <div className="hero-actions" style={{ justifyContent: "flex-end" }}>
        {showRestart && (
          <button
            className="button success"
            disabled={busy}
            onClick={handleRestart}
          >
            {primaryActionLabel}
          </button>
        )}
        {showRunningActions && (
          <>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void handleSnapshot()}
            >
              Save snapshot
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void handleStop()}
            >
              Stop
            </button>
            <a
              className="button success"
              href={status.gatewayUrl}
              target="_blank"
              rel="noreferrer"
            >
              {primaryActionLabel}
            </a>
          </>
        )}
        {isTransitional && (
          <button className="button ghost" disabled>
            {isStopping ? "Stopping\u2026" : "Starting\u2026"}
          </button>
        )}
      </div>

      {isLifecycleTransition && (progressLabel || progressDetail) ? (
        <div
          className="border border-zinc-800 bg-zinc-900/50 rounded-lg p-4"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "rgba(24, 24, 27, 0.35)",
            padding: 16,
          }}
        >
          {progressLabel ? (
            <p style={{ margin: 0, fontWeight: 600 }}>{progressLabel}</p>
          ) : null}
          {progressDetail ? (
            <p
              style={{
                margin: progressLabel ? "8px 0 0" : 0,
                color: "var(--foreground-muted)",
                lineHeight: 1.5,
              }}
            >
              {progressDetail}
            </p>
          ) : null}
        </div>
      ) : null}

      {errorCopy ? (
        <div className="error-banner">
          <p style={{ margin: 0, fontWeight: 500 }}>
            {errorCopy.headline}
          </p>
          <p style={{ margin: "4px 0 0", opacity: 0.85 }}>
            {errorCopy.detail}
          </p>
          <details style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            <summary>Technical details</summary>
            <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {status.lastError}
            </pre>
          </details>
        </div>
      ) : null}

      <section style={{ marginTop: 28 }}>
        <p
          style={{
            margin: "0 0 8px",
            color: "var(--foreground-subtle)",
            fontSize: 12,
            fontWeight: 500,
            lineHeight: 1.4,
          }}
        >
          Danger zone
        </p>
        <div
          className="border border-red-900/50 rounded-lg p-4"
          style={{
            border: "1px solid rgba(127, 29, 29, 0.5)",
            borderRadius: 12,
            background: "rgba(127, 29, 29, 0.08)",
            padding: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 320px" }}>
              <p style={{ margin: 0, fontWeight: 600 }}>Reset Sandbox</p>
              <p
                style={{
                  margin: "8px 0 0",
                  color: "var(--foreground-muted)",
                  lineHeight: 1.5,
                  maxWidth: 640,
                }}
              >
                Delete the current sandbox and all saved snapshots, then create
                a brand new sandbox from scratch. Use this when the environment
                is stuck, corrupted, or you want a clean rebuild.
              </p>
            </div>
            <button
              className="button danger"
              disabled={isResetDisabled}
              onClick={() => void handleReset()}
              type="button"
            >
              Reset Sandbox
            </button>
          </div>
        </div>
      </section>

      <ConfirmDialog {...stopDialogProps} />
      <ConfirmDialog {...snapshotDialogProps} />
      <ConfirmDialog {...resetDialogProps} />
    </article>
  );
}
