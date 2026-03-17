import { getVercelOidcToken } from "@vercel/oidc";

export type AuthMode = "admin-secret" | "sign-in-with-vercel";

export function getAuthMode(): AuthMode {
  return process.env.VERCEL_AUTH_MODE === "sign-in-with-vercel"
    ? "sign-in-with-vercel"
    : "admin-secret";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Session encryption key used for cookie encryption.
 * In production without an env var, a deterministic fallback derived from
 * UPSTASH_REDIS_REST_TOKEN is used so the key survives cold starts without
 * extra configuration. Local dev uses a static placeholder.
 */
export function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) {
    return configured;
  }

  // Deployed sign-in-with-vercel mode requires an explicit session secret.
  // Do not silently derive from the Upstash token — the deployment contract
  // hard-fails this scenario, and runtime must agree.
  if (getAuthMode() === "sign-in-with-vercel" && isVercelDeployment()) {
    throw new Error(
      "SESSION_SECRET is required for deployed sign-in-with-vercel mode.",
    );
  }

  // Derive from the Upstash token for admin-secret mode or local dev.
  const upstashToken =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ??
    process.env.KV_REST_API_TOKEN?.trim();
  if (upstashToken) {
    return `openclaw-session-derived-${upstashToken}`;
  }

  if (isProduction()) {
    throw new Error(
      "SESSION_SECRET or UPSTASH_REDIS_REST_TOKEN is required in production.",
    );
  }

  return "openclaw-single-local-session-secret-change-me";
}

export function getOauthClientId(): string {
  const clientId = process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("NEXT_PUBLIC_VERCEL_APP_CLIENT_ID is required.");
  }
  return clientId;
}

export function getOauthClientSecret(): string {
  const clientSecret = process.env.VERCEL_APP_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new Error("VERCEL_APP_CLIENT_SECRET is required.");
  }
  return clientSecret;
}

export function getStoreEnv():
  | { url: string; token: string }
  | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL?.trim() ??
    process.env.KV_REST_API_URL?.trim() ??
    "";
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ??
    process.env.KV_REST_API_TOKEN?.trim() ??
    "";

  if (!url || !token) {
    return null;
  }

  return { url, token };
}

export function getCronSecret(): string | null {
  const secret = process.env.CRON_SECRET?.trim();
  return secret || null;
}

let _aiGatewayTokenOverride: string | undefined | null = null;

export function _setAiGatewayTokenOverrideForTesting(value: string | undefined | null): void {
  _aiGatewayTokenOverride = value;
}

/**
 * Resolve an AI Gateway bearer token.
 *
 * Priority:
 *  1. Static `AI_GATEWAY_API_KEY` env var (local dev / explicit override)
 *  2. Vercel OIDC token (`@vercel/oidc` — available in Vercel Functions)
 *
 * Returns `undefined` when no credential is available.
 */
export async function getAiGatewayBearerTokenOptional(): Promise<string | undefined> {
  if (_aiGatewayTokenOverride !== null) {
    return _aiGatewayTokenOverride;
  }

  const staticKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (staticKey) {
    return staticKey;
  }

  try {
    const oidcToken = await getVercelOidcToken();
    if (oidcToken) {
      return oidcToken;
    }
  } catch {
    // OIDC unavailable in this environment.
  }

  return undefined;
}

export function isVercelDeployment(): boolean {
  return Boolean(
    process.env.VERCEL?.trim() ||
      process.env.VERCEL_ENV?.trim() ||
      process.env.VERCEL_URL?.trim() ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim(),
  );
}

/**
 * Single shared rule: durable store (Upstash) is required on Vercel deployments.
 * Consumed by both runtime (getStore) and preflight (store check).
 */
export function requiresDurableStore(): boolean {
  return isVercelDeployment();
}

/**
 * Resolve the openclaw npm package spec to install in the sandbox.
 *
 * Resolution order:
 * 1. `OPENCLAW_PACKAGE_SPEC` env var (e.g. "openclaw@1.2.3", "openclaw@latest")
 * 2. Falls back to "openclaw@latest" when unset (all environments).
 */
export function getOpenclawPackageSpec(): string {
  const explicit = process.env.OPENCLAW_PACKAGE_SPEC?.trim();
  if (explicit) {
    return explicit;
  }
  return "openclaw@latest";
}

export async function getAiGatewayAuthMode(): Promise<"oidc" | "unavailable"> {
  const resolvedGatewayToken = await getAiGatewayBearerTokenOptional();
  return resolvedGatewayToken ? "oidc" : "unavailable";
}
