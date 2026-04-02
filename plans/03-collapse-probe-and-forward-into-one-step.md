# Plan 03: Collapse Native Probe and Real Forward Into One Duplicate-Safe Step

## Target

`src/server/workflows/channels/drain-channel-workflow.ts` — specifically the interaction between `waitForNativeHandler()` (lines 176–222) and `forwardToNativeHandler()` (lines 240–286).

## Current two-step path

When a Telegram message arrives while the sandbox is stopped, the drain-channel workflow runs two sequential network operations after the sandbox is ready:

1. **Synthetic warmup probe** (`waitForNativeHandler`, line 190): sends `POST /telegram-webhook` with a dummy body `{ update_id: 0 }` and the webhook secret header. This polls until the handler returns a non-5xx response, proving the Telegram provider is listening. After the first success, it sleeps 5 seconds (addressed separately in plan 02).

2. **Real payload forward** (`forwardToNativeHandler`, line 279): sends `POST /telegram-webhook` with the actual Telegram update payload and the same webhook secret header. The response is checked — non-ok triggers a workflow error.

This means every sleeping-sandbox Telegram wake pays for at least two full round-trips to the sandbox: one throwaway probe, one real forward. The probe exists solely to gate readiness — it carries no useful payload and the handler presumably discards it (the `update_id: 0` body is not a real Telegram update).

## Proposed single-step approach

Replace the two-step probe-then-forward with a single "attempt real forward, retry only on clear not-ready signals" loop:

1. Skip the synthetic probe entirely.
2. Send the **real** Telegram update payload as the first request to `/telegram-webhook`.
3. If the response indicates the handler is **definitely not listening** (proxy-level failure), wait briefly and retry.
4. If the response indicates the handler **received and processed** the request (any direct handler response), accept it as final — do not retry.

This eliminates one network round-trip on every successful wake.

## Response classification for duplicate safety

This is the critical guardrail. Retries must only happen when the handler **definitely did not process** the payload. Ambiguous responses must be treated as "possibly processed" and never retried.

### Definitely not processed (safe to retry)

| Signal | Meaning |
|--------|---------|
| HTTP 502 | Vercel proxy: upstream not listening |
| HTTP 503 | Vercel proxy: upstream unavailable |
| HTTP 504 | Vercel proxy: upstream timeout |
| Fetch throws (connection refused, DNS error, timeout) | Handler not reachable at all |

These all originate from the infrastructure layer, not the application. The request never reached the Telegram provider code.

### Definitely or possibly processed (never retry)

| Signal | Meaning |
|--------|---------|
| HTTP 200 | Handler accepted and processed the update |
| HTTP 4xx (400, 401, 403, 404, 409, 422) | Handler received the request and rejected it. The payload may or may not have been partially processed (e.g., dedup state updated, side effects triggered). Retrying risks double-delivery or dedup collision. |
| HTTP 5xx from the handler itself (500) | The handler received the request and encountered an internal error. The payload may have been partially processed. A 500 from the actual handler (not the proxy) means the code ran but failed — retrying could cause duplicate side effects. |

### Distinguishing proxy 5xx from handler 5xx

Vercel proxy errors (502/503/504) are distinguishable from handler-originated 500s by status code alone:
- **502, 503, 504**: always proxy-generated when the upstream is unreachable or timed out.
- **500**: always application-generated — the proxy successfully forwarded the request and the handler returned 500.

This means the retry condition is simply `status >= 502` or fetch exception. A `500` response is **not retryable**.

## Implementation sketch

```ts
async function forwardToNativeHandlerWithRetry(
  channel: ChannelName,
  payload: unknown,
  meta: SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
): Promise<{ ok: boolean; status: number }> {
  const MAX_ATTEMPTS = 6;
  const RETRY_INTERVAL_MS = 1_000;
  const TIMEOUT_MS = 30_000;
  const deadline = Date.now() + TIMEOUT_MS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && Date.now() < deadline; attempt++) {
    try {
      const result = await forwardToNativeHandler(channel, payload, meta, getSandboxDomain);

      // Proxy-level failures: handler not listening yet. Safe to retry.
      if (result.status >= 502) {
        logInfo("channels.native_forward_retry", {
          channel, attempt, status: result.status, reason: "proxy-error",
        });
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
        continue;
      }

      // Any direct handler response: do NOT retry regardless of status.
      return result;
    } catch (error) {
      // Connection refused, DNS failure, timeout — handler not reachable.
      logInfo("channels.native_forward_retry", {
        channel, attempt, reason: "fetch-exception",
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }

  // Exhausted retries — report as timeout.
  return { ok: false, status: 504 };
}
```

Key properties:
- The real payload is sent on every attempt — no throwaway probes.
- Retries are bounded (max 6 attempts over ~30s, matching the current `NATIVE_HANDLER_POLL_TIMEOUT_MS`).
- Only proxy errors and network exceptions trigger retries.
- A 500 from the handler is accepted as final (possibly processed).
- A 200 with silent drop risk is accepted as final (same as today — if the handler ACKs, we trust it).

## Changes required

1. **Remove `waitForNativeHandler()` call** from `processChannelStep()` (line 120). The probe loop is no longer needed — the forward-with-retry replaces it.
2. **Replace `forwardToNativeHandler()` call** in `processChannelStep()` (line 122) with the new `forwardToNativeHandlerWithRetry()`.
3. **Keep `waitForNativeHandler()` function** in the file for now (it may still be useful for non-Telegram channels in the future), but remove it from the Telegram stopped-path.
4. **Update `DrainChannelWorkflowDependencies`** to include the new function if it should be injectable for testing.
5. **Update error handling** in `toWorkflowProcessingError()` — the 504 fallback from exhausted retries should map to `RetryableError` (already handled by the `>= 500` check on line 439).

## What this does NOT change

- The fast path (sandbox already running) is untouched — it forwards directly from the webhook route.
- Boot message lifecycle (send → update → clear) is untouched.
- `runWithBootMessages` and `ensureSandboxReady` are untouched.
- Slack, WhatsApp, and Discord forwarding are untouched (they use port 3000 and don't have the separate native-handler readiness problem).

## Duplicate-safety guardrails (explicit)

1. **Never retry on any response < 502.** This includes 200 (success), 4xx (client error), 500 (server error), and 501 (not implemented). All of these mean the handler code ran.
2. **Never retry on ambiguous network responses.** If `fetch()` returns a response object at all (not an exception), the status code determines retryability, not response body inspection.
3. **Retry only on infrastructure-level failures.** 502/503/504 from the Vercel proxy and `fetch()` exceptions (connection refused, timeout, DNS) are the only retry triggers.
4. **Bounded retries.** Maximum 6 attempts over 30 seconds. After exhaustion, the workflow reports failure and the workflow runtime handles further retry/fatal decisions via `toWorkflowProcessingError()`.
5. **Idempotent payload.** Telegram updates have a unique `update_id`. If by some edge case a retry reaches the handler after a previous attempt was partially processed, OpenClaw's dedup layer (keyed on `update_id`) should reject the duplicate. This is defense-in-depth, not the primary safety mechanism.

## Success criteria

- One less network round-trip on successful stopped-path wakes.
- No increase in duplicate message deliveries.
- `channels.native_forward_retry` logs appear only when the handler genuinely was not ready, not on every wake.
- Wake latency reduced by at least the cost of one probe round-trip (~200–500ms).

## Verification

1. Send a Telegram message to a sleeping sandbox. Confirm the log sequence is: `channels.workflow_sandbox_ready` → `channels.workflow_native_forward_result` (no `channels.native_handler_ready` probe step in between).
2. Inspect `channels.native_forward_retry` entries — on a healthy wake, there should be zero or few retries (handler ready quickly). On a slow wake, retries should appear with `reason: "proxy-error"` or `reason: "fetch-exception"`.
3. Verify duplicate-protection behavior: send the same `update_id` twice. The second delivery should be rejected or deduplicated by the handler, not by the retry logic.
4. Confirm no silent message drops: send a Telegram message to a sleeping sandbox and verify the reply arrives in the chat.
5. Run `node scripts/verify.mjs` to confirm no regressions.
6. Run the agentic-testing skill to exercise the full Telegram stopped-path wake flow.
