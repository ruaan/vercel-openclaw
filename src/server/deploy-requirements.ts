import { getAuthMode } from "@/server/env";
import { getProtectionBypassSecret } from "@/server/public-url";

export type WebhookBypassRequirementReason =
  | "admin-secret"
  | "sign-in-with-vercel";

export type WebhookBypassRequirement = {
  configured: boolean;
  recommendation: "none" | "recommended";
  reason: WebhookBypassRequirementReason;
};

export function getWebhookBypassRequirement(): WebhookBypassRequirement {
  const configured = Boolean(getProtectionBypassSecret());
  const authMode = getAuthMode();

  // Webhook bypass is diagnostic-only across all auth modes. If
  // VERCEL_AUTOMATION_BYPASS_SECRET is set, it is applied opportunistically
  // to webhook URLs.
  //
  // sign-in-with-vercel implies Deployment Protection is likely active,
  // so the bypass is recommended (warn) to let Slack/Telegram/Discord
  // webhooks through.  Still non-blocking — operators can disable
  // Deployment Protection instead.
  return {
    configured,
    recommendation:
      !configured && authMode === "sign-in-with-vercel"
        ? "recommended"
        : "none",
    reason: authMode === "admin-secret" ? "admin-secret" : "sign-in-with-vercel",
  };
}

export function getWebhookBypassStatusMessage(
  input: WebhookBypassRequirement,
): string {
  if (input.configured) {
    return "Protection bypass is configured for protected deployment webhook flows.";
  }

  return "Protection bypass is not configured. That is fine only when Deployment Protection is disabled; otherwise third-party webhooks may never reach the app.";
}
