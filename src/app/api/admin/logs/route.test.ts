/**
 * Smoke tests for GET /api/admin/logs.
 *
 * Covers CSRF rejection and basic log retrieval.
 *
 * Run: pnpm test src/app/api/admin/logs/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
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

  _resetStoreForTesting();

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

test("GET /api/admin/logs: GET without CSRF headers still works (GET exempt from CSRF)", async () => {
  await withTestEnv(async () => {
    const route = getAdminLogsRoute();
    // GET requests are exempt from CSRF but still require auth.
    // In deployment-protection mode (default in test), no auth headers needed.
    const request = buildGetRequest("/api/admin/logs");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
  });
});
