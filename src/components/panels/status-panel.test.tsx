import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StatusPayload, RunAction } from "@/components/admin-types";

import { StatusPanel } from "./status-panel";

type LifecycleAwareStatus = StatusPayload & {
  lifecycle?: {
    restoreHistory?: unknown[];
  };
  snapshotHistory?: unknown[];
};

const CHANNELS: StatusPayload["channels"] = {
  slack: {
    configured: false,
    webhookUrl: "",
    configuredAt: null,
    team: null,
    user: null,
    botId: null,
    hasSigningSecret: false,
    hasBotToken: false,
    lastError: null,
    connectability: "unknown",
  },
  telegram: {
    configured: false,
    webhookUrl: null,
    botUsername: null,
    configuredAt: null,
    lastError: null,
    status: "disconnected",
    commandSyncStatus: "unsynced",
    commandsRegisteredAt: null,
    commandSyncError: null,
    connectability: "unknown",
  },
  discord: {
    configured: false,
    webhookUrl: "",
    applicationId: null,
    publicKey: null,
    configuredAt: null,
    appName: null,
    botUsername: null,
    endpointConfigured: false,
    endpointUrl: null,
    endpointError: null,
    commandRegistered: false,
    commandId: null,
    inviteUrl: null,
    isPublicUrl: false,
    connectability: "unknown",
  },
};

const RUN_ACTION: RunAction = async () => {};

function makeStatus(overrides: Partial<LifecycleAwareStatus> = {}): LifecycleAwareStatus {
  return {
    authMode: "admin-secret",
    storeBackend: "upstash",
    persistentStore: true,
    status: "running",
    sandboxId: "sbx-test",
    snapshotId: "snap-test",
    gatewayReady: true,
    gatewayUrl: "/gateway",
    lastError: null,
    sleepAfterMs: 300_000,
    heartbeatIntervalMs: 15_000,
    timeoutRemainingMs: 120_000,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 0,
      lastIngestedAt: null,
      learningStartedAt: null,
      commandsObserved: 0,
      wouldBlock: [],
    },
    channels: CHANNELS,
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

function renderPanel(status: LifecycleAwareStatus, pendingAction: string | null = null): string {
  return renderToStaticMarkup(
    <StatusPanel
      status={status}
      busy={pendingAction !== null}
      pendingAction={pendingAction}
      runAction={RUN_ACTION}
    />,
  );
}

test("StatusPanel renders first-run callout and create action when sandbox is uninitialized", () => {
  const html = renderPanel(
    makeStatus({
      status: "uninitialized",
      sandboxId: null,
      snapshotId: null,
      gatewayReady: false,
      timeoutRemainingMs: null,
      lifecycle: { restoreHistory: [] },
    }),
  );

  assert.ok(html.includes("Create your sandbox"));
  assert.ok(html.includes("Create Sandbox"));
  assert.ok(
    html.includes(
      "This first start creates a new sandbox and installs OpenClaw. It can take a minute the first time.",
    ),
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*>Reset Sandbox<\/button>/);
});

test("StatusPanel renders first-run setup progress detail and disables reset during setup", () => {
  const html = renderPanel(
    makeStatus({
      status: "setup",
      snapshotId: null,
      gatewayReady: false,
      lifecycle: { restoreHistory: [] },
    }),
  );

  assert.ok(html.includes("Installing OpenClaw…"));
  assert.ok(html.includes("This is the longest step on the first run."));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Reset Sandbox<\/button>/);
});

test("StatusPanel renders restore action and enabled reset when errored with a snapshot", () => {
  const html = renderPanel(
    makeStatus({
      status: "error",
      lifecycle: { restoreHistory: [{ totalMs: 1000 }] },
    }),
  );

  assert.ok(html.includes("Restore Sandbox"));
  assert.ok(html.includes("Danger zone"));
  assert.ok(html.includes("Delete the current sandbox and all saved snapshots"));
  assert.ok(!/<button[^>]*disabled=""[^>]*>Reset Sandbox<\/button>/.test(html));
  assert.match(html, /<button[^>]*>Reset Sandbox<\/button>/);
});

test("StatusPanel renders Open Gateway as the main green running action", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Save snapshot"));
  assert.ok(html.includes("Stop"));
  assert.match(html, /<a[^>]*class="button success"[^>]*>Open Gateway<\/a>/);
});
