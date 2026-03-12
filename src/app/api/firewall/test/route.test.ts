/**
 * Smoke tests for POST /api/firewall/test.
 *
 * Covers domain testing against different firewall modes.
 *
 * Run: pnpm test src/app/api/firewall/test/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildAuthPostRequest,
  getFirewallTestRoute,
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
// POST /api/firewall/test
// ===========================================================================

test("POST /api/firewall/test: domain allowed when firewall disabled", async () => {
  await withTestEnv(async () => {
    const route = getFirewallTestRoute();
    const request = buildAuthPostRequest(
      "/api/firewall/test",
      JSON.stringify({ domain: "example.com" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      allowed: boolean;
      reason: string;
      domain: string;
      mode: string;
    };
    assert.equal(body.allowed, true);
    assert.equal(body.domain, "example.com");
    assert.equal(body.mode, "disabled");
  });
});

test("POST /api/firewall/test: domain allowed in learning mode", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
    });

    const route = getFirewallTestRoute();
    const request = buildAuthPostRequest(
      "/api/firewall/test",
      JSON.stringify({ domain: "anything.org" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { allowed: boolean; mode: string };
    assert.equal(body.allowed, true);
    assert.equal(body.mode, "learning");
  });
});

test("POST /api/firewall/test: domain blocked in enforcing mode when not in allowlist", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const route = getFirewallTestRoute();
    const request = buildAuthPostRequest(
      "/api/firewall/test",
      JSON.stringify({ domain: "evil.com" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { allowed: boolean; domain: string };
    assert.equal(body.allowed, false);
    assert.equal(body.domain, "evil.com");
  });
});

test("POST /api/firewall/test: domain allowed in enforcing mode when in allowlist", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const route = getFirewallTestRoute();
    const request = buildAuthPostRequest(
      "/api/firewall/test",
      JSON.stringify({ domain: "api.openai.com" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { allowed: boolean; domain: string };
    assert.equal(body.allowed, true);
    assert.equal(body.domain, "api.openai.com");
  });
});

test("POST /api/firewall/test: returns error for missing domain", async () => {
  await withTestEnv(async () => {
    const route = getFirewallTestRoute();
    const request = buildAuthPostRequest(
      "/api/firewall/test",
      JSON.stringify({}),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 500);
  });
});
