import { randomBytes } from "node:crypto";

import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import { ApiError, jsonError } from "@/shared/http";
import { getInitializedMeta, getStore, mutateMeta } from "@/server/store/store";
import {
  generateDiscordSmokeKeyPair,
  signDiscordPayload,
  signSlackPayload,
} from "@/server/smoke/remote-crypto";
import { logInfo, logWarn } from "@/server/log";

const DISCORD_SMOKE_PRIVATE_KEY_STORE_KEY =
  "smoke:discord:private-key-pkcs8-pem";

/**
 * Smoke testing endpoint for channel webhooks.
 *
 * PUT  — Configure test channels with generated credentials (bypasses
 *        platform API validation). Sets up Slack, Telegram, and Discord
 *        with generated credentials so smoke webhooks can be sent.
 *
 * POST — Sign and send a webhook payload to the local webhook endpoint.
 *        Raw secrets never leave the server.
 *
 * DELETE — Remove test channel configurations.
 */

// ---- PUT: configure test channels ----------------------------------------

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const now = Date.now();
    const slackSigningSecret = randomBytes(32).toString("hex");
    const telegramWebhookSecret = randomBytes(24).toString("base64url");
    const discordKeys = generateDiscordSmokeKeyPair();
    const origin = new URL(request.url).origin;

    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: slackSigningSecret,
        botToken: "xoxb-smoke-test-token",
        configuredAt: now,
        team: "Smoke Test",
        user: "smoke-bot",
        botId: "B_SMOKE",
      };
      meta.channels.telegram = {
        botToken: "000000000:smoke-test-bot-token",
        webhookSecret: telegramWebhookSecret,
        webhookUrl: `${origin}/api/channels/telegram/webhook`,
        botUsername: "smoke_test_bot",
        configuredAt: now,
      };
      meta.channels.discord = {
        publicKey: discordKeys.publicKeyHex,
        applicationId: "discord-smoke-app",
        botToken: "discord-smoke-bot-token",
        configuredAt: now,
      };
    });
    await getStore().setValue(
      DISCORD_SMOKE_PRIVATE_KEY_STORE_KEY,
      discordKeys.privateKeyPkcs8Pem,
    );

    logInfo("admin.smoke_channels_configured", {
      slack: true,
      telegram: true,
      discord: true,
    });
    return authJsonOk(
      { configured: true, channels: ["slack", "telegram", "discord"] },
      auth,
    );
  } catch (error) {
    logWarn("admin.smoke_channels_configure_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(new ApiError(503, "CONFIGURE_FAILED", "Failed to configure test channels."));
  }
}

// ---- POST: sign and send webhook -----------------------------------------

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let input: { channel?: string; body?: string };
  try {
    input = await request.json();
  } catch {
    return jsonError(new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."));
  }

  const { channel, body: payloadBody } = input;
  if (typeof channel !== "string" || typeof payloadBody !== "string") {
    return jsonError(new ApiError(400, "MISSING_FIELDS", "channel and body are required strings."));
  }

  try {
    const meta = await getInitializedMeta();
    const origin = new URL(request.url).origin;

    if (channel === "slack") {
      const config = meta.channels.slack;
      if (!config) {
        return authJsonOk({ configured: false, sent: false, channel }, auth);
      }
      const headers = signSlackPayload(config.signingSecret, payloadBody);
      const res = await fetch(`${origin}/api/channels/slack/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payloadBody,
      });
      logInfo("admin.smoke_webhook_sent", { channel, status: res.status });
      return authJsonOk({ configured: true, sent: res.ok, status: res.status, channel }, auth);
    }

    if (channel === "telegram") {
      const config = meta.channels.telegram;
      if (!config) {
        return authJsonOk({ configured: false, sent: false, channel }, auth);
      }
      const res = await fetch(`${origin}/api/channels/telegram/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telegram-bot-api-secret-token": config.webhookSecret,
        },
        body: payloadBody,
      });
      logInfo("admin.smoke_webhook_sent", { channel, status: res.status });
      return authJsonOk({ configured: true, sent: res.ok, status: res.status, channel }, auth);
    }

    if (channel === "discord") {
      const config = meta.channels.discord;
      if (!config) {
        return authJsonOk({ configured: false, sent: false, channel }, auth);
      }

      const privateKeyPkcs8Pem = await getStore().getValue<string>(
        DISCORD_SMOKE_PRIVATE_KEY_STORE_KEY,
      );
      if (!privateKeyPkcs8Pem) {
        return jsonError(
          new ApiError(
            409,
            "DISCORD_SMOKE_KEY_MISSING",
            "Discord smoke signing key is not configured.",
          ),
        );
      }

      const headers = signDiscordPayload(privateKeyPkcs8Pem, payloadBody);
      const res = await fetch(`${origin}/api/channels/discord/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payloadBody,
      });
      logInfo("admin.smoke_webhook_sent", { channel, status: res.status });
      return authJsonOk(
        { configured: true, sent: res.ok, status: res.status, channel },
        auth,
      );
    }

    return jsonError(
      new ApiError(
        400,
        "UNSUPPORTED_CHANNEL",
        "Only slack, telegram, and discord are supported.",
      ),
    );
  } catch (error) {
    logWarn("admin.smoke_webhook_failed", {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(new ApiError(503, "SEND_FAILED", "Failed to send smoke webhook."));
  }
}

// ---- DELETE: remove test channels ----------------------------------------

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    await mutateMeta((meta) => {
      meta.channels.slack = null;
      meta.channels.telegram = null;
      meta.channels.discord = null;
    });
    await getStore().deleteValue(DISCORD_SMOKE_PRIVATE_KEY_STORE_KEY);
    logInfo("admin.smoke_channels_removed", {});
    return authJsonOk({ removed: true }, auth);
  } catch (error) {
    logWarn("admin.smoke_channels_remove_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(new ApiError(503, "REMOVE_FAILED", "Failed to remove test channels."));
  }
}
