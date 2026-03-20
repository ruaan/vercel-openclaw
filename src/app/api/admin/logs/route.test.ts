/**
 * Smoke tests for GET /api/admin/logs.
 *
 * Covers CSRF rejection and basic log retrieval.
 *
 * Run: npm test src/app/api/admin/logs/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import type { SandboxController, SandboxHandle } from "@/server/sandbox/controller";
import { _resetLogBuffer, logInfo } from "@/server/log";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildAuthGetRequest,
  buildGetRequest,
  getAdminLogsRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "ADMIN_SECRET",
    "SESSION_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

  _resetStoreForTesting();
  _resetLogBuffer();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    _resetLogBuffer();
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  }
}

// ===========================================================================
// GET /api/admin/logs
// ===========================================================================

test("GET /api/admin/logs: returns logs array", async () => {
  await withTestEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: unknown[] };
    assert.ok(Array.isArray(body.logs), "should return logs array");
  });
});

test("GET /api/admin/logs: supports level filter parameter", async () => {
  await withTestEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?level=error");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: unknown[] };
    assert.ok(Array.isArray(body.logs), "should return filtered logs");
  });
});

test("GET /api/admin/logs: supports source filter parameter", async () => {
  await withTestEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?source=lifecycle");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: unknown[] };
    assert.ok(Array.isArray(body.logs), "should return filtered logs");
  });
});

test("GET /api/admin/logs: GET with bearer token but without CSRF headers still works", async () => {
  await withTestEnv(async () => {
    const route = getAdminLogsRoute();
    // GET requests are exempt from CSRF but still require admin auth (bearer token).
    const request = buildGetRequest("/api/admin/logs", {
      authorization: "Bearer test-admin-secret-for-scenarios",
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
  });
});

test("GET /api/admin/logs: sandbox log parsing prefers top-level source over ctx.source", async () => {
  await withTestEnv(async () => {
    const sandboxController: SandboxController = {
      async create() {
        throw new Error("not implemented in this test");
      },
      async get() {
        return {
          sandboxId: "sandbox-123",
          get timeout() { return 1800000; },
          async runCommand() {
            return {
              exitCode: 0,
              output: async () =>
                JSON.stringify({
                  ts: "2026-03-13T16:00:00.000Z",
                  level: "info",
                  source: "firewall",
                  msg: "source-precedence-test",
                  ctx: { source: "system", requestId: "req-top-level-source" },
                }),
            };
          },
          async writeFiles() {},
          domain() {
            return "https://sandbox-123.fake.vercel.run";
          },
          async snapshot() {
            return { snapshotId: "snap-123" };
          },
          async extendTimeout() {},
          async updateNetworkPolicy() {
            return "allow-all";
          },
          async readFileToBuffer() { return null; },
        } satisfies SandboxHandle;
      },
    };

    _setSandboxControllerForTesting(sandboxController);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sandbox-123";
    });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?source=firewall&search=source-precedence-test");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      logs: Array<{ source: string; message: string; data?: { requestId?: string } }>;
    };
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0]?.source, "firewall");
    assert.equal(body.logs[0]?.message, "source-precedence-test");
    assert.equal(body.logs[0]?.data?.requestId, "req-top-level-source");
  });
});

// ===========================================================================
// GET /api/admin/logs — structured correlation filters
// ===========================================================================

test("GET /api/admin/logs: filters by opId", async () => {
  await withTestEnv(async () => {
    logInfo("channels.wake_requested", { opId: "op_abc123", channel: "slack" });
    logInfo("channels.gateway_request_started", { opId: "op_abc123", channel: "slack" });
    logInfo("channels.wake_requested", { opId: "op_other", channel: "telegram" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?opId=op_abc123");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: Array<{ message: string; data?: { opId?: string } }> };
    assert.equal(body.logs.length, 2);
    for (const log of body.logs) {
      assert.equal(log.data?.opId, "op_abc123");
    }
  });
});

test("GET /api/admin/logs: opId filter also matches parentOpId", async () => {
  await withTestEnv(async () => {
    logInfo("sandbox.restore.started", { opId: "op_child", parentOpId: "op_parent" });
    logInfo("channels.wake_requested", { opId: "op_parent" });
    logInfo("channels.unrelated", { opId: "op_unrelated" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?opId=op_parent");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: Array<{ data?: { opId?: string; parentOpId?: string } }> };
    assert.equal(body.logs.length, 2);
  });
});

test("GET /api/admin/logs: filters by channel", async () => {
  await withTestEnv(async () => {
    logInfo("channels.delivery_success", { channel: "slack", opId: "op_1" });
    logInfo("channels.delivery_success", { channel: "telegram", opId: "op_2" });
    logInfo("channels.delivery_success", { channel: "discord", opId: "op_3" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?channel=slack");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: Array<{ data?: { channel?: string } }> };
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0]?.data?.channel, "slack");
  });
});

test("GET /api/admin/logs: filters by requestId", async () => {
  await withTestEnv(async () => {
    logInfo("channels.wake_requested", { requestId: "req-abc", opId: "op_1" });
    logInfo("channels.wake_requested", { requestId: "req-def", opId: "op_2" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?requestId=req-abc");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: Array<{ data?: { requestId?: string } }> };
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0]?.data?.requestId, "req-abc");
  });
});

test("GET /api/admin/logs: filters by sandboxId", async () => {
  await withTestEnv(async () => {
    logInfo("sandbox.restore.started", { sandboxId: "sbx_123", opId: "op_1" });
    logInfo("sandbox.restore.started", { sandboxId: "sbx_456", opId: "op_2" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?sandboxId=sbx_123");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: Array<{ data?: { sandboxId?: string } }> };
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0]?.data?.sandboxId, "sbx_123");
  });
});

test("GET /api/admin/logs: filters by messageId", async () => {
  await withTestEnv(async () => {
    logInfo("channels.queue_consumer_received", { messageId: "vq_111", channel: "slack" });
    logInfo("channels.queue_consumer_received", { messageId: "vq_222", channel: "telegram" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?messageId=vq_111");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: Array<{ data?: { messageId?: string } }> };
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0]?.data?.messageId, "vq_111");
  });
});

test("GET /api/admin/logs: combines channel and opId filters", async () => {
  await withTestEnv(async () => {
    logInfo("channels.wake_requested", { opId: "op_combo", channel: "slack" });
    logInfo("channels.gateway_request_started", { opId: "op_combo", channel: "slack" });
    logInfo("channels.wake_requested", { opId: "op_combo", channel: "telegram" });
    logInfo("channels.wake_requested", { opId: "op_other", channel: "slack" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?opId=op_combo&channel=slack");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: Array<{ data?: { opId?: string; channel?: string } }> };
    assert.equal(body.logs.length, 2);
    for (const log of body.logs) {
      assert.equal(log.data?.opId, "op_combo");
      assert.equal(log.data?.channel, "slack");
    }
  });
});

test("GET /api/admin/logs: ignores invalid channel param", async () => {
  await withTestEnv(async () => {
    logInfo("channels.wake_requested", { channel: "slack", opId: "op_1" });

    const route = getAdminLogsRoute();
    const request = buildAuthGetRequest("/api/admin/logs?channel=invalid");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { logs: unknown[] };
    // Invalid channel is ignored, so all logs are returned
    assert.ok(body.logs.length >= 1);
  });
});
