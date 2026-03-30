import assert from "node:assert/strict";
import test from "node:test";

import { RetryableSendError } from "@/server/channels/core/types";
import type { ChannelReply } from "@/server/channels/core/types";
import {
  createTelegramAdapter,
  isTelegramWebhookSecretValid,
  normalizeTelegramSlashCommand,
} from "@/server/channels/telegram/adapter";

test("isTelegramWebhookSecretValid accepts current and unexpired previous secrets", () => {
  const now = Date.now();
  const config = {
    botToken: "bot-token",
    webhookSecret: "current-secret",
    previousWebhookSecret: "previous-secret",
    previousSecretExpiresAt: now + 60_000,
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: now,
  };

  assert.equal(isTelegramWebhookSecretValid(config, "current-secret", now), true);
  assert.equal(isTelegramWebhookSecretValid(config, "previous-secret", now), true);
  assert.equal(isTelegramWebhookSecretValid(config, "previous-secret", now + 120_000), false);
});

test("createTelegramAdapter extracts chat text updates", async () => {
  const adapter = createTelegramAdapter({
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    update_id: 1,
    message: {
      text: "hello telegram",
      chat: {
        id: 42,
      },
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "hello telegram");
  assert.equal(result.message.chatId, "42");
});

test("normalizeTelegramSlashCommand strips matching bot mention", () => {
  assert.deepEqual(
    normalizeTelegramSlashCommand("/ask@openclaw_bot hi there", "openclaw_bot"),
    { shouldHandle: true, text: "/ask hi there" },
  );
});

test("createTelegramAdapter skips slash commands addressed to another bot", async () => {
  const adapter = createTelegramAdapter({
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    update_id: 1,
    message: {
      text: "/ask@other_bot hi",
      chat: {
        id: 42,
      },
    },
  });

  assert.deepEqual(result, { kind: "skip", reason: "command_for_other_bot" });
});

test("createTelegramAdapter normalizes matching slash commands in group chats", async () => {
  const adapter = createTelegramAdapter({
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    update_id: 1,
    message: {
      text: "/ask@openclaw_bot hi",
      chat: {
        id: 42,
      },
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "/ask hi");
});

test("createTelegramAdapter startProcessingIndicator triggers chat action immediately and stops cleanly", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
    });
  };

  try {
    const adapter = createTelegramAdapter({
      botToken: "bot-token",
      webhookSecret: "secret",
      webhookUrl: "https://example.com/api/channels/telegram/webhook",
      botUsername: "openclaw_bot",
      configuredAt: Date.now(),
    });

    const indicator = await adapter.startProcessingIndicator?.({
      text: "hello telegram",
      chatId: "42",
    });

    assert.ok(indicator, "startProcessingIndicator should return an indicator");
    assert.equal(calls.length, 1, "should fire first pulse immediately");
    assert.ok(
      calls[0]?.includes("sendChatAction"),
      "should call sendChatAction",
    );

    await indicator.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramAdapter sendReply throws RetryableSendError when Telegram rate limits", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: {
          retry_after: 11,
        },
      }),
      {
        status: 429,
      },
    );

  try {
    const adapter = createTelegramAdapter({
      botToken: "bot-token",
      webhookSecret: "secret",
      webhookUrl: "https://example.com/api/channels/telegram/webhook",
      botUsername: "openclaw_bot",
      configuredAt: Date.now(),
    });

    await assert.rejects(
      adapter.sendReply(
        {
          text: "hello telegram",
          chatId: "42",
        },
        "reply text",
      ),
      (error) => {
        assert.ok(error instanceof RetryableSendError);
        assert.equal(error.retryAfterSeconds, 11);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// sendReplyRich — generic media dispatch
// ---------------------------------------------------------------------------

function makeTelegramConfig() {
  return {
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  };
}

test("createTelegramAdapter sendReplyRich sends audio via sendAudio", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42 } } }), {
      status: 200,
    });
  };

  try {
    const adapter = createTelegramAdapter(makeTelegramConfig());
    const reply: ChannelReply = {
      text: "Here is your audio.",
      media: [
        {
          type: "audio",
          source: {
            kind: "data",
            mimeType: "audio/mpeg",
            base64: "SUQzBAAAAAAA",
            filename: "answer.mp3",
          },
        },
      ],
    };

    await adapter.sendReplyRich!(
      { text: "generate audio", chatId: "42" },
      reply,
    );

    assert.ok(calls.some((c) => c.includes("sendAudio")), "should call sendAudio");
    assert.ok(!calls.some((c) => c.includes("sendPhoto")), "should not call sendPhoto");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramAdapter sendReplyRich sends document for generic files", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42 } } }), {
      status: 200,
    });
  };

  try {
    const adapter = createTelegramAdapter(makeTelegramConfig());
    const reply: ChannelReply = {
      text: "Report attached.",
      media: [
        {
          type: "file",
          source: {
            kind: "data",
            mimeType: "application/pdf",
            base64: "JVBERi0xLjQK",
            filename: "report.pdf",
          },
        },
      ],
    };

    await adapter.sendReplyRich!(
      { text: "get report", chatId: "42" },
      reply,
    );

    assert.ok(calls.some((c) => c.includes("sendDocument")), "should call sendDocument");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramAdapter sendReplyRich sends video via sendVideo", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42 } } }), {
      status: 200,
    });
  };

  try {
    const adapter = createTelegramAdapter(makeTelegramConfig());
    const reply: ChannelReply = {
      text: "Video ready.",
      media: [
        {
          type: "video",
          source: {
            kind: "data",
            mimeType: "video/mp4",
            base64: "AAAAIGZ0eXA=",
            filename: "clip.mp4",
          },
        },
      ],
    };

    await adapter.sendReplyRich!(
      { text: "make video", chatId: "42" },
      reply,
    );

    assert.ok(calls.some((c) => c.includes("sendVideo")), "should call sendVideo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramAdapter sendReplyRich image regression — sends photo via sendPhoto", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42 } } }), {
      status: 200,
    });
  };

  try {
    const adapter = createTelegramAdapter(makeTelegramConfig());
    const reply: ChannelReply = {
      text: "Chart ready.",
      media: [
        {
          type: "image",
          source: {
            kind: "data",
            mimeType: "image/png",
            base64: "iVBORw0KGgo=",
            filename: "chart.png",
          },
        },
      ],
    };

    await adapter.sendReplyRich!(
      { text: "generate chart", chatId: "42" },
      reply,
    );

    assert.ok(calls.some((c) => c.includes("sendPhoto")), "should call sendPhoto for images");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramAdapter sendReplyRich dispatches mixed media types", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42 } } }), {
      status: 200,
    });
  };

  try {
    const adapter = createTelegramAdapter(makeTelegramConfig());
    const reply: ChannelReply = {
      text: "Results.",
      media: [
        { type: "image", source: { kind: "data", mimeType: "image/png", base64: "iVBORw0KGgo=", filename: "chart.png" } },
        { type: "audio", source: { kind: "data", mimeType: "audio/mpeg", base64: "SUQzBAAAAAAA", filename: "audio.mp3" } },
        { type: "video", source: { kind: "data", mimeType: "video/mp4", base64: "AAAAIGZ0eXA=", filename: "video.mp4" } },
        { type: "file", source: { kind: "data", mimeType: "application/pdf", base64: "JVBERi0xLjQK", filename: "doc.pdf" } },
      ],
    };

    await adapter.sendReplyRich!(
      { text: "all media", chatId: "42" },
      reply,
    );

    assert.ok(calls.some((c) => c.includes("sendPhoto")), "should call sendPhoto");
    assert.ok(calls.some((c) => c.includes("sendAudio")), "should call sendAudio");
    assert.ok(calls.some((c) => c.includes("sendVideo")), "should call sendVideo");
    assert.ok(calls.some((c) => c.includes("sendDocument")), "should call sendDocument");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
