# Telegram Wake-Speed Plans

The `plans/` directory already exists and holds the staged plan set for reducing
the sleeping-sandbox Telegram wake path.

## Plan order

1. `01-measure-telegram-wake-critical-path.md`
   Establish a real phase-by-phase baseline before changing the restore path.
   **Status: open** — no post-delta measurement evidence collected yet.
2. `02-remove-fixed-native-handler-stabilization-delay.md`
   Remove the guaranteed 5-second delay after the native handler first responds.
   **Status: done** — the fixed 5-second stabilization sleep is removed from the
   drain-channel workflow; the retrying forward path (`forwardToNativeHandlerWithRetry`)
   replaces the old probe-then-sleep-then-forward sequence.
3. `03-collapse-probe-and-forward-into-one-step.md`
   Remove the synthetic probe round-trip and rely on duplicate-safe forward retries.
   **Status: done** — `processChannelStep` now sends the real Telegram payload
   directly via `forwardToNativeHandlerWithRetry` with no synthetic probe.
4. `04-restore-follow-up-only-if-telegram-bridge-is-not-the-bottleneck.md`
   Only optimise restore internals if measured data shows the Telegram bridge is
   no longer the main bottleneck.
   **Status: open** — gated on fresh measurement from plan 01.

5. `05-snapshot-backed-restore-spare.md`
   Replace the placeholder hot-spare with a snapshot-backed prewarmed spare
   consumed by `restoreSandboxFromSnapshot()`.
   **Status: open** — implementation is in-tree; measurement against baseline pending.

## Post-bridge decision branch

Plans 02 and 03 collapsed the Telegram bridge overhead. The codebase now emits
`channels.telegram_wake_summary` with end-to-end wake timings plus per-phase
restore sub-timings (including `hotSpareHit`, `hotSparePromotionMs`,
`hotSpareRejectReason`).

The decision tree from here:

```
measurement (plan 01)
  │
  ├─ bridge still dominant? → revisit bridge optimisations
  │
  └─ sandboxCreateMs dominant? (expected)
       │
       ├─ YES → snapshot-backed spare (plan 05)
       │         Run: node scripts/benchmark-restore.mjs --variant=hot-spare
       │         Compare against --variant=baseline records.
       │
       └─ NO  → restore micro-optimisations (plan 04)
```

## Remaining opportunities

- **Fresh measurement** (plan 01) — collect real `channels.telegram_wake_summary`
  logs to identify which phase dominates after the bridge-side gains.
- **Fast-restore script cleanup** — `buildFastRestoreScript()` contained an
  unconditional `sleep 1` after `pkill -f openclaw.gateway`; this is now
  conditional so snapshot wakes (where no gateway process exists) skip the delay.
- **Snapshot peer-dependency bake-in** — `@buape/carbon` and other peer deps are
  installed during bootstrap (before any snapshot is taken), so restore never
  needs to run `npm install` on the wake path. The restore script retains a
  fallback for old snapshots that pre-date this change.
- **Snapshot-backed spare** (plan 05) — if `sandboxCreateMs` still dominates,
  a prewarmed spare created by the watchdog skips the `Sandbox.create()` call
  entirely on the Telegram wake path.

## Working rule

Do the plans in order. Do not start restore-focused optimisation until the
measurement plan shows the Telegram bridge is no longer the dominant wake cost,
or until the bridge-focused changes fail to hit the target latency.
Plan 05 is the first restore-side plan and requires measurement as a gate.
