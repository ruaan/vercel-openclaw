# Plan 02: Remove Fixed Native-Handler Stabilization Delay

## Target

`waitForNativeHandler()` in `src/server/workflows/channels/drain-channel-workflow.ts` (lines 176–222).

## Problem

After polling the native Telegram handler on port 8787 and receiving the first non-5xx response (line 203: `probe.status < 500`), the workflow unconditionally sleeps for 5 seconds (line 208):

```ts
await new Promise((r) => setTimeout(r, 5_000));
```

This hardcoded pause fires on **every** sleeping-sandbox Telegram wake. The comment says the HTTP server accepts connections before the Telegram provider finishes initializing (setWebhook, dedup init, etc.), but the delay is not gated on any readiness signal — it is a fixed guess.

## Options

### Option A: Forward immediately on first non-proxy success

Remove the 5-second sleep entirely. Treat the first `< 500` probe response as "ready" and let `forwardToNativeHandler()` proceed.

- **Pro**: Zero extra latency. Simplest change (delete one line).
- **Con**: If the provider truly is not ready when the HTTP server first responds, the real forward may hit an uninitialized pipeline. The native handler could return a non-5xx error (e.g. 400/422) or silently drop the message.
- **Mitigation**: `forwardToNativeHandler()` already checks `forwardResult.ok` and throws on failure, which the workflow wraps in `toWorkflowProcessingError()`. If the forward fails, the workflow retries. But a silent drop (200 OK, message lost) would not be caught.

### Option B: Replace fixed delay with a short bounded retry window on the real forward path

Remove the 5-second sleep. Instead, modify `forwardToNativeHandler()` (or add a retry wrapper around it) to retry the real payload forward with a short bounded window (e.g. 3 attempts over 2 seconds) on clear not-ready signals (5xx, connection refused). Stop retrying on any response that indicates the handler processed the request (2xx or 4xx).

- **Pro**: No fixed pause. Adapts to actual readiness — if the handler is ready on the first try, there is zero extra latency. If not, retries are bounded and fast.
- **Con**: Slightly more complex. Must define "not-ready signal" carefully to avoid retrying messages that were actually processed (duplicate risk). 4xx from the handler may be ambiguous — could be "not ready" or "bad payload."
- **Mitigation**: Only retry on 502/503/504 (Vercel proxy errors) and connection refused. Any response from the actual handler (including 4xx) means the provider is initialized and accepted the connection.

### Option C: Gate on a stronger cheap readiness proof from the handler

Add a lightweight readiness endpoint to the native Telegram handler (e.g. `GET /telegram-webhook/ready` or a health check on port 8787) that returns 200 only after the provider has completed initialization. Poll that endpoint instead of the generic POST probe.

- **Pro**: Precise readiness signal. No guessing, no fixed delay, no retry-on-real-payload risk.
- **Con**: Requires changes to OpenClaw itself (the gateway/Telegram provider), not just the vercel-openclaw host. Couples the host to an OpenClaw-internal contract. Adds a new endpoint to maintain.
- **Viability**: Low for the current cycle — OpenClaw's Telegram provider does not expose such an endpoint today, and adding one is out of scope for host-side optimization.

## Recommendation

**Option B** is the best balance. It removes the guaranteed 5-second floor without risking silent message loss. The retry window is bounded and fast, and the "not-ready" definition is clean: only Vercel proxy errors (502/503/504) and connection failures trigger retries. Any direct handler response means the provider is up.

Concrete implementation:

1. Delete the `await new Promise((r) => setTimeout(r, 5_000))` on line 208.
2. In `forwardToNativeHandler()`, wrap the fetch in a bounded retry loop:
   - Max 3 attempts, 500ms between retries (total max ~1.5s extra, vs 5s today).
   - Retry only on: status >= 500, fetch throw (connection refused / timeout).
   - Accept on: any status < 500 (handler responded directly).
3. Log each retry with `channels.native_forward_retry` including attempt number and status/error.
4. Keep `waitForNativeHandler()` probe loop as-is (it still gates on the handler being reachable at all) but remove the post-probe sleep.

## Success criteria

- The stopped-path no longer has a hardcoded extra 5-second pause after native handler reachability.
- A sleeping-sandbox Telegram wake completes at least 3 seconds faster than before (reclaiming most of the 5-second floor).
- No increase in duplicate message deliveries or silent message drops.

## Verification

1. Send a Telegram message to a sleeping sandbox. Compare before/after wake time in logs.
2. Inspect log sequence: `channels.native_handler_ready` → `channels.workflow_native_forward_result` should show reduced gap.
3. Verify no `channels.native_forward_retry` entries on a healthy wake (retries only on genuinely slow starts).
4. Run the agentic-testing skill to exercise the full Telegram stopped-path wake flow.
5. Run `node scripts/verify.mjs` to confirm no regressions.
