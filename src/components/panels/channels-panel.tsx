import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  buildJsonRouteErrorMessage,
  type JsonRouteErrorPayload,
} from "@/components/api-route-errors";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";
import { TelegramPanel } from "@/components/panels/telegram-panel";
import { SlackPanel } from "@/components/panels/slack-panel";
import { WhatsAppPanel } from "@/components/panels/whatsapp-panel";
import { DiscordPanel } from "@/components/panels/discord-panel";
import {
  LAUNCH_PHASE_COUNT,
  type LaunchVerificationPayload,
  type LaunchVerificationPhase,
  type ChannelReadiness,
} from "@/shared/launch-verification";

type PreflightCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

type PreflightAction = {
  id: string;
  status: "required" | "recommended";
  message: string;
  remediation: string;
  env: string[];
};

type PreflightData = {
  ok: boolean;
  checks: PreflightCheck[];
  actions: PreflightAction[];
};

export type PreflightSummary = {
  ok: boolean | null;
  blockerIds: string[];
  blockerMessages: string[];
  requiredActionIds: string[];
  requiredRemediations: string[];
};

type PreflightResponsePayload = PreflightData & JsonRouteErrorPayload;

type ChannelsPanelProps = {
  active: boolean;
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

export function getPreflightBlockerIds(
  preflight: Pick<PreflightData, "ok" | "checks"> | null,
): Set<string> | null {
  if (!preflight || preflight.ok) return null;
  return new Set(
    preflight.checks
      .filter((c) => c.status === "fail")
      .map((c) => c.id),
  );
}

export function summarizePreflight(
  preflight: PreflightData | null,
): PreflightSummary {
  const failedChecks =
    preflight?.checks.filter((check) => check.status === "fail") ?? [];
  const requiredActions =
    preflight?.actions.filter((action) => action.status === "required") ?? [];

  return {
    ok: preflight ? preflight.ok : null,
    blockerIds: failedChecks.map((check) => check.id),
    blockerMessages: failedChecks.map((check) => check.message),
    requiredActionIds: requiredActions.map((action) => action.id),
    requiredRemediations: requiredActions.map((action) => action.remediation),
  };
}

export function formatPreflightFetchError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to load deployment preflight. Refresh the panel or open /api/admin/preflight.";
}

async function loadPreflightData(): Promise<PreflightData> {
  const res = await fetch("/api/admin/preflight", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });

  const payload = (await res.json().catch(() => null)) as
    | PreflightResponsePayload
    | null;

  if (!res.ok) {
    throw new Error(
      buildJsonRouteErrorMessage(
        payload,
        `Failed to load deployment preflight: HTTP ${res.status}`,
      ),
    );
  }

  if (
    !payload ||
    typeof payload.ok !== "boolean" ||
    !Array.isArray(payload.checks) ||
    !Array.isArray(payload.actions)
  ) {
    throw new Error(
      "Failed to load deployment preflight: invalid JSON payload.",
    );
  }

  return payload;
}

/* ── Launch verification helpers ── */

function phaseStatusIcon(phase: LaunchVerificationPhase): string {
  switch (phase.status) {
    case "pass":
      return "\u2713";
    case "fail":
      return "\u2717";
    case "skip":
      return "\u2013";
    case "running":
      return "\u2026";
  }
}

function phaseStatusClass(phase: LaunchVerificationPhase): string {
  switch (phase.status) {
    case "pass":
      return "launch-phase-pass";
    case "fail":
      return "launch-phase-fail";
    case "skip":
      return "launch-phase-skip";
    case "running":
      return "launch-phase-running";
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── Verification view-model ── */

export type VerificationViewModel = {
  badgeText: string;
  badgeClassName: string;
  summaryText: string;
  primaryActionLabel: "Verify" | "Re-verify" | "Verifying\u2026";
  primaryActionClassName: string;
  showQuickCheck: boolean;
};

export function getVerificationViewModel({
  readiness,
  verifyResult,
  verifyRunning,
  totalMs,
}: {
  readiness: Pick<ChannelReadiness, "ready" | "verifiedAt"> | null;
  verifyResult: Pick<LaunchVerificationPayload, "ok"> | null;
  verifyRunning: boolean;
  totalMs: number;
}): VerificationViewModel {
  const isVerified = readiness?.ready === true;
  const isFailed = verifyResult?.ok === false;

  if (verifyRunning) {
    return {
      badgeText: "Verifying\u2026",
      badgeClassName: "status-badge restoring",
      summaryText: "Verification in progress",
      primaryActionLabel: "Verifying\u2026",
      primaryActionClassName: "button primary",
      showQuickCheck: false,
    };
  }

  if (isFailed) {
    return {
      badgeText: "Failed",
      badgeClassName: "status-badge error",
      summaryText: "Last verification failed",
      primaryActionLabel: isVerified ? "Re-verify" : "Verify",
      primaryActionClassName: "button primary",
      showQuickCheck: !isVerified,
    };
  }

  if (isVerified) {
    const durationSuffix = verifyResult ? ` in ${formatDuration(totalMs)}` : "";
    return {
      badgeText: "Verified",
      badgeClassName: "status-badge running",
      summaryText: readiness?.verifiedAt
        ? `Verified ${formatTimestamp(readiness.verifiedAt)}${durationSuffix}`
        : `Verified${durationSuffix}`,
      primaryActionLabel: "Re-verify",
      primaryActionClassName: "button ghost",
      showQuickCheck: false,
    };
  }

  return {
    badgeText: "",
    badgeClassName: "",
    summaryText: "Not yet verified",
    primaryActionLabel: "Verify",
    primaryActionClassName: "button primary",
    showQuickCheck: true,
  };
}

async function loadPersistedReadiness(): Promise<ChannelReadiness | null> {
  try {
    const res = await fetch("/api/admin/launch-verify", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as ChannelReadiness) : null;
  } catch {
    return null;
  }
}

type StreamPhaseEvent = { type: "phase"; phase: LaunchVerificationPhase };
type StreamResultEvent = {
  type: "result";
  payload: LaunchVerificationPayload & { channelReadiness?: ChannelReadiness };
};
type StreamEvent = StreamPhaseEvent | StreamResultEvent;

/* ── Structured verification telemetry ── */

type VerificationRunMode = "safe" | "destructive";

type ChannelsPanelEvent =
  | {
      event: "channels.preflight.refresh";
      source: "channels-panel";
      ts: string;
      ok: boolean | null;
      blockerIds: string[];
      requiredActionIds: string[];
    }
  | {
      event: "channels.preflight.error";
      source: "channels-panel";
      ts: string;
      error: string;
    }
  | {
      event: "channels.readiness.refresh";
      source: "channels-panel";
      ts: string;
      ok: boolean;
      verifiedAt: string | null;
    }
  | {
      event: "channels.verify.start";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
    }
  | {
      event: "channels.verify.phase";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      phaseId: string;
      phaseStatus: LaunchVerificationPhase["status"];
      durationMs: number;
      message: string;
      error?: string;
    }
  | {
      event: "channels.verify.result";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      ok: boolean;
      totalMs: number;
      verifiedAt: string | null;
    }
  | {
      event: "channels.verify.error";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      error: string;
    };

export function createVerificationRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `verify-${crypto.randomUUID()}`;
  }
  return `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emitChannelsPanelEvent(
  event: Omit<ChannelsPanelEvent, "source" | "ts">,
): void {
  const payload = {
    source: "channels-panel" as const,
    ts: new Date().toISOString(),
    ...event,
  };

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("openclaw:channels-panel", { detail: payload }),
    );
  }

  const serialized = JSON.stringify(payload);
  if (payload.event.endsWith(".error")) {
    console.error(`[openclaw.channels] ${serialized}`);
    return;
  }
  console.info(`[openclaw.channels] ${serialized}`);
}

export function formatLaunchVerificationFetchError(
  payload: { error?: { message?: string }; message?: string } | null,
  status: number,
): string {
  const explicit = payload?.error?.message ?? payload?.message;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }
  return `Verification request failed (HTTP ${status}). Refresh the panel or open /api/admin/launch-verify.`;
}

export function getVerificationSurfaceState(args: {
  readiness: ChannelReadiness | null;
  verifyResult: LaunchVerificationPayload | null;
  verifyRunning: boolean;
}): "idle" | "running" | "verified" | "failed" {
  if (args.verifyRunning) return "running";
  if (args.verifyResult) return args.verifyResult.ok ? "verified" : "failed";
  if (args.readiness?.ready) return "verified";
  return "idle";
}

/* ── Main component ── */

export function ChannelsPanel({
  active,
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: ChannelsPanelProps) {
  /* Preflight state */
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightLoadedAt, setPreflightLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const preflightRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  /* Launch verification state */
  const [verifyResult, setVerifyResult] = useState<LaunchVerificationPayload | null>(null);
  const [readiness, setReadiness] = useState<ChannelReadiness | null>(null);
  const [verifyRunning, setVerifyRunning] = useState(false);
  const [streamingPhases, setStreamingPhases] = useState<LaunchVerificationPhase[]>([]);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const verifyRequestIdRef = useRef("");
  const verifyModeRef = useRef<VerificationRunMode | "">("");

  const preflightSummary = summarizePreflight(preflight);
  const preflightBlockerIds =
    preflightSummary.ok === false
      ? new Set(preflightSummary.blockerIds)
      : null;

  /* Derived verification state */
  const isStreaming = verifyRunning && streamingPhases.length > 0;

  const totalMs = verifyResult
    ? new Date(verifyResult.completedAt).getTime() - new Date(verifyResult.startedAt).getTime()
    : 0;

  const verificationView = getVerificationViewModel({
    readiness,
    verifyResult,
    verifyRunning,
    totalMs,
  });

  const showPersistedPhases = !verifyResult && !isStreaming && readiness && readiness.phases.length > 0;

  const completedStreamCount = streamingPhases.filter(
    (p) => p.status !== "running",
  ).length;
  const progressPct = isStreaming
    ? Math.round((completedStreamCount / LAUNCH_PHASE_COUNT) * 100)
    : 0;

  const isFailed = verifyResult && !verifyResult.ok;
  const showDetails = detailsExpanded || isStreaming || isFailed;

  const verificationSurfaceState = getVerificationSurfaceState({
    readiness,
    verifyResult,
    verifyRunning,
  });
  const verificationPhaseCount = isStreaming
    ? streamingPhases.length
    : verifyResult?.phases.length ?? readiness?.phases.length ?? 0;

  /* ── Preflight fetching ── */

  async function refreshPreflight(): Promise<void> {
    const requestId = preflightRequestIdRef.current + 1;
    preflightRequestIdRef.current = requestId;

    try {
      const nextPreflight = await loadPreflightData();
      if (!mountedRef.current || requestId !== preflightRequestIdRef.current) {
        return;
      }

      const summary = summarizePreflight(nextPreflight);
      setPreflight(nextPreflight);
      setPreflightError(null);
      setPreflightLoadedAt(Date.now());
      emitChannelsPanelEvent({
        event: "channels.preflight.refresh",
        ok: summary.ok,
        blockerIds: summary.blockerIds,
        requiredActionIds: summary.requiredActionIds,
      });
    } catch (error) {
      if (!mountedRef.current || requestId !== preflightRequestIdRef.current) {
        return;
      }

      const message = formatPreflightFetchError(error);
      setPreflightError(message);
      emitChannelsPanelEvent({
        event: "channels.preflight.error",
        error: message,
      });
    }
  }

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      void Promise.all([refreshPreflight(), refreshReadiness()]);
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active]);

  /* Load persisted readiness on mount */
  useEffect(() => {
    let cancelled = false;
    void loadPersistedReadiness().then((data) => {
      if (!cancelled && data) {
        setReadiness(data);
      }
    });
    return () => { cancelled = true; };
  }, []);

  /* ── Launch verification ── */

  async function runVerification(mode: VerificationRunMode): Promise<void> {
    const requestId = createVerificationRequestId();
    verifyRequestIdRef.current = requestId;
    verifyModeRef.current = mode;
    setVerifyRunning(true);
    setStreamingPhases([]);
    setVerifyResult(null);
    setDetailsExpanded(false);

    emitChannelsPanelEvent({
      event: "channels.verify.start",
      requestId,
      mode,
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/admin/launch-verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({ mode }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        const message = "Verification requires an authenticated session.";
        emitChannelsPanelEvent({
          event: "channels.verify.error",
          requestId,
          mode,
          error: message,
        });
        toast.error(message);
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string }; message?: string }
          | null;
        const message = formatLaunchVerificationFetchError(
          payload,
          response.status,
        );
        emitChannelsPanelEvent({
          event: "channels.verify.error",
          requestId,
          mode,
          error: message,
        });
        toast.error(message);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const message =
          "Verification stream was empty. Refresh the panel or open /api/admin/launch-verify.";
        emitChannelsPanelEvent({
          event: "channels.verify.error",
          requestId,
          mode,
          error: message,
        });
        toast.error(message);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as StreamEvent;
            if (event.type === "phase") {
              emitChannelsPanelEvent({
                event: "channels.verify.phase",
                requestId,
                mode,
                phaseId: event.phase.id,
                phaseStatus: event.phase.status,
                durationMs: event.phase.durationMs,
                message: event.phase.message,
                error: event.phase.error,
              });
              setStreamingPhases((prev) => {
                const existing = prev.findIndex(
                  (p) => p.id === event.phase.id,
                );
                if (existing >= 0) {
                  const next = [...prev];
                  next[existing] = event.phase;
                  return next;
                }
                return [...prev, event.phase];
              });
              continue;
            }

            const resultTotalMs =
              new Date(event.payload.completedAt).getTime() -
              new Date(event.payload.startedAt).getTime();
            emitChannelsPanelEvent({
              event: "channels.verify.result",
              requestId,
              mode,
              ok: event.payload.ok,
              totalMs: resultTotalMs,
              verifiedAt:
                event.payload.channelReadiness?.verifiedAt ?? null,
            });
            setVerifyResult(event.payload);
            setStreamingPhases([]);
            if (event.payload.channelReadiness) {
              setReadiness(event.payload.channelReadiness);
            }
            if (!event.payload.ok) {
              setDetailsExpanded(true);
              const failing = event.payload.phases.find(
                (p) => p.status === "fail",
              );
              if (failing) {
                toast.error(
                  `Verification failed at ${failing.id}: ${failing.error ?? failing.message}`,
                );
              }
            }
          } catch {
            emitChannelsPanelEvent({
              event: "channels.verify.error",
              requestId,
              mode,
              error: `Malformed verification stream event: ${trimmed.slice(0, 160)}`,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        emitChannelsPanelEvent({
          event: "channels.verify.error",
          requestId,
          mode,
          error: "Verification aborted",
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      emitChannelsPanelEvent({
        event: "channels.verify.error",
        requestId,
        mode,
        error: message,
      });
      toast.error(message);
    } finally {
      abortRef.current = null;
      setVerifyRunning(false);
    }
  }

  /* ── Readiness refresh ── */

  async function refreshReadiness(): Promise<void> {
    const nextReadiness = await loadPersistedReadiness();
    if (!mountedRef.current) return;
    setReadiness(nextReadiness);
    emitChannelsPanelEvent({
      event: "channels.readiness.refresh",
      ok: nextReadiness?.ready === true,
      verifiedAt: nextReadiness?.verifiedAt ?? null,
    });
  }

  return (
    <article
      className="panel-card full-span"
      data-preflight-ok={
        preflightSummary.ok === null ? "unknown" : String(preflightSummary.ok)
      }
      data-preflight-blocker-ids={preflightSummary.blockerIds.join(",")}
      data-preflight-required-action-ids={preflightSummary.requiredActionIds.join(",")}
      data-verification-state={verificationSurfaceState}
      data-verification-request-id={verifyRequestIdRef.current}
      data-verification-mode={verifyModeRef.current}
      data-verification-ok={
        verifyResult
          ? String(verifyResult.ok)
          : readiness?.ready
            ? "true"
            : "false"
      }
      data-verification-phase-count={String(verificationPhaseCount)}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>External entry points</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 36 }}>
          {verificationView.badgeText ? (
            <span className={verificationView.badgeClassName}>{verificationView.badgeText}</span>
          ) : null}
          <button
            className="button ghost"
            disabled={busy || refreshing}
            onClick={() => {
              setRefreshing(true);
              void Promise.all([refresh(), refreshPreflight(), refreshReadiness()])
                .finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? "Refreshing\u2026" : "Refresh"}
          </button>
        </div>
      </div>

      {/* ── Compact readiness row ── */}
      <div className="launch-verified-summary">
        <span className="muted-copy">{verificationView.summaryText}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {(showPersistedPhases || verifyResult) && !verifyRunning && (
            <button
              className="button ghost"
              disabled={busy || verifyRunning}
              onClick={() => setDetailsExpanded((v) => !v)}
            >
              {detailsExpanded ? "Hide details" : "Show details"}
            </button>
          )}
          {verificationView.showQuickCheck && !verifyRunning && (
            <button
              className="button ghost"
              disabled={busy || verifyRunning}
              onClick={() => void runVerification("safe")}
              title="Quick diagnostic — does not unlock channels"
            >
              Quick check
            </button>
          )}
          <button
            className={verificationView.primaryActionClassName}
            disabled={busy || verifyRunning}
            onClick={() => void runVerification("destructive")}
            title="Full verification including stop/restore cycle"
          >
            {verificationView.primaryActionLabel}
          </button>
        </div>
      </div>

      {/* ── Streaming progress ── */}
      {isStreaming && (
        <div style={{ marginTop: 16 }}>
          <div className="launch-progress-bar" style={{ marginBottom: 12 }}>
            <div
              className="launch-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="launch-phases">
            {streamingPhases.map((phase) => (
              <div
                key={phase.id}
                className={`launch-phase-row ${phaseStatusClass(phase)}`}
              >
                <span className="launch-phase-icon">{phaseStatusIcon(phase)}</span>
                <span className="launch-phase-id">{phase.id}</span>
                <span className="launch-phase-message">{phase.message}</span>
                {phase.durationMs > 0 && (
                  <span className="launch-phase-duration">{formatDuration(phase.durationMs)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Detail view: latest result ── */}
      {verifyResult && showDetails && (
        <div style={{ marginTop: 16 }}>
          <div className="metrics-grid" style={{ marginBottom: 12 }}>
            <div>
              <dt>Mode</dt>
              <dd>{verifyResult.mode}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(totalMs)}</dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>{formatTimestamp(verifyResult.completedAt)}</dd>
            </div>
          </div>

          <div className="launch-phases">
            {verifyResult.phases.map((phase) => (
              <div
                key={phase.id}
                className={`launch-phase-row ${phaseStatusClass(phase)}`}
              >
                <span className="launch-phase-icon">{phaseStatusIcon(phase)}</span>
                <span className="launch-phase-id">{phase.id}</span>
                <span className="launch-phase-message">{phase.message}</span>
                {phase.durationMs > 0 && (
                  <span className="launch-phase-duration">{formatDuration(phase.durationMs)}</span>
                )}
              </div>
            ))}
          </div>

          {verifyResult.phases.some((p) => p.status === "fail" && p.error) && (
            <div className="error-banner" style={{ marginTop: 12 }}>
              {verifyResult.phases
                .filter((p) => p.status === "fail" && p.error)
                .map((p) => (
                  <p key={p.id} style={{ margin: "4px 0" }}>
                    <strong>{p.id}:</strong> {p.error}
                  </p>
                ))}
            </div>
          )}
        </div>
      )}

      {/* ── Detail view: persisted phases (no fresh result) ── */}
      {showPersistedPhases && showDetails && (
        <div style={{ marginTop: 16 }}>
          <div className="metrics-grid" style={{ marginBottom: 12 }}>
            <div>
              <dt>Mode</dt>
              <dd>{readiness.mode ?? "\u2014"}</dd>
            </div>
            <div>
              <dt>Last verified</dt>
              <dd>{readiness.verifiedAt ? formatTimestamp(readiness.verifiedAt) : "\u2014"}</dd>
            </div>
          </div>

          <div className="launch-phases">
            {readiness.phases.map((phase) => (
              <div
                key={phase.id}
                className={`launch-phase-row ${phaseStatusClass(phase)}`}
              >
                <span className="launch-phase-icon">{phaseStatusIcon(phase)}</span>
                <span className="launch-phase-id">{phase.id}</span>
                <span className="launch-phase-message">{phase.message}</span>
                {phase.durationMs > 0 && (
                  <span className="launch-phase-duration">{formatDuration(phase.durationMs)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Preflight error ── */}
      {preflightError ? (
        <div className="error-banner" style={{ marginTop: 16, marginBottom: 16 }} aria-live="polite">
          <p style={{ margin: 0, fontWeight: 500 }}>{preflightError}</p>
          <p className="muted-copy" style={{ margin: "4px 0 0" }}>
            Channel cards keep the last known preflight snapshot until refresh succeeds.
          </p>
        </div>
      ) : null}

      {/* ── Preflight deployment blockers ── */}
      {preflightSummary.ok === false ? (
        <div
          className="error-banner"
          style={{ marginTop: 16, marginBottom: 16 }}
          aria-live="polite"
          data-preflight-banner="deployment-blockers"
        >
          <p style={{ margin: 0, fontWeight: 500 }}>
            Resolve deployment blockers before connecting channels.
          </p>
          {preflightSummary.blockerMessages.map((message) => (
            <p key={message} className="muted-copy" style={{ margin: "4px 0 0" }}>
              {message}
            </p>
          ))}
          {preflightSummary.requiredRemediations.length > 0 ? (
            <details className="channel-details" style={{ marginTop: 10 }}>
              <summary>Required changes</summary>
              <div className="channel-details-body">
                {preflightSummary.requiredRemediations.map((remediation) => (
                  <p key={remediation} className="muted-copy" style={{ margin: 0 }}>
                    {remediation}
                  </p>
                ))}
              </div>
            </details>
          ) : null}
          {preflightLoadedAt ? (
            <p className="muted-copy" style={{ margin: "8px 0 0" }}>
              Checked {new Date(preflightLoadedAt).toLocaleTimeString()}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="channel-grid">
        <SlackPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
        <TelegramPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
        <DiscordPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
        <WhatsAppPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
      </div>
    </article>
  );
}
