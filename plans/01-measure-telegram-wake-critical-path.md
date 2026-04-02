# Plan 01: Measure Telegram Wake Critical Path First

## Goal

Establish a real baseline for the sleeping-sandbox Telegram wake path so the
next optimisation branch is chosen from evidence, not guesswork.

> Is wake latency dominated by `sandboxCreateMs` (platform resume), or by
> one of the host-side restore phases (`startupScriptMs`, `assetSyncMs`,
> `localReadyMs`, `publicReadyMs`)?

## Current state (post plans 02 + 03)

Plans 02 and 03 are already reflected in code:

- The fixed 5-second stabilization sleep after the native handler first
  responded is **removed**.
- The synthetic warmup probe (`waitForNativeHandler` with `update_id: 0`) is
  **removed** — `processChannelStep` now sends the real Telegram payload directly
  via `forwardToNativeHandlerWithRetry`.
- The unconditional `sleep 1` after `pkill` in `buildFastRestoreScript()` is now
  **conditional** — snapshot wakes skip the delay because no old gateway process
  exists.
- `@buape/carbon` and other peer deps are baked into bootstrap so restore never
  runs `npm install` on the hot path (old-snapshot fallback retained).

These changes eliminate the known fixed-delay floors. What remains unknown is
whether `sandboxCreateMs` (Vercel SDK resume latency) now dominates the total.

## What to measure

The `channels.telegram_wake_summary` structured log now emits a single
end-to-end record per stopped-path Telegram wake. Each record includes:

### Timing fields

| Field | Source |
| ----- | ------ |
| `webhookToWorkflowMs` | webhook route `receivedAtMs` → workflow step start |
| `workflowToSandboxReadyMs` | workflow step start → `ensureSandboxReady` complete |
| `forwardMs` | forward start → forward complete |
| `endToEndMs` | webhook route `receivedAtMs` → forward complete |

### Restore metrics (from `meta.lastRestoreMetrics`)

| Field | What it covers |
| ----- | -------------- |
| `sandboxCreateMs` | Vercel SDK resume latency |
| `assetSyncMs` | static + dynamic file upload |
| `startupScriptMs` | fast-restore script execution |
| `localReadyMs` | gateway readiness inside sandbox |
| `publicReadyMs` | proxy readiness from outside |
| `restoreTotalMs` | sum of all restore phases |
| `bootOverlapMs` | boot message / sandbox restore overlap |
| `skippedStaticAssetSync` | whether manifest-hash skip fired |
| `skippedDynamicConfigSync` | whether config-hash skip fired |
| `dynamicConfigReason` | `hash-match`, `hash-miss`, or `no-snapshot-hash` |

### Forward retry metrics

| Field | What it covers |
| ----- | -------------- |
| `retryingForwardAttempts` | total attempts in `forwardToNativeHandlerWithRetry` |
| `retryingForwardTotalMs` | total time spent in retry loop |

## Measurement procedure

1. Put the sandbox into a known stopped state.
2. Send a Telegram message that exercises the stopped-path wake.
3. Capture the `channels.telegram_wake_summary` log for that request.
4. Repeat at least 3 times to avoid drawing conclusions from one noisy sample.

## Output format

For each sampled wake, produce a phase table like:

| Phase | Duration (ms) | Source |
| ----- | ------------: | ------ |
| Webhook → workflow start | ? | `webhookToWorkflowMs` |
| Sandbox restore total | ? | `restoreTotalMs` |
|   ↳ sandboxCreateMs | ? | restore metrics |
|   ↳ startupScriptMs | ? | restore metrics |
|   ↳ localReadyMs | ? | restore metrics |
|   ↳ publicReadyMs | ? | restore metrics |
| Forward (with retries) | ? | `forwardMs` / `retryingForwardTotalMs` |
| End-to-end | ? | `endToEndMs` |

Then summarise:

- Median restore total across samples
- Largest single restore sub-phase
- Median forward time (including retry overhead)
- Whether `sandboxCreateMs` dominates (> 50% of `endToEndMs`)

## Decision rule

- If `sandboxCreateMs` > 50% of `endToEndMs`: stop shaving restore details and
  pivot to the **hot-spare** path (keep a warm sandbox ready for the next wake).
- If `startupScriptMs` or `localReadyMs` dominates: continue with
  fast-restore script cleanup (plan 04, branch B).
- If `assetSyncMs` dominates despite skip flags being true: investigate
  manifest-hash drift (plan 04, branch A).

## Success criteria

- At least 3 real sleeping-sandbox Telegram wakes are measured.
- Each sample includes the full `channels.telegram_wake_summary` record.
- The dominant latency bucket is identified with concrete numbers.
- The next implementation step is chosen from evidence, not guesswork.
