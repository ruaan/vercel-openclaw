# API Reference

## Machine-readable operations surfaces

- `GET /api/admin/preflight` returns a `PreflightPayload` with `checks`, `actions`, `nextSteps`, and per-channel readiness.
- `GET /api/admin/launch-verify` returns persisted `ChannelReadiness` for the current deployment.
- `POST /api/admin/launch-verify` returns `LaunchVerificationPayload & { channelReadiness: ChannelReadiness }`. Send `Accept: application/x-ndjson` to stream phase events (`LaunchVerificationStreamEvent`) for automation.
- When streaming with `Accept: application/x-ndjson`, the terminal `result` event carries the same extended payload including `channelReadiness`.
- `GET /api/admin/watchdog` returns the cached `WatchdogReport`; `POST /api/admin/watchdog` runs a fresh check. Each report contains `WatchdogCheck` entries.

`channelReadiness.ready` is only true after destructive launch verification passes the full `preflight` → `queuePing` → `ensureRunning` → `chatCompletions` → `wakeFromSleep` path for the current deployment.

### Example `POST /api/admin/launch-verify` response

Destructive mode, all phases passing:

```json
{
  "ok": true,
  "mode": "destructive",
  "startedAt": "2026-03-24T08:00:00.000Z",
  "completedAt": "2026-03-24T08:01:10.000Z",
  "phases": [
    { "id": "preflight", "status": "pass", "durationMs": 120, "message": "All 8 config checks passed." },
    { "id": "queuePing", "status": "pass", "durationMs": 840, "message": "Vercel Queue delivered callback msg_123." },
    { "id": "ensureRunning", "status": "pass", "durationMs": 41200, "message": "Sandbox started and gateway ready." },
    { "id": "chatCompletions", "status": "pass", "durationMs": 910, "message": "Gateway replied with exact text: launch-verify-ok" },
    { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." }
  ],
  "runtime": {
    "packageSpec": "openclaw@1.2.3",
    "installedVersion": "1.2.3",
    "drift": false,
    "expectedConfigHash": "abc123",
    "lastRestoreConfigHash": "abc123",
    "dynamicConfigVerified": true,
    "dynamicConfigReason": "hash-match"
  },
  "sandboxHealth": {
    "repaired": false,
    "configReconciled": true,
    "configReconcileReason": "already-fresh"
  },
  "diagnostics": {
    "blocking": false,
    "failingCheckIds": [],
    "requiredActionIds": [],
    "recommendedActionIds": [],
    "warningChannelIds": [],
    "failingChannelIds": [],
    "skipPhaseIds": []
  },
  "channelReadiness": {
    "deploymentId": "dpl_123",
    "ready": true,
    "verifiedAt": "2026-03-24T08:01:10.000Z",
    "mode": "destructive",
    "wakeFromSleepPassed": true,
    "failingPhaseId": null,
    "phases": [
      { "id": "preflight", "status": "pass", "durationMs": 120, "message": "All 8 config checks passed." },
      { "id": "queuePing", "status": "pass", "durationMs": 840, "message": "Vercel Queue delivered callback msg_123." },
      { "id": "ensureRunning", "status": "pass", "durationMs": 41200, "message": "Sandbox started and gateway ready." },
      { "id": "chatCompletions", "status": "pass", "durationMs": 910, "message": "Gateway replied with exact text: launch-verify-ok" },
      { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." }
    ]
  }
}
```

`warningChannelIds` is deprecated — kept only for backward compatibility. New automation should consume `failingChannelIds`.

### Launch verification fields that matter to automation

`POST /api/admin/launch-verify` exposes more than phase pass/fail:

- `runtime.expectedConfigHash` — hash derived from the current channel/runtime config.
- `runtime.lastRestoreConfigHash` — hash recorded during the most recent restore.
- `runtime.dynamicConfigVerified` — `true` when those hashes match, `false` when they drift, `null` when no restore hash is available yet.
- `runtime.dynamicConfigReason` — one of `hash-match`, `hash-miss`, or `no-snapshot-hash`.
- `sandboxHealth.repaired` — whether launch verification had to recover sandbox health.
- `sandboxHealth.configReconciled` — whether stale runtime config was reconciled successfully.
- `sandboxHealth.configReconcileReason` — one of `already-fresh`, `rewritten-and-restarted`, `rewrite-failed`, `restart-failed`, `sandbox-unavailable`, `error`, or `skipped`.

Automation should treat `payload.ok=false` as authoritative even when the main runtime phases look healthy, because stale dynamic config that could not be reconciled is a hard failure.

## Structured output contracts

### `node scripts/verify.mjs`

- Emits JSON Lines to stdout.
- Human-readable child process output goes to stderr.
- Event names: `verify.start`, `verify.step.start`, `verify.step.finish`, `verify.summary`, `verify.config_error`, `verify.fatal`.

Example output:

```jsonl
{"event":"verify.start","timestamp":"2026-03-24T08:00:00.000Z","ok":true,"root":"/repo","steps":["contract","lint","test","typecheck","build"],"pathIncludesNodeModulesBin":true}
{"event":"verify.step.start","timestamp":"2026-03-24T08:00:00.100Z","step":"contract","command":"node scripts/check-verifier-contract.mjs"}
{"event":"verify.step.finish","timestamp":"2026-03-24T08:00:01.200Z","step":"contract","ok":true,"exitCode":0,"durationMs":1100,"signal":null}
{"event":"verify.summary","timestamp":"2026-03-24T08:00:42.000Z","ok":true,"results":[{"step":"contract","exitCode":0},{"step":"lint","exitCode":0},{"step":"test","exitCode":0},{"step":"typecheck","exitCode":0},{"step":"build","exitCode":0}]}
```

### `node scripts/check-deploy-readiness.mjs`

Primary remote readiness gate for deployed instances.

Exit codes: `0` = pass, `1` = contract-fail, `2` = bad-args, `3` = fetch-fail, `4` = bad-response.

Example usage:

```bash
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --mode destructive --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --auth-cookie "$SMOKE_AUTH_COOKIE" --preflight-only --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" --json-only
```

## Verification behavior that is easy to miss

- `node scripts/verify.mjs` runs `node scripts/check-queue-consumers.mjs` before the `test` step whenever `test` is included in `--steps`. Expect `verify.step.start` / `verify.step.finish` events for `queue-consumers`.
- `node scripts/check-deploy-readiness.mjs` regenerates `src/app/api/auth/protected-route-manifest.json` before calling `/api/admin/launch-verify` and includes `bootstrapExposure` in the JSON result. A stale manifest or any unauthenticated admin/firewall route is a contract failure.
- On Deployment Protection-enabled deployments, pass `--protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` so automation can reach the app.
