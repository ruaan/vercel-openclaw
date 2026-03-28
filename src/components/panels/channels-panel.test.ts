import assert from "node:assert/strict";
import test from "node:test";

import { getPreflightBlockerIds } from "./channels-panel";

test("getPreflightBlockerIds returns failing check IDs", () => {
  const ids = getPreflightBlockerIds({
    ok: false,
    checks: [
      { id: "store", status: "fail", message: "Durable state missing." },
      { id: "webhook-bypass", status: "warn", message: "Bypass not configured." },
      { id: "ai-gateway", status: "fail", message: "AI gateway unavailable." },
    ],
  });
  assert.deepEqual([...(ids ?? [])].sort(), ["ai-gateway", "store"]);
});

test("getPreflightBlockerIds returns null when preflight is null", () => {
  assert.equal(getPreflightBlockerIds(null), null);
});

test("getPreflightBlockerIds returns null when preflight.ok is true", () => {
  const ids = getPreflightBlockerIds({
    ok: true,
    checks: [{ id: "store", status: "fail", message: "ignored when ok" }],
  });
  assert.equal(ids, null);
});
