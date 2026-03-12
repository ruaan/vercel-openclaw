/**
 * Smoke tests for GET/PUT /api/firewall.
 *
 * Covers CSRF rejection, firewall state retrieval, and mode transitions.
 *
 * Run: pnpm test src/app/api/firewall/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildAuthGetRequest,
  buildAuthPutRequest,
  buildPutRequest,
  getFirewallRoute,
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
  }
}

// ===========================================================================
// GET /api/firewall
// ===========================================================================

test("GET /api/firewall: returns current firewall state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const route = getFirewallRoute();
    const request = buildAuthGetRequest("/api/firewall");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { mode: string; allowlist: string[] };
    assert.equal(body.mode, "learning");
    assert.deepEqual(body.allowlist, ["api.openai.com"]);
  });
});

test("GET /api/firewall: returns default disabled mode", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildAuthGetRequest("/api/firewall");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { mode: string };
    assert.equal(body.mode, "disabled");
  });
});

// ===========================================================================
// PUT /api/firewall
// ===========================================================================

test("PUT /api/firewall: without CSRF headers returns 403", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "learning" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 403);
  });
});

test("PUT /api/firewall: transitions firewall mode with CSRF", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildAuthPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "learning" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 200);
    const body = result.json as { firewall: { mode: string } };
    assert.equal(body.firewall.mode, "learning");
  });
});

test("PUT /api/firewall: rejects invalid mode", async () => {
  await withTestEnv(async () => {
    const route = getFirewallRoute();
    const request = buildAuthPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "invalid" }),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 500);
  });
});
