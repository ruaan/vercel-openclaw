import { start } from "workflow/api";

import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import {
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
import { extractRequestId, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { getSandboxDomain } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";

const FORWARD_TIMEOUT_MS = 10_000;
const SLACK_FORWARD_HEADERS = [
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
] as const;

function unauthorizedResponse() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
}

function extractSlackEventInfo(payload: unknown): {
  eventType: string | null;
  eventSubtype: string | null;
  channel: string | null;
  user: string | null;
  text: string | null;
  threadTs: string | null;
  botId: string | null;
  payloadType: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { eventType: null, eventSubtype: null, channel: null, user: null, text: null, threadTs: null, botId: null, payloadType: null };
  }

  const p = payload as Record<string, unknown>;
  const event = p.event as Record<string, unknown> | undefined;

  return {
    payloadType: typeof p.type === "string" ? p.type : null,
    eventType: typeof event?.type === "string" ? event.type : null,
    eventSubtype: typeof event?.subtype === "string" ? event.subtype : null,
    channel: typeof event?.channel === "string" ? event.channel : null,
    user: typeof event?.user === "string" ? event.user : null,
    text: typeof event?.text === "string" ? event.text.slice(0, 100) : null,
    threadTs: typeof event?.thread_ts === "string" ? event.thread_ts : null,
    botId: typeof event?.bot_id === "string" ? event.bot_id : null,
  };
}

function extractSlackDedupId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as {
    event_id?: unknown;
    event?: { channel?: unknown; ts?: unknown };
  };
  if (typeof raw.event_id === "string" && raw.event_id.length > 0) {
    return raw.event_id;
  }

  if (
    typeof raw.event?.channel === "string" &&
    typeof raw.event?.ts === "string"
  ) {
    return `${raw.event.channel}:${raw.event.ts}`;
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = extractRequestId(request);
  const rawBody = await request.text().catch(() => "");
  const signatureHeader = request.headers.get("x-slack-signature");
  const timestampHeader = request.headers.get("x-slack-request-timestamp");
  const retryNum = request.headers.get("x-slack-retry-num");
  const retryReason = request.headers.get("x-slack-retry-reason");

  if (!signatureHeader || !timestampHeader) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "missing_signature_headers",
      hasSignature: Boolean(signatureHeader),
      hasTimestamp: Boolean(timestampHeader),
      requestId,
    });
    return unauthorizedResponse();
  }

  const meta = await getInitializedMeta();
  const config = meta.channels.slack;
  if (!config) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "slack_not_configured",
      requestId,
    });
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const signatureValid = isValidSlackSignature({
    signingSecret: config.signingSecret,
    signatureHeader,
    timestampHeader,
    rawBody,
  });
  if (!signatureValid) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "invalid_signature",
      requestId,
      timestampHeader,
      bodyLength: rawBody.length,
    });
    return unauthorizedResponse();
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    logWarn("channels.slack_webhook_rejected", {
      reason: "invalid_json",
      requestId,
      bodyLength: rawBody.length,
      bodyHead: rawBody.slice(0, 100),
    });
    return Response.json({ ok: true });
  }

  const challenge = getSlackUrlVerificationChallenge(payload);
  if (challenge !== null) {
    logInfo("channels.slack_url_verification", {
      requestId,
      challengeLength: challenge.length,
    });
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const eventInfo = extractSlackEventInfo(payload);
  const dedupId = extractSlackDedupId(payload);
  if (dedupId) {
    const accepted = await getStore().acquireLock(channelDedupKey("slack", dedupId), 24 * 60 * 60);
    if (!accepted) {
      logInfo("channels.slack_webhook_dedup_skip", {
        requestId,
        dedupId,
        ...eventInfo,
      });
      return Response.json({ ok: true });
    }
  }

  // Skip bot messages to avoid feedback loops
  if (eventInfo.botId) {
    logInfo("channels.slack_webhook_bot_skip", {
      requestId,
      dedupId,
      botId: eventInfo.botId,
      eventType: eventInfo.eventType,
    });
    return Response.json({ ok: true });
  }

  const op = createOperationContext({
    trigger: "channel.slack.webhook",
    reason: "incoming slack webhook",
    requestId: requestId ?? null,
    channel: "slack",
    dedupId: dedupId ?? null,
    sandboxId: meta.sandboxId ?? null,
    snapshotId: meta.snapshotId ?? null,
    status: meta.status,
  });

  logInfo("channels.slack_webhook_accepted", withOperationContext(op, {
    ...eventInfo,
    retryNum: retryNum ? Number(retryNum) : null,
    retryReason,
    bodyLength: rawBody.length,
  }));

  // --- Fast path: forward raw event to OpenClaw's native Slack HTTP handler ---
  // OpenClaw in HTTP mode re-verifies the Slack signature using x-slack-signature.
  // The Vercel Sandbox proxy strips x-slack-* headers, so OpenClaw rejects the
  // forwarded request with "x-slack-signature did not have the expected type
  // (received undefined)".  Disable the fast path until the sandbox proxy
  // preserves custom headers.  The workflow path extracts the message and calls
  // /v1/chat/completions directly, which works correctly.
  const SLACK_FAST_PATH_ENABLED = false;
  if (SLACK_FAST_PATH_ENABLED && meta.status === "running" && meta.sandboxId) {
    try {
      const sandboxUrl = await getSandboxDomain();
      const forwardUrl = `${sandboxUrl}/slack/events`;
      const forwardHeaders: Record<string, string> = {
        "content-type": request.headers.get("content-type") ?? "application/json",
      };
      for (const h of SLACK_FORWARD_HEADERS) {
        const v = request.headers.get(h);
        if (v) forwardHeaders[h] = v;
      }

      logInfo("channels.slack_fast_path_forwarding", withOperationContext(op, {
        sandboxId: meta.sandboxId,
        forwardUrl,
        forwardHeaderKeys: Object.keys(forwardHeaders),
        hasSlackSignature: Boolean(forwardHeaders["x-slack-signature"]),
        hasSlackTimestamp: Boolean(forwardHeaders["x-slack-request-timestamp"]),
        ...eventInfo,
      }));

      const resp = await fetch(forwardUrl, {
        method: "POST",
        headers: forwardHeaders,
        body: rawBody,
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      if (resp.ok) {
        const respBody = await resp.text();
        logInfo("channels.slack_fast_path_ok", withOperationContext(op, {
          sandboxId: meta.sandboxId,
          responseStatus: resp.status,
          responseBodyLength: respBody.length,
          ...eventInfo,
        }));
        // Proxy the response — Slack slash commands and interactivity expect
        // response bodies from the webhook endpoint.
        return new Response(respBody, {
          status: resp.status,
          headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
        });
      }
      const errorBody = await resp.text().catch(() => "");
      logWarn("channels.slack_fast_path_non_ok", withOperationContext(op, {
        status: resp.status,
        sandboxId: meta.sandboxId,
        responseBody: errorBody.slice(0, 500),
        ...eventInfo,
      }));
    } catch (error) {
      logWarn("channels.slack_fast_path_failed", withOperationContext(op, {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        sandboxId: meta.sandboxId,
        ...eventInfo,
      }));
    }
    // Fall through to queue-based path
  } else {
    logInfo("channels.slack_fast_path_skipped", withOperationContext(op, {
      reason: meta.status !== "running" ? `sandbox_status_${meta.status}` : "no_sandbox_id",
      status: meta.status,
      sandboxId: meta.sandboxId,
      ...eventInfo,
    }));
  }

  try {
    const origin = getPublicOrigin(request);
    await start(drainChannelWorkflow, ["slack", payload, origin, requestId ?? null]);
    logInfo("channels.slack_workflow_started", withOperationContext(op, {
      ...eventInfo,
    }));
  } catch (error) {
    logWarn("channels.slack_workflow_start_failed", withOperationContext(op, {
      error: error instanceof Error ? error.message : String(error),
      ...eventInfo,
    }));
  }

  return Response.json({ ok: true });
}
