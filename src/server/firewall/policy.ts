import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

import type { SingleMeta } from "@/shared/types";
import { logInfo } from "@/server/log";
import type { SandboxHandle } from "@/server/sandbox/controller";

const AI_GATEWAY_DOMAIN = "ai-gateway.vercel.sh";

/**
 * Build the network policy transform rules that inject an Authorization header
 * for requests to ai-gateway.vercel.sh.  Reused by both the main sandbox
 * firewall and worker sandbox creation.
 */
export function buildAiGatewayTransformRules(
  token: string,
): NetworkPolicyRule[] {
  return [
    {
      transform: [{ headers: { authorization: `Bearer ${token}` } }],
    },
  ];
}

export function toNetworkPolicy(
  mode: SingleMeta["firewall"]["mode"],
  allowlist: string[],
  aiGatewayToken?: string,
): NetworkPolicy {
  // When a token is provided, always use the object form so the transform
  // injects the Authorization header at the firewall layer — the credential
  // never enters the sandbox.
  if (aiGatewayToken) {
    const transformRules = buildAiGatewayTransformRules(aiGatewayToken);
    switch (mode) {
      case "disabled":
      case "learning": {
        // Functionally equivalent to "allow-all" but with credential injection.
        return {
          allow: {
            [AI_GATEWAY_DOMAIN]: transformRules,
            "*": [],
          },
        };
      }
      case "enforcing": {
        const allow: Record<string, NetworkPolicyRule[]> = {};
        for (const domain of [...allowlist].sort((a, b) => a.localeCompare(b))) {
          allow[domain] =
            domain === AI_GATEWAY_DOMAIN ? transformRules : [];
        }
        // Ensure ai-gateway is always reachable even if not in the user's allowlist.
        if (!(AI_GATEWAY_DOMAIN in allow)) {
          allow[AI_GATEWAY_DOMAIN] = transformRules;
        }
        return { allow };
      }
    }
  }

  // Legacy path: no token — return the simple form.
  switch (mode) {
    case "enforcing":
      return { allow: [...allowlist].sort((left, right) => left.localeCompare(right)) };
    case "disabled":
    case "learning":
      return "allow-all";
  }
}

export async function applyFirewallPolicyToSandbox(
  sandbox: SandboxHandle,
  meta: SingleMeta,
  aiGatewayToken?: string,
): Promise<NetworkPolicy> {
  const policy = toNetworkPolicy(
    meta.firewall.mode,
    meta.firewall.allowlist,
    aiGatewayToken,
  );
  logInfo("firewall.policy_requested", {
    operation: "sync",
    mode: meta.firewall.mode,
    allowlistCount: meta.firewall.allowlist.length,
    hasAiGatewayTransform: !!aiGatewayToken,
  });
  await sandbox.updateNetworkPolicy(policy);
  logInfo("firewall.policy_applied", {
    operation: "sync",
    mode: meta.firewall.mode,
    allowlistCount: meta.firewall.allowlist.length,
    hasAiGatewayTransform: !!aiGatewayToken,
  });
  return policy;
}
