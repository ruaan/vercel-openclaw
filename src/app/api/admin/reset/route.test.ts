import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthPostRequest, buildPostRequest, callRoute, drainAfterCallbacks, patchNextServerAfter, resetAfterCallbacks } from "@/test-utils/route-caller";
import { withHarness } from "@/test-utils/harness";

patchNextServerAfter();

type ResetRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

function getAdminResetRoute(): ResetRouteModule {
  const routePath = require.resolve("@/app/api/admin/reset/route");
  delete require.cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(routePath) as ResetRouteModule;
}

test.afterEach(() => {
  resetAfterCallbacks();
});

test("admin/reset POST: without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getAdminResetRoute();
    const result = await callRoute(route.POST, buildPostRequest("/api/admin/reset", "{}"));
    assert.equal(result.status, 401);
    assert.deepEqual(result.json, {
      error: "UNAUTHORIZED",
      message: "Authentication required.",
    });
  });
});

test("admin/reset POST: responds immediately and resets sandbox state after callbacks drain", async () => {
  await withHarness(async (h) => {
    const route = getAdminResetRoute();
    await h.driveToRunning();

    const beforeMeta = await h.getMeta();
    const originalSandboxId = beforeMeta.sandboxId;
    assert.ok(originalSandboxId, "sandbox should be running before reset");

    await h.mutateMeta((meta) => {
      meta.snapshotConfigHash = "cfg-old";
      meta.snapshotHistory = [];
      meta.lastError = "stale";
    });

    const result = await callRoute(route.POST, buildAuthPostRequest("/api/admin/reset", "{}"));

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true, message: "Sandbox reset started" });

    const queuedMeta = await h.getMeta();
    assert.equal(queuedMeta.sandboxId, originalSandboxId);

    await drainAfterCallbacks();

    const afterMeta = await h.getMeta();
    assert.equal(afterMeta.status, "uninitialized");
    assert.equal(afterMeta.sandboxId, null);
    assert.equal(afterMeta.snapshotId, null);
    assert.equal(afterMeta.snapshotConfigHash, null);
    assert.deepEqual(afterMeta.snapshotHistory, []);
    assert.equal(afterMeta.lastError, null);

    const stoppedHandle = h.controller.getHandle(originalSandboxId);
    assert.ok(stoppedHandle?.stopCalled, "reset should stop the original sandbox");
    assert.equal(stoppedHandle?.snapshotCalled, false, "reset should not snapshot before stopping");
  });
});
