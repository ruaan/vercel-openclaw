import assert from "node:assert/strict";
import test from "node:test";

import { type ChannelName } from "@/shared/channels";
import {
  enqueueChannelJob,
  drainChannelQueue,
  getChannelQueueDepth,
  type QueuedChannelJob,
} from "@/server/channels/driver";
import {
  channelDeadLetterKey,
  channelProcessingKey,
  channelQueueKey,
} from "@/server/channels/keys";
import {
  getStore,
  getInitializedMeta,
  mutateMeta,
  _resetStoreForTesting,
} from "@/server/store/store";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import type { ExtractedChannelMessage, PlatformAdapter } from "@/server/channels/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  AI_GATEWAY_API_KEY: "test-key",
};

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }

    _resetStoreForTesting();
  }
}

function createJob(
  overrides: Partial<QueuedChannelJob<{ text: string }>> = {},
): QueuedChannelJob<{ text: string }> {
  return {
    payload: { text: "hello" },
    receivedAt: 1,
    origin: "https://app.test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Existing tests
// ---------------------------------------------------------------------------

test("enqueueChannelJob deduplicates first-time jobs with the same payload", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";

    await enqueueChannelJob(channel, createJob());
    await enqueueChannelJob(
      channel,
      createJob({
        receivedAt: 2,
        origin: "https://duplicate.test",
      }),
    );

    assert.equal(await getChannelQueueDepth(channel), 1);
  });
});

test("enqueueChannelJob allows retries to bypass first-delivery deduplication", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";

    await enqueueChannelJob(channel, createJob());
    await enqueueChannelJob(
      channel,
      createJob({
        retryCount: 1,
        nextAttemptAt: Date.now() + 10_000,
      }),
    );

    assert.equal(await getChannelQueueDepth(channel), 2);
  });
});

test("getChannelQueueDepth counts leased jobs in the processing queue", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());
    const leasedValue = await store.leaseQueueItem(
      channelQueueKey(channel),
      channelProcessingKey(channel),
      Date.now(),
      60,
    );

    assert.ok(leasedValue);
    assert.equal(await getChannelQueueDepth(channel), 1);

    assert.equal(
      await store.ackQueueItem(channelProcessingKey(channel), leasedValue ?? ""),
      true,
    );
    assert.equal(await getChannelQueueDepth(channel), 0);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: drain lock miss
// ---------------------------------------------------------------------------

test("[drain] lock unavailable -> drainChannelQueue returns immediately", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    // Acquire the drain lock so drainChannelQueue can't get it
    const lockKey = `openclaw-single:channels:${channel}:drain-lock`;
    const token = await store.acquireLock(lockKey, 60);
    assert.ok(token);

    await enqueueChannelJob(channel, createJob());

    await drainChannelQueue({
      channel,
      getConfig: () => null,
      createAdapter: () => { throw new Error("should not be called"); },
    });

    // Job should still be in queue since drain couldn't acquire lock
    assert.equal(await getChannelQueueDepth(channel), 1);

    await store.releaseLock(lockKey, token);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: malformed leased job -> dead letter
// ---------------------------------------------------------------------------

test("[drain] malformed job JSON -> ack and write to dead letter", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    // Enqueue raw invalid JSON directly
    await store.enqueue(channelQueueKey(channel), "not-valid-json{{{");

    let adapterCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => {
        adapterCalled = true;
        return {} as PlatformAdapter<unknown, ExtractedChannelMessage>;
      },
    });

    // Should not have called the adapter
    assert.equal(adapterCalled, false);
    // Queue should be empty (acked)
    assert.equal(await getChannelQueueDepth(channel), 0);
    // Dead letter should have an entry
    const dlEntry = await store.dequeue(channelDeadLetterKey(channel));
    assert.ok(dlEntry);
    const parsed = JSON.parse(dlEntry);
    assert.equal(parsed.channel, channel);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: future nextAttemptAt -> job is parked, not processed
// ---------------------------------------------------------------------------

test("[drain] future nextAttemptAt -> job is parked in processing queue", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    const futureJob = createJob({
      retryCount: 1,
      nextAttemptAt: Date.now() + 60_000,
    });
    await enqueueChannelJob(channel, futureJob);

    let processCount = 0;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => {
        processCount += 1;
        return {} as PlatformAdapter<unknown, ExtractedChannelMessage>;
      },
    });

    // Job should NOT have been processed
    assert.equal(processCount, 0);
    // It should be parked in the processing queue (not lost)
    const processingLen = await store.getQueueLength(channelProcessingKey(channel));
    assert.ok(processingLen >= 1, "Parked job should be in processing queue");
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: enqueueChannelJob with explicit dedupId
// ---------------------------------------------------------------------------

test("[enqueue] explicit dedupId -> deduplicates on that ID, not payload hash", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "telegram";

    await enqueueChannelJob(channel, createJob({ dedupId: "custom-dedup-1" }));
    // Same dedupId, different payload
    await enqueueChannelJob(channel, createJob({
      payload: { text: "different" },
      dedupId: "custom-dedup-1",
    }));

    assert.equal(await getChannelQueueDepth(channel), 1);

    // Different dedupId, same payload
    await enqueueChannelJob(channel, createJob({ dedupId: "custom-dedup-2" }));
    assert.equal(await getChannelQueueDepth(channel), 2);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: enqueueChannelJob with nextAttemptAt set (retry path)
// ---------------------------------------------------------------------------

test("[enqueue] nextAttemptAt set -> enqueues to front (retry path)", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "discord";

    // Enqueue a normal job first
    await enqueueChannelJob(channel, createJob({ payload: { text: "first" } }));

    // Enqueue a retry with nextAttemptAt — should go to front
    await enqueueChannelJob(channel, createJob({
      payload: { text: "retry" },
      nextAttemptAt: Date.now() + 1000,
    }));

    assert.equal(await getChannelQueueDepth(channel), 2);

    // Dequeue should get the retry first (it was pushed to front)
    const store = getStore();
    const first = await store.dequeue(channelQueueKey(channel));
    assert.ok(first);
    const parsed = JSON.parse(first);
    assert.equal(parsed.payload.text, "retry");
  });
});

// ---------------------------------------------------------------------------
// Failure path: extractMessage throws -> dead-lettered without retry
// ---------------------------------------------------------------------------

test("[drain] adapter extractMessage throws -> job dead-lettered without retry", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());

    let sendReplyCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          throw new Error("payload_parse_failure");
        },
        sendReply: async () => {
          sendReplyCalled = true;
        },
      }),
    });

    // sendReply should NOT have been called
    assert.equal(sendReplyCalled, false);
    // Main and processing queues should be empty
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
    // Dead letter should have exactly 1 entry
    const dlEntry = await store.dequeue(channelDeadLetterKey(channel));
    assert.ok(dlEntry);
    const parsed = JSON.parse(dlEntry);
    assert.equal(parsed.channel, channel);
    assert.match(parsed.error, /payload_parse_failure/);
    // No second dead letter entry
    const dlEntry2 = await store.dequeue(channelDeadLetterKey(channel));
    assert.equal(dlEntry2, null);
  });
});

// ---------------------------------------------------------------------------
// Failure path: getConfig returns null -> dead-lettered (not configured)
// ---------------------------------------------------------------------------

test("[drain] getConfig returns null -> job dead-lettered with not_configured error", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "telegram";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());

    await drainChannelQueue({
      channel,
      getConfig: () => null,
      createAdapter: () => {
        throw new Error("createAdapter should not be called");
      },
    });

    // Main and processing queues should be empty
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
    // Dead letter should have 1 entry with not_configured error
    const dlEntry = await store.dequeue(channelDeadLetterKey(channel));
    assert.ok(dlEntry);
    const parsed = JSON.parse(dlEntry);
    assert.equal(parsed.channel, channel);
    assert.match(parsed.error, /not_configured/);
  });
});

// ---------------------------------------------------------------------------
// Failure path: multiple malformed jobs in sequence -> all dead-lettered
// ---------------------------------------------------------------------------

test("[drain] multiple malformed jobs -> all dead-lettered, adapter never called", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "discord";
    const store = getStore();

    // Enqueue 3 malformed JSON strings directly
    await store.enqueue(channelQueueKey(channel), "bad-json-1");
    await store.enqueue(channelQueueKey(channel), "bad-json-2");
    await store.enqueue(channelQueueKey(channel), "bad-json-3");

    let adapterCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => {
        adapterCalled = true;
        return {} as PlatformAdapter<unknown, ExtractedChannelMessage>;
      },
    });

    // Adapter should never have been called
    assert.equal(adapterCalled, false);
    // Main and processing queues should be empty
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
    // Dead letter should have exactly 3 entries
    const dl1 = await store.dequeue(channelDeadLetterKey(channel));
    const dl2 = await store.dequeue(channelDeadLetterKey(channel));
    const dl3 = await store.dequeue(channelDeadLetterKey(channel));
    assert.ok(dl1);
    assert.ok(dl2);
    assert.ok(dl3);
    const dl4 = await store.dequeue(channelDeadLetterKey(channel));
    assert.equal(dl4, null);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: retry job with past nextAttemptAt -> processed normally
// ---------------------------------------------------------------------------

test("[drain] job with nextAttemptAt in the past -> processed, not parked", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    const pastJob = createJob({
      retryCount: 8,
      nextAttemptAt: Date.now() - 1_000,
    });
    await enqueueChannelJob(channel, pastJob);

    let extractMessageCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          extractMessageCalled = true;
          // Return a skip to avoid needing full sandbox mocks
          return { kind: "skip" as const, reason: "test-skip" };
        },
        sendReply: async () => {},
      }),
    });

    // The adapter's extractMessage should have been called (job was processed)
    assert.equal(extractMessageCalled, true);
    // Queues should be empty after processing
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
  });
});
