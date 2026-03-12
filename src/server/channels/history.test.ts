import assert from "node:assert/strict";
import test from "node:test";

import { channelSessionHistoryKey } from "@/server/channels/keys";
import {
  readSessionHistory,
  appendSessionHistory,
} from "@/server/channels/history";
import { withHarness } from "@/test-utils/harness";

test("readSessionHistory returns empty array when no history exists", async () => {
  await withHarness(async () => {
    const history = await readSessionHistory("slack", "sess-1");
    assert.deepEqual(history, []);
  });
});

test("appendSessionHistory persists user and assistant messages", async () => {
  await withHarness(async () => {
    await appendSessionHistory("slack", "sess-1", "hello", "hi there");
    const history = await readSessionHistory("slack", "sess-1");
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], { role: "user", content: "hello" });
    assert.deepEqual(history[1], { role: "assistant", content: "hi there" });
  });
});

test("appendSessionHistory accumulates multiple exchanges", async () => {
  await withHarness(async () => {
    await appendSessionHistory("telegram", "sess-2", "msg1", "reply1");
    await appendSessionHistory("telegram", "sess-2", "msg2", "reply2");
    const history = await readSessionHistory("telegram", "sess-2");
    assert.equal(history.length, 4);
    assert.equal(history[0]!.content, "msg1");
    assert.equal(history[2]!.content, "msg2");
  });
});

test("appendSessionHistory trims to max 20 entries", async () => {
  await withHarness(async () => {
    // Append 12 exchanges = 24 messages, should trim to last 20
    for (let i = 0; i < 12; i++) {
      await appendSessionHistory("discord", "sess-3", `user-${i}`, `bot-${i}`);
    }
    const history = await readSessionHistory("discord", "sess-3");
    assert.equal(history.length, 20);
    // Oldest 4 messages (2 exchanges) should be gone
    assert.equal(history[0]!.content, "user-2");
    assert.equal(history[1]!.content, "bot-2");
  });
});

test("readSessionHistory filters out malformed entries", async () => {
  await withHarness(async (h) => {
    const store = h.getStore();
    const key = channelSessionHistoryKey("slack", "sess-bad");
    // Write garbage alongside valid entries
    await store.setValue(key, [
      { role: "user", content: "valid" },
      null,
      { role: "system", content: "wrong role" },
      { content: "missing role" },
      { role: "assistant" },
      { role: "assistant", content: "also valid" },
      42,
      [1, 2, 3],
    ]);
    const history = await readSessionHistory("slack", "sess-bad");
    assert.equal(history.length, 2);
    assert.equal(history[0]!.content, "valid");
    assert.equal(history[1]!.content, "also valid");
  });
});

test("readSessionHistory returns empty for non-array stored value", async () => {
  await withHarness(async (h) => {
    const store = h.getStore();
    const key = channelSessionHistoryKey("slack", "sess-obj");
    await store.setValue(key, { not: "an array" });
    const history = await readSessionHistory("slack", "sess-obj");
    assert.deepEqual(history, []);
  });
});

test("session history uses correct store keys per channel", async () => {
  await withHarness(async () => {
    await appendSessionHistory("slack", "key-1", "s-msg", "s-reply");
    await appendSessionHistory("telegram", "key-1", "t-msg", "t-reply");

    const slackHistory = await readSessionHistory("slack", "key-1");
    const telegramHistory = await readSessionHistory("telegram", "key-1");

    assert.equal(slackHistory.length, 2);
    assert.equal(slackHistory[0]!.content, "s-msg");
    assert.equal(telegramHistory.length, 2);
    assert.equal(telegramHistory[0]!.content, "t-msg");
  });
});
