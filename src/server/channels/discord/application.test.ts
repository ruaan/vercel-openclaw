import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildAuthPostRequest,
  getDiscordRegisterCommandRoute,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// registerSlashCommand via the register-command route
// ---------------------------------------------------------------------------

test("[discord application] registerSlashCommand succeeds and stores commandId", async () => {
  await withHarness(async (h) => {
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    // Mock Discord command registration endpoint
    h.fakeFetch.onPost(/discord\.com\/api\/v10\/applications\/.*\/commands/, () =>
      Response.json({ id: "cmd-12345", name: "ask" }),
    );

    try {
      const route = getDiscordRegisterCommandRoute();
      const request = buildAuthPostRequest(
        "/api/channels/discord/register-command",
        "{}",
      );
      const result = await callRoute(route.POST!, request);

      assert.equal(result.status, 200);
      const body = result.json as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.commandId, "cmd-12345");

      // Verify Discord API was called correctly
      const discordRequests = h.fakeFetch
        .requests()
        .filter(
          (r) =>
            r.method === "POST" &&
            r.url.includes("discord.com") &&
            r.url.includes("/commands"),
        );
      assert.ok(discordRequests.length >= 1, "Should have called Discord commands API");

      const reqBody = JSON.parse(discordRequests[0]!.body!);
      assert.equal(reqBody.name, "ask");
      assert.equal(reqBody.type, 1);
      assert.ok(Array.isArray(reqBody.options));

      // Verify meta was updated with command registration
      const meta = await h.getMeta();
      assert.equal(meta.channels.discord?.commandRegistered, true);
      assert.equal(meta.channels.discord?.commandId, "cmd-12345");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[discord application] registerSlashCommand Discord API failure returns error", async () => {
  await withHarness(async (h) => {
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    // Mock Discord command registration failure
    h.fakeFetch.onPost(/discord\.com\/api\/v10\/applications\/.*\/commands/, () =>
      new Response("Forbidden", { status: 403 }),
    );

    try {
      const route = getDiscordRegisterCommandRoute();
      const request = buildAuthPostRequest(
        "/api/channels/discord/register-command",
        "{}",
      );
      const result = await callRoute(route.POST!, request);

      assert.ok(result.status >= 400, `Expected error status, got ${result.status}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[discord application] registerSlashCommand when discord not configured returns 409", async () => {
  await withHarness(async () => {
    // Do NOT configure channels — discord config is null
    const route = getDiscordRegisterCommandRoute();
    const request = buildAuthPostRequest(
      "/api/channels/discord/register-command",
      "{}",
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 409);
    const body = result.json as Record<string, unknown>;
    assert.equal(body.error, "DISCORD_NOT_CONFIGURED");
  });
});
