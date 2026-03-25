import assert from "node:assert/strict";
import test from "node:test";

import {
  getFirstRunCallout,
  getLifecycleActionLabel,
  getLifecycleProgressDetail,
  getLifecycleProgressLabel,
} from "@/shared/sandbox-lifecycle-copy";
import type { SingleStatus } from "@/shared/types";

test("getLifecycleActionLabel returns the expected labels for interactive states", () => {
  const cases: Array<{
    status: SingleStatus;
    hasSnapshot: boolean;
    expected: string;
  }> = [
    { status: "uninitialized", hasSnapshot: false, expected: "Create Sandbox" },
    { status: "stopped", hasSnapshot: false, expected: "Start Sandbox" },
    { status: "running", hasSnapshot: false, expected: "Open Gateway" },
    { status: "error", hasSnapshot: true, expected: "Restore Sandbox" },
    {
      status: "error",
      hasSnapshot: false,
      expected: "Create Fresh Sandbox",
    },
  ];

  for (const { status, hasSnapshot, expected } of cases) {
    assert.equal(getLifecycleActionLabel(status, hasSnapshot), expected);
  }
});

test("getLifecycleActionLabel falls back to Open Gateway for non-interactive progress states", () => {
  const progressStates: SingleStatus[] = [
    "creating",
    "setup",
    "restoring",
    "booting",
  ];

  for (const status of progressStates) {
    assert.equal(getLifecycleActionLabel(status, false), "Open Gateway");
  }
});

test("getLifecycleProgressLabel returns the expected lifecycle phase labels", () => {
  const cases: Array<[SingleStatus, string | null]> = [
    ["creating", "Creating sandbox…"],
    ["setup", "Installing OpenClaw…"],
    ["restoring", "Restoring snapshot…"],
    ["booting", "Waiting for gateway…"],
    ["uninitialized", null],
    ["running", null],
    ["stopped", null],
    ["error", null],
  ];

  for (const [status, expected] of cases) {
    assert.equal(getLifecycleProgressLabel(status), expected);
  }
});

test("getLifecycleProgressDetail returns setup copy only on first run", () => {
  assert.equal(
    getLifecycleProgressDetail("setup", true),
    "This is the longest step on the first run.",
  );
  assert.equal(getLifecycleProgressDetail("setup", false), null);
});

test("getLifecycleProgressDetail returns restore copy when restoring", () => {
  assert.equal(
    getLifecycleProgressDetail("restoring", false),
    "Bringing back the last saved state.",
  );
  assert.equal(
    getLifecycleProgressDetail("restoring", true),
    "Bringing back the last saved state.",
  );
});

test("getLifecycleProgressDetail returns null for other statuses", () => {
  const cases: SingleStatus[] = [
    "uninitialized",
    "creating",
    "running",
    "stopped",
    "error",
    "booting",
  ];

  for (const status of cases) {
    assert.equal(getLifecycleProgressDetail(status, true), null);
  }
});

test("getFirstRunCallout returns the first-run sandbox guidance", () => {
  assert.deepEqual(getFirstRunCallout(), {
    headline: "Create your sandbox",
    body: [
      "This first start creates a new sandbox and installs OpenClaw. It can take a minute the first time.",
      "After that, future starts are much faster because the sandbox restores from snapshots.",
    ],
  });
});

test("getFirstRunCallout returns a defensive copy of the body array", () => {
  const callout = getFirstRunCallout();
  callout.body.push("Mutated");

  assert.deepEqual(getFirstRunCallout(), {
    headline: "Create your sandbox",
    body: [
      "This first start creates a new sandbox and installs OpenClaw. It can take a minute the first time.",
      "After that, future starts are much faster because the sandbox restores from snapshots.",
    ],
  });
});
