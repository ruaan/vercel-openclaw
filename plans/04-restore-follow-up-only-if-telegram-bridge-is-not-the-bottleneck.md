# Plan 04: Restore-Internal Follow-Up (Gated on Measured Evidence)

> **This is a fallback plan, not the first implementation cycle.**
> Restore-focused changes should begin only if Plan 01 measurement shows
> `sandboxCreateMs` does not dominate end-to-end wake time, or if hot-spare
> escalation is not viable.

## What has already shipped

| Optimisation | Status |
| ------------ | ------ |
| Plans 02 + 03 (remove 5-second stabilization sleep, collapse probe + forward) | **Done** — `forwardToNativeHandlerWithRetry` replaces the old probe-then-sleep-then-forward sequence |
| Conditional `sleep 1` after `pkill` in `buildFastRestoreScript()` | **Done** — snapshot wakes skip the delay when no old gateway process exists |
| `@buape/carbon` baked into bootstrap | **Done** — peer deps installed before any snapshot is taken; restore-time npm fallback only fires on old snapshots |
| `channels.telegram_wake_summary` end-to-end log | **Done** — one structured record per stopped-path Telegram wake |

## Scope

| File | Role |
| ---- | ---- |
| `src/server/sandbox/lifecycle.ts` | Core resume flow, restore-phase timing, `lastRestoreMetrics` recording |
| `src/server/openclaw/restore-assets.ts` | Static/dynamic asset sync, manifest-based skip logic |
| `src/server/sandbox/restore-oracle.ts` | Restore-prepared orchestration, reusable-target freshness |
| `src/server/watchdog/run.ts` | Cron wake, sandbox health checks, wake-key management |

## Prerequisite

Collect a real `channels.telegram_wake_summary` sample from a sleeping-sandbox
Telegram wake. The phase breakdown must include at minimum:

- `sandboxCreateMs` (Vercel SDK resume latency)
- `assetSyncMs` (static + dynamic file upload)
- `startupScriptMs` (fast-restore script execution)
- `localReadyMs` (gateway readiness inside sandbox)
- `publicReadyMs` (proxy readiness from outside)
- `restoreTotalMs`
- `skippedStaticAssetSync` / `skippedDynamicConfigSync`
- `cronRestoreOutcome` (if wake was cron-triggered)

The dominant phase determines which branch below to pursue.

---

## Branch A: `assetSyncMs` dominates

**Diagnosis**: Static or dynamic restore assets are being uploaded on wakes that should skip them.

### Investigate

1. Check `skippedStaticAssetSync` — if `false`, the manifest SHA256 is not matching between deploys. Likely cause: asset content changed but the snapshot was taken before the new assets were synced.
2. Check `skippedDynamicConfigSync` and `dynamicConfigReason` — if `"hash-miss"` or `"no-snapshot-hash"`, the `openclaw.json` is being rewritten every wake.
3. Check `restorePreparedStatus` via restore-oracle — if frequently `"dirty"` or `"unknown"`, the oracle is not completing preparation cycles between wakes.

### Actions

- **Raise static-skip hit rate**: Ensure `snapshotAssetSha256` is recorded on every successful stop/snapshot. If the oracle prepare cycle writes new assets, it must also update the manifest hash.
- **Reduce avoidable dynamic writes**: If `dynamicConfigHash` drift is caused by non-functional changes (e.g. timestamp, nonce), pin the hash computation to only functionally significant fields.
- **Pre-stage assets during oracle prepare**: Move asset upload into the oracle's `prepareRestoreTarget()` so the resume path finds them already in place.

---

## Branch B: `startupScriptMs` or `localReadyMs` dominates

**Diagnosis**: The sandbox VM resumes quickly and assets are cached, but the gateway takes too long to start inside the sandbox.

### Investigate

1. Compare `startupScriptMs` vs `localReadyMs` — if `localReadyMs` is much larger, the fast-restore script finishes but the gateway is slow to bind.
2. Check if `openclaw` is doing a full cold start (npm install, config parse, plugin load) vs a warm restart.
3. Look at the fast-restore script for sequential steps that could overlap.
4. Check `fast_restore.gateway_reset` log — if `killed=true` and `sleepMs=1000`, the 1-second kill delay is firing on every wake (expected only when resuming a sandbox that still has a running gateway).

### Actions

- **Parallelize fast-restore steps**: If the script currently runs asset write → config write → gateway restart sequentially, evaluate running independent steps concurrently.
- **Optimize gateway restart**: If `OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH` kills and relaunches the process, check whether a lighter reload signal (e.g. SIGHUP) is supported.
- **Reduce gateway startup work**: Profile what openclaw does between process start and port bind. If plugin initialization or cron job loading is sequential, that may be addressable upstream.

---

## Branch C: `sandboxCreateMs` dominates (hot-spare escalation)

**Diagnosis**: The Vercel SDK resume latency is the single largest phase and
further host-side optimisations hit diminishing returns.

### Investigate

1. Confirm `sandboxCreateMs` > 50% of `endToEndMs` across 3+ samples.
2. Determine whether a warm-standby ("hot spare") sandbox is viable within the
   product and cost constraints.

### Actions

- **Hot-spare sandbox**: Keep a second sandbox in a warm state (running but idle),
  ready to accept forwarded payloads immediately. Swap the active sandbox on wake
  instead of waiting for resume.
- **Pros**: Eliminates `sandboxCreateMs` entirely from the wake path.
- **Cons**: Doubles sandbox cost while idle; adds complexity for metadata
  synchronisation between active and spare sandboxes.
- **Decision point**: only pursue if measurement confirms `sandboxCreateMs`
  dominates **and** the product goal explicitly targets sub-second wake latency.

---

## Branch D: Reusable restore-target miss rate is high

**Diagnosis**: Many wakes are not hitting the `restorePreparedStatus: "ready"` fast path because the oracle cannot keep the snapshot fresh between wakes.

### Investigate

1. Query `restorePreparedStatus` from metadata across recent wakes — what fraction are `"ready"` vs `"dirty"` / `"unknown"` / `"failed"`?
2. Check oracle cycle frequency vs config-change frequency. If every deploy invalidates the prepared target, the oracle can never get ahead.
3. Check whether `snapshotConfigHash` drift correlates with actual config changes or with non-functional metadata updates.

### Actions

- **Improve oracle freshness**: Trigger a prepare cycle immediately after each deploy, not just on the next watchdog tick.
- **Reduce spurious dirty transitions**: If `restorePreparedStatus` flips to `"dirty"` on metadata writes that don't affect restore config, narrow the dirty-trigger conditions.
- **Shorten oracle cycle time**: If `prepareRestoreTarget()` is slow because it does a full stop/snapshot, evaluate whether a hot snapshot (if v2 ever supports it) or incremental prepare is feasible.

---

## Excluded from this cycle

- **Keep-alive or longer sleep-time policy changes**: These are cost/product tradeoffs, not restore optimisations. Only reconsider if the product goal explicitly changes.
- **Moving full config delivery into env vars**: Documented blocker — the Sandbox API env payload limit is too small for the full base64-encoded config. Not viable without upstream API changes.

## Verification

1. Collect `channels.telegram_wake_summary` from at least 3 sleeping-sandbox Telegram wakes **before** any restore-focused change.
2. Apply the change targeting the dominant phase.
3. Collect `channels.telegram_wake_summary` from at least 3 wakes **after** the change.
4. Compare phase-by-phase timings. The targeted phase must show measurable improvement without regression in other phases.
5. Run `node scripts/verify.mjs` to confirm no functional regressions.
