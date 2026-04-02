# Plan 05 — Snapshot-Backed Restore Spare

## Goal

Eliminate `sandboxCreateMs` from the Telegram stopped-path wake by promoting a
prewarmed snapshot-backed spare instead of calling `Sandbox.create()` on the
request path.

## Status: open

Implementation is in-tree but measurement against the current baseline is
required before declaring this the winning strategy.

## What exists today

| Component | File | State |
| --- | --- | --- |
| `HotSpareState` metadata | `src/shared/types.ts` | Includes `candidateSourceSnapshotId`, `candidateDynamicConfigHash`, `candidateAssetSha256` |
| `preCreateHotSpareFromSnapshot()` | `src/server/sandbox/hot-spare.ts` | Creates a spare from the active snapshot with freshness gates |
| `evaluateHotSparePromotion()` | `src/server/sandbox/hot-spare.ts` | Checks snapshot ID, dynamic config hash, and asset hash match |
| `promoteHotSpare()` | `src/server/sandbox/hot-spare.ts` | Promotes candidate to active sandbox |
| `prepareHotSpareFromPreparedRestore()` | `src/server/sandbox/lifecycle.ts` | Lifecycle helper called after oracle prepare |
| Watchdog integration | `src/server/watchdog/run.ts` | Calls spare prep after successful oracle prepare |
| Restore-path consumption | `src/server/sandbox/lifecycle.ts` | `restoreSandboxFromSnapshot()` checks spare before `Sandbox.create()` |
| Telemetry | `drain-channel-workflow.ts` | `telegram_wake_summary` includes `hotSpareHit`, `hotSparePromotionMs`, `hotSpareRejectReason` |
| `RestorePhaseMetrics` | `src/shared/types.ts` | Includes `hotSpareHit`, `hotSparePromotionMs`, `hotSpareRejectReason` |

Feature-gated behind `OPENCLAW_HOT_SPARE_ENABLED=true` (all functions no-op when disabled).

## Required telemetry

The following structured logs must be present for comparison:

- `sandbox.restore.hot_spare_considered` — logged on every restore, shows decision reason
- `sandbox.restore.hot_spare_promoted` — logged on successful promotion
- `sandbox.restore.hot_spare_promotion_failed` — logged on promotion failure
- `channels.telegram_wake_summary` — includes hot-spare fields alongside all restore sub-phases

## Comparison procedure

### 1. Collect baseline

```bash
node scripts/benchmark-restore.mjs \
  --base-url https://my-app.vercel.app \
  --cycles 5 \
  --variant baseline \
  --format json > baseline.jsonl
```

The deployment must have `OPENCLAW_HOT_SPARE_ENABLED` unset or `false`.

### 2. Collect hot-spare variant

Enable the feature flag on the deployment:

```
OPENCLAW_HOT_SPARE_ENABLED=true
```

Wait for at least one watchdog cycle so a spare is prepared, then:

```bash
node scripts/benchmark-restore.mjs \
  --base-url https://my-app.vercel.app \
  --cycles 5 \
  --variant hot-spare \
  --format json > hot-spare.jsonl
```

### 3. Compare

Key fields to compare across JSONL records:

| Field | Baseline (expected) | Hot-spare hit (expected) |
| --- | --- | --- |
| `sandboxCreateMs` | 3000–8000ms | ~0ms |
| `hotSpareHit` | `null` or `false` | `true` |
| `hotSparePromotionMs` | `0` | 200–500ms |
| `totalMs` | baseline | baseline minus sandboxCreateMs |
| `hotSpareRejectReason` | `null` | `null` on hit |

A successful result shows `sandboxCreateMs ≈ 0` and `totalMs` dropping by
roughly the baseline `sandboxCreateMs` value.

### 4. Decision gate

- If p50 `totalMs` drops by ≥ 2 seconds with hot-spare: **adopt as default strategy**.
- If hot-spare misses dominate (snapshot/config/asset mismatch): investigate
  freshness propagation before re-measuring.
- If `sandboxCreateMs` is already small (< 1.5s): the spare overhead may not
  justify the resource cost — consider closing this plan.

## Risks

- **Resource cost**: a spare sandbox consumes vCPU time while idle. The spare
  should be created with the same `timeout` as the production sandbox so it
  auto-stops if unused.
- **Freshness staleness**: if config or assets change between spare creation and
  wake, the spare is rejected. The watchdog must re-prepare after config changes.
- **Quota pressure**: two persistent sandboxes exist simultaneously during the
  spare window. Verify this stays within account sandbox limits.

## Non-goals

- Bun runtime migration (latent opportunity, off-goal until spare is proven)
- Multi-sandbox support (this is a single-instance app)
- Hot-spare for the create path (only the snapshot restore path matters for wake)
