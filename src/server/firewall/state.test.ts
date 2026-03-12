import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";
import {
  approveDomains,
  getFirewallState,
  ingestLearningFromSandbox,
  promoteLearnedDomainsToEnforcing,
  removeDomains,
  setFirewallMode,
} from "@/server/firewall/state";
import { toNetworkPolicy } from "@/server/firewall/policy";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import type { SandboxController, SandboxHandle } from "@/server/sandbox/controller";
import { _resetStoreForTesting, mutateMeta } from "@/server/store/store";

async function withFirewallTestStore(fn: () => Promise<void>): Promise<void> {
  const overrides: Record<string, string | undefined> = {
    NODE_ENV: "test",
    VERCEL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined,
    KV_REST_API_TOKEN: undefined,
  };
  const originals: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
  }
}

async function prepareRunningSandbox(
  configure?: (meta: SingleMeta) => void,
): Promise<void> {
  await mutateMeta((meta) => {
    meta.status = "running";
    meta.sandboxId = "sandbox-123";
    configure?.(meta);
  });
}

function installFailingSandboxSync(): {
  readonly updateCalls: number;
  restore(): void;
} {
  let updateCalls = 0;

  const fakeController: SandboxController = {
    async create() {
      throw new Error("not implemented in this test");
    },
    async get() {
      return {
        sandboxId: "sandbox-123",
        async runCommand() {
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          return { snapshotId: "snap-123" };
        },
        async extendTimeout() {},
        async updateNetworkPolicy() {
          updateCalls += 1;
          throw new Error("sandbox policy update failed");
        },
      };
    },
  };

  _setSandboxControllerForTesting(fakeController);

  return {
    get updateCalls() {
      return updateCalls;
    },
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

async function assertFirewallSyncFailed(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "FIREWALL_SYNC_FAILED");
    assert.equal(
      error.message,
      "Failed to sync firewall policy to the running sandbox.",
    );
    return true;
  });
}

test(
  "setFirewallMode throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting mode update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(setFirewallMode("learning"));

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "learning");
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "approveDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(approveDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["api.openai.com"]);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "removeDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist removal",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
        });

        await assertFirewallSyncFailed(removeDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["vercel.com"]);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "promoteLearnedDomainsToEnforcing throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting promotion",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
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

        await assertFirewallSyncFailed(promoteLearnedDomainsToEnforcing());

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "enforcing");
        assert.deepEqual(firewall.allowlist, ["api.openai.com"]);
        assert.deepEqual(firewall.learned, []);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

// ===========================================================================
// Happy-path helpers — succeeding sandbox controller
// ===========================================================================

function installSucceedingSandboxController(opts?: {
  /** Shell command log content returned by `cat /tmp/shell-commands-for-learning.log` */
  shellLog?: string;
}): {
  readonly appliedPolicies: NetworkPolicy[];
  restore(): void;
} {
  const appliedPolicies: NetworkPolicy[] = [];
  const shellLog = opts?.shellLog ?? "";

  const fakeController: SandboxController = {
    async create() {
      throw new Error("not implemented in this test");
    },
    async get() {
      return {
        sandboxId: "sandbox-123",
        async runCommand(_cmd: string, args?: string[]) {
          const cmdStr = [_cmd, ...(args ?? [])].join(" ");
          // If reading the learning log, return the configured content
          if (cmdStr.includes("shell-commands-for-learning.log")) {
            return { exitCode: 0, output: async () => shellLog };
          }
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          return { snapshotId: "snap-123" };
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
    get appliedPolicies() {
      return appliedPolicies;
    },
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

// ===========================================================================
// Firewall mode transition tests (happy path)
// ===========================================================================

test("disabled → learning: mode changes, sandbox policy stays allow-all", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();

      // Default mode is disabled
      let fw = await getFirewallState();
      assert.equal(fw.mode, "disabled");

      // Transition to learning
      fw = await setFirewallMode("learning");
      assert.equal(fw.mode, "learning");

      // Policy applied to sandbox should be allow-all (both disabled and learning map to allow-all)
      assert.equal(ctrl.appliedPolicies.length, 1);
      assert.equal(ctrl.appliedPolicies[0], "allow-all");
    } finally {
      ctrl.restore();
    }
  });
});

test("learning → enforcing: learned domains become the allowlist, sandbox policy updates to { allow: [...] }", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learned = [
          { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 5 },
          { domain: "registry.npmjs.org", firstSeenAt: 1, lastSeenAt: 3, hitCount: 2 },
        ];
      });

      // Promote learned domains to enforcing
      const fw = await promoteLearnedDomainsToEnforcing();

      assert.equal(fw.mode, "enforcing");
      assert.deepEqual(fw.allowlist, ["api.openai.com", "registry.npmjs.org"]);
      assert.deepEqual(fw.learned, []);

      // Sandbox should have received { allow: [...] } policy
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.ok(typeof applied === "object" && "allow" in applied);
      assert.deepEqual(applied.allow, ["api.openai.com", "registry.npmjs.org"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("enforcing: approveDomains updates allowlist and syncs sandbox policy", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["api.openai.com"];
      });

      const fw = await approveDomains(["vercel.com"]);

      assert.deepEqual(fw.allowlist, ["api.openai.com", "vercel.com"]);
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.deepEqual(applied.allow, ["api.openai.com", "vercel.com"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("enforcing: removeDomains updates allowlist and syncs sandbox policy", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org", "vercel.com"];
      });

      const fw = await removeDomains(["registry.npmjs.org"]);

      assert.deepEqual(fw.allowlist, ["api.openai.com", "vercel.com"]);
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.deepEqual(applied.allow, ["api.openai.com", "vercel.com"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("full transition: disabled → learning → ingest domains → enforcing with allowlist", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat/completions",
      "wget https://registry.npmjs.org/express",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox();

      // Step 1: disabled → learning
      let fw = await setFirewallMode("learning");
      assert.equal(fw.mode, "learning");
      assert.equal(ctrl.appliedPolicies.length, 1);
      assert.equal(ctrl.appliedPolicies[0], "allow-all");

      // Step 2: ingest domains from shell log
      const ingestResult = await ingestLearningFromSandbox(true);
      assert.equal(ingestResult.ingested, true);
      assert.ok(ingestResult.domains.includes("api.openai.com"));
      assert.ok(ingestResult.domains.includes("registry.npmjs.org"));

      // Verify learned domains stored in metadata
      fw = await getFirewallState();
      assert.equal(fw.learned.length, 2);
      const learnedNames = fw.learned.map((d) => d.domain).sort();
      assert.deepEqual(learnedNames, ["api.openai.com", "registry.npmjs.org"]);

      // Step 3: learning → enforcing (promote learned)
      fw = await promoteLearnedDomainsToEnforcing();
      assert.equal(fw.mode, "enforcing");
      assert.deepEqual(fw.allowlist, ["api.openai.com", "registry.npmjs.org"]);
      assert.deepEqual(fw.learned, []);

      // Should have synced twice total (setFirewallMode + promote)
      assert.equal(ctrl.appliedPolicies.length, 2);
      const enforcingPolicy = ctrl.appliedPolicies[1] as { allow: string[] };
      assert.deepEqual(enforcingPolicy.allow, ["api.openai.com", "registry.npmjs.org"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: extracts domains from shell command log and stores in metadata", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "dns lookup api.anthropic.com",
      "host: cdn.vercel.com",
      "https://hooks.slack.com/services/T123/B456",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      const result = await ingestLearningFromSandbox(true);

      assert.equal(result.ingested, true);
      assert.ok(result.domains.length >= 2, `Expected ≥2 domains, got ${result.domains.length}`);
      assert.ok(result.domains.includes("api.anthropic.com"));
      assert.ok(result.domains.includes("cdn.vercel.com"));
      assert.ok(result.domains.includes("hooks.slack.com"));

      // Verify learned entries have correct shape
      const fw = await getFirewallState();
      for (const entry of fw.learned) {
        assert.ok(typeof entry.domain === "string");
        assert.ok(typeof entry.firstSeenAt === "number");
        assert.ok(typeof entry.lastSeenAt === "number");
        assert.ok(typeof entry.hitCount === "number");
        assert.ok(entry.hitCount >= 1);
      }

      // Verify events were recorded
      assert.ok(
        fw.events.some((e) => e.action === "domain_observed"),
        "Expected at least one domain_observed event",
      );
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: skips when mode is not learning", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController({ shellLog: "https://api.openai.com" });
    try {
      await prepareRunningSandbox(); // mode = disabled (default)

      const result = await ingestLearningFromSandbox(true);

      assert.equal(result.ingested, false);
      assert.equal(result.reason, "mode-not-learning");
      assert.deepEqual(result.domains, []);
    } finally {
      ctrl.restore();
    }
  });
});

test("toNetworkPolicy: disabled and learning return allow-all, enforcing returns { allow: [...] }", () => {
  assert.equal(toNetworkPolicy("disabled", []), "allow-all");
  assert.equal(toNetworkPolicy("learning", ["api.openai.com"]), "allow-all");
  assert.deepEqual(toNetworkPolicy("enforcing", ["vercel.com", "api.openai.com"]), {
    allow: ["api.openai.com", "vercel.com"],
  });
});

// ===========================================================================
// Sync while stopped: setFirewallMode when sandbox is not running
// ===========================================================================

test("setFirewallMode succeeds when sandbox is stopped (no sync needed)", async () => {
  await withFirewallTestStore(async () => {
    // Leave sandbox as uninitialized (default) — no sandboxId, no running instance
    const fw = await setFirewallMode("learning");
    assert.equal(fw.mode, "learning");
    // No sync should have been attempted — no sandbox to sync to
  });
});

test("approveDomains succeeds when sandbox is stopped (no sync)", async () => {
  await withFirewallTestStore(async () => {
    const fw = await approveDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["api.openai.com"]);
  });
});

test("removeDomains succeeds when sandbox is stopped (no sync)", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
    });
    const fw = await removeDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["vercel.com"]);
  });
});

// ===========================================================================
// setFirewallMode to enforcing with empty allowlist is rejected
// ===========================================================================

test("setFirewallMode to enforcing with empty allowlist throws 409", async () => {
  await withFirewallTestStore(async () => {
    await assert.rejects(
      setFirewallMode("enforcing"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );
  });
});

// ===========================================================================
// Domain merge: ingesting same domain multiple times increments hitCount
// ===========================================================================

test("learning ingestion: re-ingesting same domain increments hitCount", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = "curl https://api.openai.com/v1/chat";
    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      // First ingestion
      const r1 = await ingestLearningFromSandbox(true);
      assert.equal(r1.ingested, true);

      let fw = await getFirewallState();
      const firstEntry = fw.learned.find((e) => e.domain === "api.openai.com");
      assert.ok(firstEntry);
      assert.equal(firstEntry.hitCount, 1);

      // Second ingestion with same domain
      const r2 = await ingestLearningFromSandbox(true);
      assert.equal(r2.ingested, true);

      fw = await getFirewallState();
      const secondEntry = fw.learned.find((e) => e.domain === "api.openai.com");
      assert.ok(secondEntry);
      assert.equal(secondEntry.hitCount, 2);
    } finally {
      ctrl.restore();
    }
  });
});
