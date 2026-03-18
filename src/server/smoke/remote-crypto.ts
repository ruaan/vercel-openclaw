/**
 * Pure Node.js crypto helpers for signing channel webhooks in the remote smoke runner.
 * No dependency on test-utils — these are standalone functions.
 */

import { createHmac, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

/**
 * Sign a Slack webhook payload using HMAC-SHA256.
 * Returns the headers needed for a valid Slack webhook request.
 */
export function signSlackPayload(
  signingSecret: string,
  rawBody: string,
): { "x-slack-signature": string; "x-slack-request-timestamp": string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  return {
    "x-slack-signature": `v0=${digest}`,
    "x-slack-request-timestamp": timestamp,
  };
}

/**
 * Build a minimal Slack app_mention webhook payload.
 */
export function buildSlackSmokePayload(): { body: string; dedupTs: string } {
  const ts = `${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
  const payload = {
    type: "event_callback",
    event: {
      type: "app_mention",
      text: "smoke-test: reply with exactly smoke-ok",
      channel: "C_SMOKE_TEST",
      ts,
      user: "U_SMOKE",
    },
  };
  return { body: JSON.stringify(payload), dedupTs: ts };
}

/**
 * Build a minimal Telegram message webhook payload.
 */
export function buildTelegramSmokePayload(): string {
  const updateId = Math.floor(Math.random() * 1_000_000_000);
  const payload = {
    update_id: updateId,
    message: {
      message_id: updateId,
      text: "/ask smoke-test: reply with exactly smoke-ok",
      chat: { id: 999_999_999, type: "private" },
      from: { id: 999_999_998, is_bot: false, first_name: "SmokeTest" },
      date: Math.floor(Date.now() / 1000),
    },
  };
  return JSON.stringify(payload);
}

export type DiscordSmokeKeyPair = {
  publicKeyHex: string;
  privateKeyPkcs8Pem: string;
};

const DISCORD_ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

export function generateDiscordSmokeKeyPair(): DiscordSmokeKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = spki.subarray(DISCORD_ED25519_SPKI_PREFIX.length);
  return {
    publicKeyHex: rawPublicKey.toString("hex"),
    privateKeyPkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signDiscordPayload(
  privateKeyPkcs8Pem: string,
  rawBody: string,
): { "x-signature-ed25519": string; "x-signature-timestamp": string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const privateKey = createPrivateKey(privateKeyPkcs8Pem);
  const message = Buffer.from(`${timestamp}${rawBody}`, "utf8");
  const signature = sign(null, message, privateKey).toString("hex");
  return {
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  };
}

export function buildDiscordSmokePayload(): string {
  const interactionId = `interaction-${Date.now()}`;
  const payload = {
    id: interactionId,
    type: 2,
    token: `discord-smoke-token-${Date.now()}`,
    application_id: "discord-smoke-app",
    channel_id: "discord-smoke-channel",
    member: {
      user: { id: "discord-smoke-user" },
    },
    data: {
      name: "ask",
      options: [
        {
          name: "text",
          value: "smoke-test: reply with exactly smoke-ok",
        },
      ],
    },
  };
  return JSON.stringify(payload);
}
