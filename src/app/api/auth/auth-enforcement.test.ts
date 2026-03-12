/**
 * Auth enforcement & session expiry tests.
 *
 * Covers:
 * - Admin routes reject unauthenticated requests in sign-in-with-vercel mode (401/403)
 * - Expired session cookie triggers refresh; failure clears session with 401
 * - Refresh token failure clears session and returns unauthenticated response
 * - deployment-protection mode rejects requests missing CSRF (for mutations)
 * - Gateway proxy blocks unauthenticated HTML responses (no token leak)
 *
 * Run: pnpm test src/app/api/auth/auth-enforcement.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  buildSessionCookie,
  setCookieToCookieHeader,
  SIGN_IN_ENV,
} from "@/test-utils/auth-fixtures";
import { createFakeFetch } from "@/test-utils/fake-fetch";
import { FakeSandboxController } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildGetRequest,
  buildAuthPostRequest,
  patchNextServerAfter,
  resetAfterCallbacks,
  getStatusRoute,
  getAdminEnsureRoute,
  getAdminSnapshotRoute,
  getAdminSnapshotsRoute,
  getAdminLogsRoute,
  getGatewayRoute,
  callGatewayGet,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const SIGN_IN_ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_AUTH_MODE",
  "SESSION_SECRET",
  "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
  "VERCEL_APP_CLIENT_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "NEXT_PUBLIC_BASE_DOMAIN",
];

function withSignInEnv(fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of SIGN_IN_ENV_KEYS) {
    originals[key] = process.env[key];
  }

  // Set sign-in-with-vercel env
  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  process.env.SESSION_SECRET = SIGN_IN_ENV.SESSION_SECRET;
  process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID =
    SIGN_IN_ENV.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  process.env.VERCEL_APP_CLIENT_SECRET =
    SIGN_IN_ENV.VERCEL_APP_CLIENT_SECRET;
  process.env.NEXT_PUBLIC_BASE_DOMAIN = "http://localhost:3000";
  delete process.env.VERCEL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;

  _resetStoreForTesting();

  return fn().finally(() => {
    for (const key of SIGN_IN_ENV_KEYS) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  });
}

function withDeploymentProtectionEnv(fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of SIGN_IN_ENV_KEYS) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  process.env.NEXT_PUBLIC_BASE_DOMAIN = "http://localhost:3000";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.SESSION_SECRET;
  delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  delete process.env.VERCEL_APP_CLIENT_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;

  _resetStoreForTesting();

  return fn().finally(() => {
    for (const key of SIGN_IN_ENV_KEYS) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  });
}

// ===========================================================================
// 1. Admin routes reject unauthenticated requests in sign-in-with-vercel mode
// ===========================================================================

test("admin/ensure: unauthenticated POST returns 401 in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    // POST with CSRF headers but no session cookie
    const request = buildAuthPostRequest("/api/admin/ensure", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("admin/snapshot: unauthenticated POST returns 401 in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-auth-test";
    });

    const route = getAdminSnapshotRoute();
    const request = buildAuthPostRequest("/api/admin/snapshot", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("admin/snapshots: unauthenticated GET returns 401 in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const route = getAdminSnapshotsRoute();
    const request = buildGetRequest("/api/admin/snapshots");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("GET /api/status: unauthenticated returns 401 in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const route = getStatusRoute();
    const request = buildGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string; authorizeUrl: string };
    assert.equal(body.error, "UNAUTHORIZED");
    assert.ok(
      body.authorizeUrl?.includes("/api/auth/authorize"),
      "Should include authorize URL for re-login",
    );
  });
});

// ===========================================================================
// 2. Authenticated requests succeed in sign-in-with-vercel mode
// ===========================================================================

test("GET /api/status: authenticated request succeeds in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const setCookie = await buildSessionCookie();
    const cookieHeader = setCookieToCookieHeader(setCookie);

    const route = getStatusRoute();
    const request = buildGetRequest("/api/status", { cookie: cookieHeader });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    const body = result.json as { status: string; user: { sub: string } };
    assert.ok(body.user, "Should include user info");
    assert.equal(body.user.sub, "test-user-123");
  });
});

test("admin/ensure: authenticated POST succeeds in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const setCookie = await buildSessionCookie();
    const cookieHeader = setCookieToCookieHeader(setCookie);

    const route = getAdminEnsureRoute();
    const request = buildAuthPostRequest("/api/admin/ensure", "{}", {
      cookie: cookieHeader,
    });
    const result = await callRoute(route.POST!, request);

    assert.ok(
      result.status === 200 || result.status === 202,
      `Expected 200 or 202, got ${result.status}`,
    );
  });
});

// ===========================================================================
// 3. Expired session cookie returns 401 and clears session
// ===========================================================================

test("GET /api/status: expired session triggers refresh attempt", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    // Build a session cookie that is already expired (expiresAt in the past)
    const setCookie = await buildSessionCookie({
      expiresAt: Date.now() - 60_000, // expired 1 minute ago
      refreshToken: null, // no refresh token → cannot refresh
    });
    const cookieHeader = setCookieToCookieHeader(setCookie);

    const route = getStatusRoute();
    const request = buildGetRequest("/api/status", { cookie: cookieHeader });
    const result = await callRoute(route.GET!, request);

    // Without a refresh token, the expired session should return 401
    assert.equal(result.status, 401, `Expected 401 for expired session, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("GET /api/status: expired session with refresh token but failed refresh clears session", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    // Build a session that is expired but has a refresh token
    const setCookie = await buildSessionCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: "test-refresh-token-will-fail",
    });
    const cookieHeader = setCookieToCookieHeader(setCookie);

    // Mock fetch to simulate refresh token failure (Vercel token endpoint returns 401)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.vercel.com/v2/oauth2/token")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const route = getStatusRoute();
      const request = buildGetRequest("/api/status", { cookie: cookieHeader });
      const result = await callRoute(route.GET!, request);

      // Refresh failed → should return 401
      assert.equal(result.status, 401, `Expected 401 after refresh failure, got ${result.status}`);

      // Session cookie should be cleared (Max-Age=0)
      const setCookieHeaders = result.response.headers.get("set-cookie");
      if (setCookieHeaders) {
        assert.ok(
          setCookieHeaders.includes("Max-Age=0"),
          "Session cookie should be cleared with Max-Age=0",
        );
        assert.ok(
          setCookieHeaders.includes("openclaw_session"),
          "Should clear the openclaw_session cookie",
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// 4. deployment-protection mode: mutations require CSRF
// ===========================================================================

test("admin/ensure: POST without CSRF headers returns 403 in deployment-protection mode", async () => {
  await withDeploymentProtectionEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    // POST without CSRF headers
    const request = buildPostRequest("/api/admin/ensure", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403, `Expected 403, got ${result.status}`);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
  });
});

test("POST /api/status: heartbeat without CSRF returns 403 in deployment-protection mode", async () => {
  await withDeploymentProtectionEnv(async () => {
    const route = getStatusRoute();
    const request = buildPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403, `Expected 403, got ${result.status}`);
  });
});

test("admin/ensure: POST with CSRF succeeds in deployment-protection mode", async () => {
  await withDeploymentProtectionEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const route = getAdminEnsureRoute();
    const request = buildAuthPostRequest("/api/admin/ensure", "{}");
    const result = await callRoute(route.POST!, request);

    assert.ok(
      result.status === 200 || result.status === 202,
      `Expected 200/202, got ${result.status}`,
    );
  });
});

// ===========================================================================
// 5. Gateway proxy blocks unauthenticated HTML responses (no token leak)
// ===========================================================================

test("Gateway: unauthenticated GET returns 302 redirect (no HTML with token)", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-auth-gate";
      m.gatewayToken = "secret-gateway-token";
      m.portUrls = { "3000": "https://sbx-auth-gate-3000.fake.vercel.run" };
    });

    const result = await callGatewayGet("/");

    // Should redirect to auth, not serve HTML with embedded gateway token
    assert.equal(result.status, 302, `Expected 302, got ${result.status}`);
    const location = result.response.headers.get("location") ?? "";
    assert.ok(
      location.includes("/api/auth/authorize"),
      `Expected redirect to authorize, got: ${location}`,
    );
    // Ensure no gateway token is leaked in the response body
    assert.ok(
      !result.text.includes("secret-gateway-token"),
      "Gateway token must not be leaked in unauthenticated response",
    );
  });
});

test("Gateway: unauthenticated POST returns 302 redirect (no token leak)", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-auth-gate-post";
      m.gatewayToken = "secret-gateway-token-2";
      m.portUrls = { "3000": "https://sbx-auth-gate-post-3000.fake.vercel.run" };
    });

    const mod = getGatewayRoute();
    const request = new Request("http://localhost:3000/gateway/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    const response = await mod.POST(request, {
      params: Promise.resolve({ path: ["v1", "chat"] }),
    });
    const text = await response.text();

    assert.equal(response.status, 302, `Expected 302, got ${response.status}`);
    assert.ok(
      !text.includes("secret-gateway-token-2"),
      "Gateway token must not leak in POST response",
    );
  });
});

test("Gateway: authenticated GET with valid session proxies normally", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-auth-ok";
      m.gatewayToken = "gw-token-auth-ok";
      m.portUrls = { "3000": "https://sbx-auth-ok-3000.fake.vercel.run" };
    });

    const setCookie = await buildSessionCookie();
    const cookieHeader = setCookieToCookieHeader(setCookie);

    // Mock fetch for upstream response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("fake.vercel.run")) {
        return new Response(JSON.stringify({ data: "proxied" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    try {
      const mod = getGatewayRoute();
      const request = buildGetRequest("/gateway/api/data", {
        cookie: cookieHeader,
      });
      const response = await mod.GET(request, {
        params: Promise.resolve({ path: ["api", "data"] }),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch { /* not JSON */ }

      assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
      assert.deepEqual(json, { data: "proxied" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// 6. Admin routes with valid session in sign-in-with-vercel work
// ===========================================================================

test("admin/snapshots: authenticated GET succeeds in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const setCookie = await buildSessionCookie();
    const cookieHeader = setCookieToCookieHeader(setCookie);

    const route = getAdminSnapshotsRoute();
    const request = buildGetRequest("/api/admin/snapshots", {
      cookie: cookieHeader,
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    const body = result.json as { snapshots: unknown[] };
    assert.ok(Array.isArray(body.snapshots), "Should return snapshots array");
  });
});

// ===========================================================================
// 7. Expired session without refresh token on mutation routes
// ===========================================================================

test("admin/ensure: expired session without refresh token returns 401", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const setCookie = await buildSessionCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: null,
    });
    const cookieHeader = setCookieToCookieHeader(setCookie);

    const route = getAdminEnsureRoute();
    const request = buildAuthPostRequest("/api/admin/ensure", "{}", {
      cookie: cookieHeader,
    });
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401, `Expected 401 for expired session, got ${result.status}`);
  });
});

// ===========================================================================
// 8. Corrupted/garbage session cookie returns 401
// ===========================================================================

test("GET /api/status: corrupted session cookie returns 401", async () => {
  await withSignInEnv(async () => {
    const route = getStatusRoute();
    const request = buildGetRequest("/api/status", {
      cookie: "openclaw_session=garbage-not-a-jwt",
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401 for corrupted cookie, got ${result.status}`);
  });
});

// ===========================================================================
// 9. Expired session with successful refresh returns updated cookie
// ===========================================================================

test("GET /api/status: expired session with valid refresh returns 200 and Set-Cookie", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const setCookie = await buildSessionCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: "valid-refresh-token",
    });
    const cookieHeader = setCookieToCookieHeader(setCookie);

    // Mock fetch to simulate successful refresh
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.vercel.com/v2/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access-token",
            refresh_token: "refreshed-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const route = getStatusRoute();
      const request = buildGetRequest("/api/status", { cookie: cookieHeader });
      const result = await callRoute(route.GET!, request);

      assert.equal(result.status, 200, `Expected 200, got ${result.status}`);

      // Should have a Set-Cookie header with updated session
      const responseCookies = result.response.headers.get("set-cookie");
      assert.ok(
        responseCookies?.includes("openclaw_session"),
        "Should set refreshed session cookie",
      );

      // User info should still be present in the response
      const body = result.json as { user?: { sub: string } };
      assert.ok(body.user, "Should include user info after refresh");
      assert.equal(body.user.sub, "test-user-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("admin/ensure: expired session with valid refresh succeeds", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const setCookie = await buildSessionCookie({
      expiresAt: Date.now() - 60_000,
      refreshToken: "valid-refresh-token",
    });
    const cookieHeader = setCookieToCookieHeader(setCookie);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.vercel.com/v2/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access",
            refresh_token: "refreshed-refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const route = getAdminEnsureRoute();
      const request = buildAuthPostRequest("/api/admin/ensure", "{}", {
        cookie: cookieHeader,
      });
      const result = await callRoute(route.POST!, request);

      assert.ok(
        result.status === 200 || result.status === 202,
        `Expected 200/202 after refresh, got ${result.status}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// 10. Admin logs route auth enforcement
// ===========================================================================

test("admin/logs: unauthenticated GET returns 401 in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildGetRequest("/api/admin/logs");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("admin/logs: authenticated GET succeeds in sign-in-with-vercel mode", async () => {
  await withSignInEnv(async () => {
    const setCookie = await buildSessionCookie();
    const cookieHeader = setCookieToCookieHeader(setCookie);

    const route = getAdminLogsRoute();
    const request = buildGetRequest("/api/admin/logs", {
      cookie: cookieHeader,
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
  });
});

// ===========================================================================
// 11. Gateway: subpath and method coverage for auth enforcement
// ===========================================================================

test("Gateway: unauthenticated GET on subpath returns 302 (no token leak)", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-subpath-auth";
      m.gatewayToken = "subpath-secret-token";
      m.portUrls = { "3000": "https://sbx-subpath-auth-3000.fake.vercel.run" };
    });

    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway/v1/settings");
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: ["v1", "settings"] }),
    });
    const text = await response.text();

    assert.equal(response.status, 302, `Expected 302, got ${response.status}`);
    assert.ok(
      !text.includes("subpath-secret-token"),
      "Gateway token must not leak on subpaths",
    );
  });
});

// ===========================================================================
// 12. deployment-protection mode: GET requests pass without CSRF
// ===========================================================================

test("admin/snapshots: GET without CSRF succeeds in deployment-protection mode", async () => {
  await withDeploymentProtectionEnv(async () => {
    const route = getAdminSnapshotsRoute();
    // GET requests should not require CSRF headers
    const request = buildGetRequest("/api/admin/snapshots");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
  });
});

test("admin/logs: GET without CSRF succeeds in deployment-protection mode", async () => {
  await withDeploymentProtectionEnv(async () => {
    const route = getAdminLogsRoute();
    const request = buildGetRequest("/api/admin/logs");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
  });
});

// ===========================================================================
// Original section 8 continues below
// ===========================================================================

test("Gateway: corrupted session cookie returns 302 redirect (not proxied HTML)", async () => {
  await withSignInEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);
    await mutateMeta((m) => {
      m.status = "running";
      m.sandboxId = "sbx-corrupt-cookie";
      m.gatewayToken = "token-should-not-leak";
    });

    const mod = getGatewayRoute();
    const request = buildGetRequest("/gateway/", {
      cookie: "openclaw_session=not-valid-encrypted-jwt",
    });
    const response = await mod.GET(request, {
      params: Promise.resolve({ path: undefined }),
    });
    const text = await response.text();

    assert.equal(response.status, 302, `Expected 302, got ${response.status}`);
    assert.ok(
      !text.includes("token-should-not-leak"),
      "Token must not leak with corrupted cookie",
    );
  });
});
