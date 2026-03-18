import assert from "node:assert/strict";
import test from "node:test";

import { reconcileTelegramWebhook } from "@/server/channels/telegram/reconcile";
import { withHarness } from "@/test-utils/harness";

test("reconcileTelegramWebhook sets webhook and records timestamp", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-bot-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/setWebhook/, () =>
      Response.json({ ok: true, result: true }),
    );

    try {
      const changed = await reconcileTelegramWebhook({ force: true });
      assert.equal(changed, true);

      const requests = h.fakeFetch.requests();
      assert.equal(requests.length, 1);
      assert.ok(requests[0]?.url.includes("/setWebhook"));

      const store = h.getStore();
      const last = await store.getValue<number>(
        "telegram:webhook:last-reconciled-at",
      );
      assert.equal(typeof last, "number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileTelegramWebhook skips within throttle window", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-bot-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });
    await h
      .getStore()
      .setValue("telegram:webhook:last-reconciled-at", Date.now());

    const changed = await reconcileTelegramWebhook();
    assert.equal(changed, false);
  });
});
