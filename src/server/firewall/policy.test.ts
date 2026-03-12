/**
 * Tests for firewall/policy.ts — toNetworkPolicy and applyFirewallPolicyToSandbox.
 *
 * Covers all three firewall modes: disabled, learning, enforcing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import { createDefaultMeta } from "@/shared/types";
import { toNetworkPolicy, applyFirewallPolicyToSandbox } from "@/server/firewall/policy";
import { FakeSandboxHandle, type SandboxEvent } from "@/test-utils/fake-sandbox-controller";

// ---------------------------------------------------------------------------
// toNetworkPolicy
// ---------------------------------------------------------------------------

test("policy: disabled mode returns allow-all", () => {
  const policy = toNetworkPolicy("disabled", []);
  assert.equal(policy, "allow-all");
});

test("policy: disabled mode ignores allowlist", () => {
  const policy = toNetworkPolicy("disabled", ["example.com", "api.github.com"]);
  assert.equal(policy, "allow-all");
});

test("policy: learning mode returns allow-all", () => {
  const policy = toNetworkPolicy("learning", []);
  assert.equal(policy, "allow-all");
});

test("policy: learning mode ignores allowlist", () => {
  const policy = toNetworkPolicy("learning", ["example.com"]);
  assert.equal(policy, "allow-all");
});

test("policy: enforcing mode returns sorted allow object", () => {
  const policy = toNetworkPolicy("enforcing", ["z.com", "a.com", "m.com"]);
  assert.deepEqual(policy, { allow: ["a.com", "m.com", "z.com"] });
});

test("policy: enforcing mode with empty allowlist returns empty allow array", () => {
  const policy = toNetworkPolicy("enforcing", []);
  assert.deepEqual(policy, { allow: [] });
});

test("policy: enforcing mode with single domain", () => {
  const policy = toNetworkPolicy("enforcing", ["only.com"]);
  assert.deepEqual(policy, { allow: ["only.com"] });
});

test("policy: enforcing mode does not mutate input array", () => {
  const original = ["z.com", "a.com"];
  const copy = [...original];
  toNetworkPolicy("enforcing", original);
  assert.deepEqual(original, copy, "input array should not be sorted in place");
});

// ---------------------------------------------------------------------------
// applyFirewallPolicyToSandbox
// ---------------------------------------------------------------------------

test("policy: applyFirewallPolicyToSandbox applies allow-all for disabled", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-policy", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "disabled";

  const result = await applyFirewallPolicyToSandbox(handle, meta);
  assert.equal(result, "allow-all");
  assert.equal(handle.networkPolicies.length, 1);
  assert.equal(handle.networkPolicies[0], "allow-all");
});

test("policy: applyFirewallPolicyToSandbox applies allow-all for learning", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-policy", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "learning";
  meta.firewall.allowlist = ["example.com"];

  const result = await applyFirewallPolicyToSandbox(handle, meta);
  assert.equal(result, "allow-all");
});

test("policy: applyFirewallPolicyToSandbox applies sorted allowlist for enforcing", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-policy", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "enforcing";
  meta.firewall.allowlist = ["z.io", "a.io", "m.io"];

  const result = await applyFirewallPolicyToSandbox(handle, meta);
  assert.deepEqual(result, { allow: ["a.io", "m.io", "z.io"] });
  assert.deepEqual(handle.networkPolicies[0], { allow: ["a.io", "m.io", "z.io"] });
});

test("policy: applyFirewallPolicyToSandbox records event in handle log", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-ev", events);
  const meta = createDefaultMeta(Date.now(), "tok");
  meta.firewall.mode = "enforcing";
  meta.firewall.allowlist = ["x.com"];

  await applyFirewallPolicyToSandbox(handle, meta);

  const policyEvents = events.filter((e) => e.kind === "update_network_policy");
  assert.equal(policyEvents.length, 1);
});
