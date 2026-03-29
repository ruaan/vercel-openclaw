# API Reference

## Machine-readable operations surfaces

- `GET /api/admin/preflight` returns a `PreflightPayload` with `checks`, `actions`, `nextSteps`, and per-channel readiness.
- `GET /api/admin/launch-verify` returns persisted `ChannelReadiness` for the current deployment.
- `POST /api/admin/launch-verify` returns `LaunchVerificationPayload & { channelReadiness: ChannelReadiness }`. Send `Accept: application/x-ndjson` to stream phase events (`LaunchVerificationStreamEvent`) for automation.
- When streaming with `Accept: application/x-ndjson`, the terminal `result` event carries the same extended payload including `channelReadiness`.
- `GET /api/admin/watchdog` returns the cached `WatchdogReport`; `POST /api/admin/watchdog` runs a fresh check. Each report contains `WatchdogCheck` entries.

`channelReadiness.ready` is only true after destructive launch verification passes the full `preflight` → `queuePing` → `ensureRunning` → `chatCompletions` → `wakeFromSleep` → `restorePrepared` path for the current deployment.

### Verification mode contract

There are three different verification surfaces and they are not interchangeable:

- `GET /api/admin/preflight` is config-only. It never touches the sandbox.
- `POST /api/admin/launch-verify` in **safe** mode runs `preflight`, `queuePing`, `ensureRunning`, and `chatCompletions`.
- `POST /api/admin/launch-verify` in **destructive** mode runs everything in safe mode, then adds `wakeFromSleep` and `restorePrepared`.

Automation should not treat safe mode as equivalent to `--preflight-only`. Safe mode is runtime verification. Preflight-only is not.

### Example safe-mode `POST /api/admin/launch-verify` response

```json
{
  "ok": true,
  "mode": "safe",
  "phases": [
    { "id": "preflight", "status": "pass" },
    { "id": "queuePing", "status": "pass" },
    { "id": "ensureRunning", "status": "pass" },
    { "id": "chatCompletions", "status": "pass" },
    { "id": "wakeFromSleep", "status": "skip" },
    { "id": "restorePrepared", "status": "skip" }
  ]
}
```

### Example destructive `POST /api/admin/launch-verify` response

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
    { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." },
    { "id": "restorePrepared", "status": "pass", "durationMs": 4500, "message": "Restore target sealed and verified." }
  ],
  "runtime": {
    "packageSpec": "openclaw@1.2.3",
    "installedVersion": "1.2.3",
    "drift": false,
    "expectedConfigHash": "abc123",
    "lastRestoreConfigHash": "abc123",
    "dynamicConfigVerified": true,
    "dynamicConfigReason": "hash-match",
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared",
    "snapshotDynamicConfigHash": "abc123",
    "runtimeDynamicConfigHash": "abc123",
    "snapshotAssetSha256": "def456",
    "runtimeAssetSha256": "def456",
    "restoreAttestation": {
      "reusable": true,
      "needsPrepare": false,
      "reasons": []
    },
    "restorePlan": {
      "schemaVersion": 1,
      "status": "ready",
      "blocking": false,
      "reasons": [],
      "actions": []
    }
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
      { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." },
      { "id": "restorePrepared", "status": "pass", "durationMs": 4500, "message": "Restore target sealed and verified." }
    ]
  }
}
```

`warningChannelIds` is deprecated — kept only for backward compatibility. New automation should consume `failingChannelIds`.

### Diagnostics compatibility note

`diagnostics.warningChannelIds` is a deprecated compatibility field. It carries the same channel IDs as `diagnostics.failingChannelIds`.

Use `diagnostics.failingChannelIds` in new automation. Only keep reading `warningChannelIds` if you still need backward compatibility with older consumers.

Example diagnostics block when preflight finds a blocking channel issue:

```json
{
  "diagnostics": {
    "blocking": true,
    "failingCheckIds": ["public-origin"],
    "requiredActionIds": ["configure-public-origin"],
    "recommendedActionIds": [],
    "warningChannelIds": ["telegram"],
    "failingChannelIds": ["telegram"],
    "skipPhaseIds": ["queuePing", "ensureRunning", "chatCompletions", "wakeFromSleep", "restorePrepared"]
  }
}
```

Both arrays always carry the same IDs. `warningChannelIds` exists solely so older automation that reads it keeps working.

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

### Restore-readiness fields

Newer launch verification payloads expose restore-target readiness, not just "can the sandbox answer right now." These fields explain whether the current deployment has a reusable restore target and what action is still needed when it does not.

- `runtime.restorePreparedStatus` — `unknown`, `dirty`, `preparing`, `ready`, or `failed`
- `runtime.restorePreparedReason` — why the status is what it is (e.g. `prepared`, `dynamic-config-changed`, `snapshot-missing`)
- `runtime.snapshotDynamicConfigHash` — config hash baked into the current snapshot
- `runtime.runtimeDynamicConfigHash` — config hash the running deployment wants
- `runtime.snapshotAssetSha256` — static asset hash in the snapshot
- `runtime.runtimeAssetSha256` — static asset hash the running deployment expects
- `runtime.restoreAttestation` — machine-readable attestation of whether the snapshot is reusable
- `runtime.restorePlan` — action plan for making the restore target ready

Example restore-readiness payload:

```json
{
  "runtime": {
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared",
    "restoreAttestation": {
      "reusable": true,
      "needsPrepare": false,
      "reasons": []
    },
    "restorePlan": {
      "schemaVersion": 1,
      "status": "ready",
      "blocking": false,
      "reasons": [],
      "actions": []
    }
  }
}
```

See [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) for a plain-English explanation of restore-prepared state.

### Example blocked channel connect response

All channel credential-save routes (`PUT /api/channels/slack`, `PUT /api/channels/telegram`, `PUT /api/channels/discord`, `PUT /api/channels/whatsapp`) return HTTP 409 with the same envelope when deployment prerequisites are still failing.

Sample request outcome: `PUT /api/channels/telegram` while the deployment cannot resolve a public webhook origin.

```json
{
  "error": {
    "code": "CHANNEL_CONNECT_BLOCKED",
    "message": "Cannot connect telegram until deployment blockers are resolved."
  },
  "connectability": {
    "channel": "telegram",
    "mode": "webhook-proxied",
    "canConnect": false,
    "status": "fail",
    "webhookUrl": null,
    "issues": [
      {
        "id": "public-origin",
        "status": "fail",
        "message": "Could not resolve a canonical public origin for Telegram.",
        "remediation": "Deploy to Vercel so the app gets a public URL automatically, or set NEXT_PUBLIC_APP_URL to your custom domain.",
        "env": ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_BASE_DOMAIN", "BASE_DOMAIN"]
      }
    ]
  }
}
```

`connectability.webhookUrl` is an operator-visible display URL. It uses `buildPublicDisplayUrl()` internally and must never expose the deployment protection bypass secret. When the public origin cannot be resolved, the field is `null`.

### `GET /api/status`

The main operator summary endpoint. Returns the current sandbox state, gateway readiness, timeout information, firewall policy, channel config, and restore-target health in a single response.

#### Cached vs live mode

- **`GET /api/status`** — returns cached gateway readiness from the last probe and an **estimated** timeout based on `lastAccessedAt` plus the configured sleep window. This is cheap and does not touch the sandbox.
- **`GET /api/status?health=1`** — performs a **live** gateway probe against the sandbox, queries the Sandbox SDK for the real timeout, and persists the probe result for future cached reads. Use this when you need to know the actual current state rather than a best-guess estimate.

The `timeoutSource` field tells you which mode produced the response:

| `timeoutSource` | Meaning |
| --- | --- |
| `estimated` | Timeout was calculated from `lastAccessedAt` + `sleepAfterMs`. The sandbox may have already timed out. |
| `live` | Timeout was read from the Sandbox SDK during this request. This is the ground truth. |
| `none` | Timeout information is not available (sandbox is not running). |

When the cached path estimates that the timeout has already elapsed and the metadata still says `running`, the endpoint automatically reconciles: it queries the Sandbox SDK for the real status and updates the stored metadata before responding. This means even the cached path self-corrects stale "running" states.

#### Key response fields

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | Sandbox lifecycle status: `uninitialized`, `creating`, `setup`, `booting`, `running`, `stopped`, `restoring`, `error` |
| `sandboxId` | string \| null | Current sandbox ID, if one exists |
| `snapshotId` | string \| null | Current snapshot ID used for restores |
| `gatewayReady` | boolean | Whether the gateway is responding (derived from `gatewayStatus`) |
| `gatewayStatus` | string | `ready`, `not-ready`, or `unknown` |
| `gatewayCheckedAt` | number \| null | Unix timestamp (ms) of the last gateway probe result |
| `timeoutRemainingMs` | number \| null | Milliseconds until the sandbox sleeps, or `null` when unknown |
| `timeoutSource` | string | `estimated`, `live`, or `none` — how the timeout was determined |
| `sleepAfterMs` | number | Configured sandbox sleep window in milliseconds |
| `heartbeatIntervalMs` | number | How often the UI sends heartbeat POSTs to keep the sandbox alive |
| `restoreTarget` | object | Restore-readiness assessment (see below) |
| `setupProgress` | object \| null | Present only during `creating`, `setup`, `booting`, or `error` states |

The `restoreTarget` object contains:

- `restorePreparedStatus` — `unknown`, `dirty`, `preparing`, `ready`, or `failed`
- `restorePreparedReason` — why the status is what it is (e.g. `prepared`, `dynamic-config-changed`)
- `attestation` — machine-readable check of whether the current snapshot is reusable
- `plan` — what action the app thinks should happen next to make the restore target ready

Read `attestation.reusable` and `plan.blocking` together: if the attestation says the snapshot is reusable and the plan is not blocking, the next restore will be fast and clean. If `attestation.reusable` is `false`, check `attestation.reasons` for what changed.

#### Example: `GET /api/status?health=1`

```json
{
  "authMode": "admin-secret",
  "storeBackend": "upstash",
  "persistentStore": true,
  "status": "running",
  "sandboxId": "sbx_123",
  "snapshotId": "snap_456",
  "gatewayReady": true,
  "gatewayStatus": "ready",
  "gatewayCheckedAt": 1760000000000,
  "gatewayUrl": "/gateway",
  "lastError": null,
  "lastKeepaliveAt": 1759999950000,
  "sleepAfterMs": 1800000,
  "heartbeatIntervalMs": 300000,
  "timeoutRemainingMs": 1420000,
  "timeoutSource": "live",
  "firewall": {
    "mode": "learning",
    "learnedDomains": ["api.openai.com"],
    "wouldBlock": []
  },
  "restoreTarget": {
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared",
    "restorePreparedAt": 1759999000000,
    "snapshotDynamicConfigHash": "abc123",
    "runtimeDynamicConfigHash": "abc123",
    "snapshotAssetSha256": "def456",
    "runtimeAssetSha256": "def456",
    "attestation": {
      "reusable": true,
      "needsPrepare": false,
      "reasons": []
    },
    "plan": {
      "schemaVersion": 1,
      "status": "ready",
      "blocking": false,
      "reasons": [],
      "actions": []
    },
    "oracle": null
  },
  "lifecycle": {
    "lastRestoreMetrics": null,
    "restoreHistory": [],
    "lastTokenRefreshAt": null,
    "lastTokenSource": null,
    "lastTokenExpiresAt": null,
    "lastTokenRefreshError": null,
    "consecutiveTokenRefreshFailures": 0,
    "breakerOpenUntil": null
  },
  "setupProgress": null
}
```

When `timeoutSource` is `estimated` instead of `live`, `timeoutRemainingMs` is a best-effort calculation. If you need to make decisions based on the timeout (e.g. whether to snapshot before sleep), use `?health=1`.

#### `POST /api/status`

The heartbeat endpoint. The admin UI calls this periodically to keep the sandbox alive. Returns `{ ok: true, status: "<current status>" }`. Calling this extends the sandbox timeout by touching the `lastAccessedAt` timestamp.

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
