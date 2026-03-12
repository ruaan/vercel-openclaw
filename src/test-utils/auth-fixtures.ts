/**
 * Auth fixture helpers for smoke tests.
 *
 * Provides pre-built auth artifacts for both auth modes so route-level
 * tests can exercise authenticated paths without real OAuth flows.
 */

import {
  serializeSessionCookie,
  type AuthSession,
  type SessionUser,
} from "@/server/auth/session";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_USER: SessionUser = {
  sub: "test-user-123",
  email: "dev@example.com",
  name: "Test User",
  preferredUsername: "testuser",
};

const DEFAULT_SESSION_SECRET = "test-session-secret-for-smoke-tests";
const DEFAULT_CLIENT_ID = "oac_test_client_id";
const DEFAULT_CLIENT_SECRET = "test_client_secret";

// ---------------------------------------------------------------------------
// sign-in-with-vercel helpers
// ---------------------------------------------------------------------------

export type SessionCookieOptions = {
  /** Override the default test user. */
  user?: Partial<SessionUser>;
  /** Access token value. Defaults to "test-access-token". */
  accessToken?: string;
  /** Refresh token value. Defaults to "test-refresh-token". */
  refreshToken?: string | null;
  /** Token expiry timestamp. Defaults to 1 hour from now. */
  expiresAt?: number;
};

/**
 * Build an encrypted session cookie string suitable for injecting into
 * request headers when testing sign-in-with-vercel auth mode.
 *
 * Requires `SESSION_SECRET` to be set in the environment (the harness
 * sets it automatically when `authMode: 'sign-in-with-vercel'`).
 *
 * @returns The full `Set-Cookie` header value (name=encrypted; attributes).
 *          Pass the cookie *value* portion to a `Cookie` request header.
 */
export async function buildSessionCookie(
  options?: SessionCookieOptions,
): Promise<string> {
  const user: SessionUser = { ...DEFAULT_USER, ...options?.user };
  const session: AuthSession = {
    accessToken: options?.accessToken ?? "test-access-token",
    refreshToken: options?.refreshToken ?? "test-refresh-token",
    expiresAt: options?.expiresAt ?? Date.now() + 60 * 60 * 1000,
    user,
  };

  // secure=false for test requests (plain http)
  return serializeSessionCookie(session, false);
}

/**
 * Extract just the `cookie` header value from a Set-Cookie string
 * so it can be passed as `{ cookie: value }` in a Request.
 *
 * `serializeSessionCookie` returns `name=value; Path=/; ...`.
 * Browsers send only `name=value`, so we strip the attributes.
 */
export function setCookieToCookieHeader(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

// ---------------------------------------------------------------------------
// deployment-protection helpers
// ---------------------------------------------------------------------------

/**
 * Return headers that simulate Vercel deployment protection.
 *
 * In deployment-protection mode the app trusts that Vercel's edge
 * layer has already authenticated the request, so no cookie is needed.
 * These headers mirror what Vercel injects on protected deployments.
 */
export function buildDeploymentProtectionHeaders(): Record<string, string> {
  return {
    "x-vercel-protection-bypass": "true",
    "x-forwarded-proto": "https",
  };
}

// ---------------------------------------------------------------------------
// Environment variable presets
// ---------------------------------------------------------------------------

/** Env overrides for sign-in-with-vercel mode. */
export const SIGN_IN_ENV: Record<string, string> = {
  VERCEL_AUTH_MODE: "sign-in-with-vercel",
  SESSION_SECRET: DEFAULT_SESSION_SECRET,
  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: DEFAULT_CLIENT_ID,
  VERCEL_APP_CLIENT_SECRET: DEFAULT_CLIENT_SECRET,
};

/** Env overrides for deployment-protection mode (the default). */
export const DEPLOYMENT_PROTECTION_ENV: Record<string, string | undefined> = {
  VERCEL_AUTH_MODE: undefined,
  SESSION_SECRET: undefined,
  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: undefined,
  VERCEL_APP_CLIENT_SECRET: undefined,
};
