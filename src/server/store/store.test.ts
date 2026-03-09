import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultMeta } from "@/shared/types";
import {
  getInitializedMeta,
  getStore,
  mutateMeta,
  _resetStoreForTesting,
} from "@/server/store/store";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
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
    return fn();
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

test("getStore: throws when Upstash missing and NODE_ENV=production", () => {
  withEnv(
    {
      NODE_ENV: "production",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      assert.throws(() => getStore(), /Upstash Redis is required in production/);
    },
  );
});

test("getStore: throws when Upstash missing and VERCEL=1", () => {
  withEnv(
    {
      NODE_ENV: "development",
      VERCEL: "1",
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      assert.throws(() => getStore(), /Upstash Redis is required in production/);
    },
  );
});

test("getStore: falls back to MemoryStore in development", () => {
  withEnv(
    {
      NODE_ENV: "development",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      const store = getStore();
      assert.equal(store.name, "memory");
    },
  );
});

test("getStore: falls back to MemoryStore when NODE_ENV is test", () => {
  withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      const store = getStore();
      assert.equal(store.name, "memory");
    },
  );
});

test("getStore: compareAndSetMeta rejects stale versions and accepts current", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    async () => {
      const store = getStore();
      const meta = createDefaultMeta(Date.now(), "gateway-token");
      const created = await store.createMetaIfAbsent(meta);

      assert.equal(created, true);

      const staleWrite = await store.compareAndSetMeta(99, {
        ...meta,
        version: 100,
      });
      assert.equal(staleWrite, false);

      const currentWrite = await store.compareAndSetMeta(1, {
        ...meta,
        version: 2,
        status: "creating",
      });
      assert.equal(currentWrite, true);

      const persisted = await store.getMeta();
      assert.equal(persisted?.version, 2);
      assert.equal(persisted?.status, "creating");
    },
  );
});

test("mutateMeta: increments persisted version after initialization", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    async () => {
      const initial = await getInitializedMeta();
      assert.equal(initial.version, 1);

      const updated = await mutateMeta((meta) => {
        meta.status = "creating";
      });

      assert.equal(updated.version, 2);
      assert.equal(updated.status, "creating");

      const persisted = await getStore().getMeta();
      assert.equal(persisted?.version, 2);
      assert.equal(persisted?.status, "creating");
    },
  );
});
