import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getPublicChannelState } from "@/server/channels/state";
import { getAuthMode } from "@/server/env";
import { computeWouldBlock } from "@/server/firewall/state";
import { extractRequestId, logError } from "@/server/log";
import {
  getRunningSandboxTimeoutRemainingMs,
  probeGatewayReady,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";
import { getSandboxSleepConfig } from "@/server/sandbox/timeout";
import { getStore, getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  try {
    const url = new URL(request.url);
    const includeHealth = url.searchParams.get("health") === "1";
    const meta = await getInitializedMeta();
    const gatewayReady =
      meta.status === "running"
        ? includeHealth
          ? (await probeGatewayReady()).ready
          : true
        : includeHealth
          ? (await probeGatewayReady()).ready
          : false;

    const sleepConfig = getSandboxSleepConfig();
    const timeoutRemainingMs =
      includeHealth || meta.status === "running"
        ? await getRunningSandboxTimeoutRemainingMs()
        : null;

    const response = Response.json({
      authMode: getAuthMode(),
      storeBackend: getStore().name,
      persistentStore: getStore().name !== "memory",
      status: meta.status,
      sandboxId: meta.sandboxId,
      snapshotId: meta.snapshotId,
      gatewayReady,
      gatewayUrl: "/gateway",
      lastError: meta.lastError,
      sleepAfterMs: sleepConfig.sleepAfterMs,
      heartbeatIntervalMs: sleepConfig.heartbeatIntervalMs,
      timeoutRemainingMs,
      firewall: { ...meta.firewall, wouldBlock: computeWouldBlock(meta.firewall) },
      channels: await getPublicChannelState(request, meta),
      lifecycle: {
        lastRestoreMetrics: meta.lastRestoreMetrics ?? null,
        restoreHistory: (meta.restoreHistory ?? []).slice(0, 5),
        lastTokenRefreshAt: meta.lastTokenRefreshAt,
        lastTokenSource: meta.lastTokenSource ?? null,
        lastTokenExpiresAt: meta.lastTokenExpiresAt ?? null,
        lastTokenRefreshError: meta.lastTokenRefreshError ?? null,
        consecutiveTokenRefreshFailures:
          meta.consecutiveTokenRefreshFailures ?? 0,
        breakerOpenUntil: meta.breakerOpenUntil ?? null,
      },
      user: { sub: "admin", name: "Admin" },
    });

    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (requestId) ctx.requestId = requestId;
    logError("status.get_failed", ctx);
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const heartbeatRequestId = extractRequestId(request);

  try {
    const meta = await touchRunningSandbox();
    const response = Response.json({
      ok: true,
      status: meta.status,
    });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (heartbeatRequestId) ctx.requestId = heartbeatRequestId;
    logError("status.heartbeat_failed", ctx);
    return jsonError(error);
  }
}
