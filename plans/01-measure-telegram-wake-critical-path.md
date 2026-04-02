# Plan 01: Measure Telegram Wake Critical Path First

## Goal

Establish a real baseline for the sleeping-sandbox Telegram wake path before
changing restore logic. The objective is to answer one question with evidence:

> Is wake latency dominated by sandbox restore work, or by the Telegram-native
> bridge path that runs after the sandbox is already reachable?

Without this baseline, later changes risk optimizing the wrong phase.

## Why this comes first

The stopped-path currently includes at least three distinct latency buckets:

1. **Sandbox resume / restore**: Vercel resume, asset sync, startup script,
   local readiness, public readiness, and firewall sync.
2. **Workflow bridge delay**: `drain-channel-workflow.ts` waits for the native
   Telegram handler and currently adds a fixed 5-second stabilization sleep.
3. **Real payload forward**: the actual webhook delivery from the workflow to
   `/telegram-webhook`.

Plans 02 and 03 only make sense if bucket 2 is large enough to matter. This
plan captures the evidence needed to decide that.

## What to measure

Capture one complete sleeping-sandbox Telegram wake from the moment the webhook
route receives the Telegram update until the native forward finishes.

### Restore metrics already available

From `meta.lastRestoreMetrics` in `src/server/sandbox/lifecycle.ts`:

- `sandboxCreateMs`
- `assetSyncMs`
- `startupScriptMs`
- `localReadyMs`
- `publicReadyMs`
- `firewallSyncMs`
- `totalMs`
- `skippedStaticAssetSync`
- `skippedDynamicConfigSync`
- `dynamicConfigReason`
- `cronRestoreOutcome`

These cover the restore side of the wake.

### Telegram bridge timestamps to add or extract

From `src/server/workflows/channels/drain-channel-workflow.ts`, capture:

- Time from `channels.workflow_sandbox_ready` to `channels.native_handler_ready`
- Time spent in the fixed 5-second stabilization sleep
- Time from `channels.native_handler_ready` to
  `channels.workflow_native_forward_result`
- Count of native-handler probe attempts before first success
- Native forward status code

If these timestamps are not emitted today with enough precision, add temporary
structured logs around the probe loop and forward call. The logs should be
designed to survive implementation, not debug-only console noise.

## Measurement procedure

1. Put the sandbox into a known sleeping/stopped state.
2. Send a Telegram message that exercises the stopped-path wake.
3. Capture the full log sequence for that request, keyed by `requestId` if
   available.
4. Record the matching `lastRestoreMetrics` payload after the wake completes.
5. Repeat at least 3 times to avoid drawing conclusions from one noisy sample.

## Output format

For each sampled wake, produce a phase table like:

| Phase | Duration (ms) | Source |
| ---- | ----: | ---- |
| Webhook received -> workflow start | ? | route/workflow logs |
| Sandbox restore total | ? | `lastRestoreMetrics.totalMs` |
| Sandbox ready -> native handler ready | ? | workflow logs |
| Native handler stabilization sleep | 5000 | workflow code/logs |
| Native forward | ? | workflow logs |
| End-to-end webhook -> native forward complete | ? | combined |

Then summarize:

- Median restore total across samples
- Median bridge delay across samples
- Largest single sub-phase
- Recommendation: proceed with Plan 02/03 first, or pivot to restore work

## Decision rule

Proceed to Plans 02 and 03 first if either of these is true:

- The fixed 5-second stabilization sleep is a material share of end-to-end wake
  time.
- The post-restore Telegram bridge path is slower than any individual restore
  sub-phase.

Defer restore-focused work until later unless the data shows restore phases
still dominate even after accounting for the bridge delay.

## Success criteria

- At least 3 real sleeping-sandbox Telegram wakes are measured.
- Each sample includes both `lastRestoreMetrics` and workflow bridge timing.
- The dominant latency bucket is identified with concrete numbers.
- The next implementation step is chosen from evidence, not guesswork.
