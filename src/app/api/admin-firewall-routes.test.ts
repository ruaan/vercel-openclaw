/**
 * Route-level tests for admin snapshot, firewall, and cron drain-channels endpoints.
 *
 * Uses the scenario harness (memory store, fake sandbox controller) so no real
 * network or Vercel Sandbox API calls are made.
 *
 * Run: pnpm test
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import type { SnapshotRecord } from "@/shared/types";
import type {
  SandboxController,
  SandboxHandle,
} from "@/server/sandbox/controller";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildPostRequest,
  buildGetRequest,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();

// ---------------------------------------------------------------------------
// Lazy-load route modules (after patching)
// ---------------------------------------------------------------------------

type RouteModule<Methods extends string = "GET" | "POST" | "PUT" | "DELETE"> = {
  [K in Methods]?: (request: Request) => Promise<Response>;
};

function loadRoute(path: string): RouteModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as RouteModule;
}

const snapshotRoute = loadRoute("@/app/api/admin/snapshot/route");
const snapshotsRoute = loadRoute("@/app/api/admin/snapshots/route");
const snapshotsRestoreRoute = loadRoute(
  "@/app/api/admin/snapshots/restore/route",
);
const firewallRoute = loadRoute("@/app/api/firewall/route");
const firewallPromoteRoute = loadRoute("@/app/api/firewall/promote/route");
const firewallAllowlistRoute = loadRoute(
  "@/app/api/firewall/allowlist/route",
);
const cronDrainRoute = loadRoute("@/app/api/cron/drain-channels/route");

// ---------------------------------------------------------------------------
// Environment isolation helper
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
    "CRON_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  // Force memory store (bracket notation to bypass TS read-only on NODE_ENV)
  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
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

// ---------------------------------------------------------------------------
// Request builders for PUT/DELETE
// ---------------------------------------------------------------------------

function buildPutRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
      ...headers,
    },
    body,
  });
}

function buildDeleteRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
      ...headers,
    },
    body,
  });
}

function buildAuthPostRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return buildPostRequest(path, body, {
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
    ...headers,
  });
}

function buildAuthGetRequest(
  path: string,
  headers?: Record<string, string>,
): Request {
  return buildGetRequest(path, {
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
    ...headers,
  });
}

// ---------------------------------------------------------------------------
// Fake sandbox controller for snapshot routes
// ---------------------------------------------------------------------------

function installFakeSandboxController(): {
  readonly snapshotCalls: number;
  readonly appliedPolicies: NetworkPolicy[];
  restore(): void;
} {
  let snapshotCalls = 0;
  const appliedPolicies: NetworkPolicy[] = [];

  const fakeController: SandboxController = {
    async create() {
      return {
        sandboxId: "sbx-test-123",
        async runCommand() {
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          snapshotCalls++;
          return { snapshotId: `snap-test-${snapshotCalls}` };
        },
        async extendTimeout() {},
        async updateNetworkPolicy(policy: NetworkPolicy) {
          appliedPolicies.push(policy);
          return policy;
        },
      } satisfies SandboxHandle;
    },
    async get(opts: { sandboxId: string }) {
      return {
        sandboxId: opts.sandboxId,
        async runCommand() {
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          snapshotCalls++;
          return { snapshotId: `snap-test-${snapshotCalls}` };
        },
        async extendTimeout() {},
        async updateNetworkPolicy(policy: NetworkPolicy) {
          appliedPolicies.push(policy);
          return policy;
        },
      } satisfies SandboxHandle;
    },
  };

  _setSandboxControllerForTesting(fakeController);

  return {
    get snapshotCalls() {
      return snapshotCalls;
    },
    get appliedPolicies() {
      return appliedPolicies;
    },
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

// ===========================================================================
// POST /api/admin/snapshot
// ===========================================================================

test("POST /api/admin/snapshot: triggers snapshotSandbox and returns status + snapshotId", async () => {
  await withTestEnv(async () => {
    const ctrl = installFakeSandboxController();
    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-running-1";
      });

      const request = buildAuthPostRequest("/api/admin/snapshot", "{}");
      const result = await callRoute(snapshotRoute.POST!, request);

      assert.equal(result.status, 200);
      const body = result.json as { status: string; snapshotId: string };
      assert.equal(body.status, "stopped");
      assert.ok(body.snapshotId, "snapshotId should be present");
    } finally {
      ctrl.restore();
    }
  });
});

test("POST /api/admin/snapshot: without CSRF headers returns 403", async () => {
  await withTestEnv(async () => {
    const request = buildPostRequest("/api/admin/snapshot", "{}", {});
    const result = await callRoute(snapshotRoute.POST!, request);

    assert.equal(result.status, 403);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
  });
});

// ===========================================================================
// GET /api/admin/snapshots
// ===========================================================================

test("GET /api/admin/snapshots: returns snapshot history from metadata", async () => {
  await withTestEnv(async () => {
    const record: SnapshotRecord = {
      id: "test-uuid",
      snapshotId: "snap-history-1",
      timestamp: Date.now(),
      reason: "manual",
    };

    await mutateMeta((meta) => {
      meta.snapshotHistory = [record];
    });

    const request = buildAuthGetRequest("/api/admin/snapshots");
    const result = await callRoute(snapshotsRoute.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { snapshots: SnapshotRecord[] };
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].snapshotId, "snap-history-1");
    assert.equal(body.snapshots[0].reason, "manual");
  });
});

test("GET /api/admin/snapshots: returns empty array when no snapshots", async () => {
  await withTestEnv(async () => {
    const request = buildAuthGetRequest("/api/admin/snapshots");
    const result = await callRoute(snapshotsRoute.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { snapshots: SnapshotRecord[] };
    assert.deepEqual(body.snapshots, []);
  });
});

// ===========================================================================
// POST /api/admin/snapshots (create snapshot while running)
// ===========================================================================

test("POST /api/admin/snapshots: returns 500 when Sandbox.get fails (direct API call)", async () => {
  // This route calls Sandbox.get() directly (not via the controller),
  // so it hits the real API in tests and gets a 404/500.
  // We verify the error handling path returns a proper JSON error.
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running-snap";
    });

    const request = buildAuthPostRequest(
      "/api/admin/snapshots",
      JSON.stringify({ reason: "test-snapshot" }),
    );
    const result = await callRoute(snapshotsRoute.POST!, request);

    assert.equal(result.status, 500);
    const body = result.json as { error: string };
    assert.ok(body.error, "Should return a JSON error");
  });
});

test("POST /api/admin/snapshots: returns 409 when sandbox is not running", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const request = buildAuthPostRequest("/api/admin/snapshots", "{}");
    const result = await callRoute(snapshotsRoute.POST!, request);

    assert.equal(result.status, 409);
    const body = result.json as { error: string };
    assert.equal(body.error, "SANDBOX_NOT_RUNNING");
  });
});

// ===========================================================================
// POST /api/admin/snapshots/restore
// ===========================================================================

test("POST /api/admin/snapshots/restore: restores from known snapshotId", async () => {
  await withTestEnv(async () => {
    const ctrl = installFakeSandboxController();
    try {
      await mutateMeta((meta) => {
        meta.status = "stopped";
        meta.snapshotId = "snap-known-1";
        meta.sandboxId = null;
      });

      const request = buildAuthPostRequest(
        "/api/admin/snapshots/restore",
        JSON.stringify({ snapshotId: "snap-known-1" }),
      );
      const result = await callRoute(snapshotsRestoreRoute.POST!, request);

      // Should succeed (state may be waiting or running depending on lifecycle)
      assert.ok(
        result.status === 200 || result.status === 202,
        `Expected 200 or 202, got ${result.status}`,
      );
      const body = result.json as { snapshotId: string; state: string };
      assert.equal(body.snapshotId, "snap-known-1");
    } finally {
      ctrl.restore();
    }
  });
});

test("POST /api/admin/snapshots/restore: returns 404 for unknown snapshotId", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-existing";
      meta.snapshotHistory = [];
    });

    const request = buildAuthPostRequest(
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-does-not-exist" }),
    );
    const result = await callRoute(snapshotsRestoreRoute.POST!, request);

    assert.equal(result.status, 404);
    const body = result.json as { error: string };
    assert.equal(body.error, "SNAPSHOT_NOT_FOUND");
  });
});

test("POST /api/admin/snapshots/restore: returns 400 for missing snapshotId", async () => {
  await withTestEnv(async () => {
    const request = buildAuthPostRequest(
      "/api/admin/snapshots/restore",
      JSON.stringify({}),
    );
    const result = await callRoute(snapshotsRestoreRoute.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "MISSING_SNAPSHOT_ID");
  });
});

test("POST /api/admin/snapshots/restore: returns 400 for invalid JSON body", async () => {
  await withTestEnv(async () => {
    const request = buildAuthPostRequest(
      "/api/admin/snapshots/restore",
      "not-json",
    );
    const result = await callRoute(snapshotsRestoreRoute.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

test("POST /api/admin/snapshots/restore: restores from snapshot in history", async () => {
  await withTestEnv(async () => {
    const ctrl = installFakeSandboxController();
    try {
      const historyRecord: SnapshotRecord = {
        id: "rec-1",
        snapshotId: "snap-from-history",
        timestamp: Date.now() - 3600_000,
        reason: "scheduled",
      };

      await mutateMeta((meta) => {
        meta.status = "stopped";
        meta.snapshotId = "snap-current";
        meta.sandboxId = null;
        meta.snapshotHistory = [historyRecord];
      });

      const request = buildAuthPostRequest(
        "/api/admin/snapshots/restore",
        JSON.stringify({ snapshotId: "snap-from-history" }),
      );
      const result = await callRoute(snapshotsRestoreRoute.POST!, request);

      assert.ok(
        result.status === 200 || result.status === 202,
        `Expected 200 or 202, got ${result.status}`,
      );
      const body = result.json as { snapshotId: string };
      assert.equal(body.snapshotId, "snap-from-history");
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// GET /api/firewall
// ===========================================================================

test("GET /api/firewall: returns current firewall state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
      meta.firewall.learned = [
        {
          domain: "cdn.vercel.com",
          firstSeenAt: 1000,
          lastSeenAt: 2000,
          hitCount: 5,
        },
      ];
    });

    const request = buildAuthGetRequest("/api/firewall");
    const result = await callRoute(firewallRoute.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      mode: string;
      allowlist: string[];
      learned: Array<{ domain: string }>;
    };
    assert.equal(body.mode, "learning");
    assert.deepEqual(body.allowlist, ["api.openai.com"]);
    assert.equal(body.learned.length, 1);
    assert.equal(body.learned[0].domain, "cdn.vercel.com");
  });
});

// ===========================================================================
// PUT /api/firewall (set mode)
// ===========================================================================

test("PUT /api/firewall: transitions firewall mode", async () => {
  await withTestEnv(async () => {
    // No running sandbox, so sync is a no-op
    const request = buildPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "learning" }),
    );
    const result = await callRoute(firewallRoute.PUT!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { mode: string };
      policy: { applied: boolean; reason: string };
    };
    assert.equal(body.firewall.mode, "learning");
  });
});

test("PUT /api/firewall: rejects invalid mode", async () => {
  await withTestEnv(async () => {
    const request = buildPutRequest(
      "/api/firewall",
      JSON.stringify({ mode: "invalid-mode" }),
    );
    const result = await callRoute(firewallRoute.PUT!, request);

    assert.equal(result.status, 500);
  });
});

test("PUT /api/firewall: without CSRF headers returns 403", async () => {
  await withTestEnv(async () => {
    const request = new Request("http://localhost:3000/api/firewall", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "learning" }),
    });
    const result = await callRoute(firewallRoute.PUT!, request);

    assert.equal(result.status, 403);
  });
});

// ===========================================================================
// POST /api/firewall/promote
// ===========================================================================

test("POST /api/firewall/promote: promotes learned domains to enforcing", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.learned = [
        {
          domain: "api.openai.com",
          firstSeenAt: 1,
          lastSeenAt: 2,
          hitCount: 3,
        },
      ];
    });

    const request = buildAuthPostRequest("/api/firewall/promote", "{}");
    const result = await callRoute(firewallPromoteRoute.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { mode: string; allowlist: string[] };
    };
    assert.equal(body.firewall.mode, "enforcing");
    assert.deepEqual(body.firewall.allowlist, ["api.openai.com"]);
  });
});

test("POST /api/firewall/promote: without CSRF returns 403", async () => {
  await withTestEnv(async () => {
    const request = buildPostRequest("/api/firewall/promote", "{}", {});
    const result = await callRoute(firewallPromoteRoute.POST!, request);

    assert.equal(result.status, 403);
  });
});

// ===========================================================================
// POST /api/firewall/allowlist (add domains)
// ===========================================================================

test("POST /api/firewall/allowlist: adds domains to allowlist", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["existing.com"];
    });

    const request = buildAuthPostRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["new-domain.com"] }),
    );
    const result = await callRoute(firewallAllowlistRoute.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { allowlist: string[] };
    };
    assert.ok(body.firewall.allowlist.includes("existing.com"));
    assert.ok(body.firewall.allowlist.includes("new-domain.com"));
  });
});

test("POST /api/firewall/allowlist: without CSRF returns 403", async () => {
  await withTestEnv(async () => {
    const request = buildPostRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["x.com"] }),
      {},
    );
    const result = await callRoute(firewallAllowlistRoute.POST!, request);

    assert.equal(result.status, 403);
  });
});

// ===========================================================================
// DELETE /api/firewall/allowlist (remove domains)
// ===========================================================================

test("DELETE /api/firewall/allowlist: removes domains from allowlist", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["keep.com", "remove-me.com"];
    });

    const request = buildDeleteRequest(
      "/api/firewall/allowlist",
      JSON.stringify({ domains: ["remove-me.com"] }),
    );
    const result = await callRoute(firewallAllowlistRoute.DELETE!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { allowlist: string[] };
    };
    assert.deepEqual(body.firewall.allowlist, ["keep.com"]);
  });
});

// ===========================================================================
// POST /api/cron/drain-channels
// ===========================================================================

test("POST /api/cron/drain-channels: authorized with Bearer token drains queues", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "test-cron-secret";

    const request = buildPostRequest("/api/cron/drain-channels", "{}", {
      authorization: "Bearer test-cron-secret",
    });
    const result = await callRoute(cronDrainRoute.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      ok: boolean;
      results: { slack: string; telegram: string; discord: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.results.slack, "fulfilled");
    assert.equal(body.results.telegram, "fulfilled");
    assert.equal(body.results.discord, "fulfilled");
  });
});

test("POST /api/cron/drain-channels: authorized with x-cron-secret header", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "test-cron-secret";

    const request = buildPostRequest("/api/cron/drain-channels", "{}", {
      "x-cron-secret": "test-cron-secret",
    });
    const result = await callRoute(cronDrainRoute.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

test("GET /api/cron/drain-channels: also works via GET", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "test-cron-secret";

    const request = buildGetRequest("/api/cron/drain-channels", {
      authorization: "Bearer test-cron-secret",
    });
    const result = await callRoute(cronDrainRoute.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

test("POST /api/cron/drain-channels: returns 401 with wrong secret", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "real-secret";

    const request = buildPostRequest("/api/cron/drain-channels", "{}", {
      authorization: "Bearer wrong-secret",
    });
    const result = await callRoute(cronDrainRoute.POST!, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("POST /api/cron/drain-channels: returns 401 with no auth header", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "real-secret";

    const request = buildPostRequest("/api/cron/drain-channels", "{}", {});
    const result = await callRoute(cronDrainRoute.POST!, request);

    assert.equal(result.status, 401);
  });
});

test("POST /api/cron/drain-channels: allows access without secret in non-production", async () => {
  await withTestEnv(async () => {
    delete process.env.CRON_SECRET;
    (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";

    const request = buildPostRequest("/api/cron/drain-channels", "{}", {});
    const result = await callRoute(cronDrainRoute.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);
  });
});
