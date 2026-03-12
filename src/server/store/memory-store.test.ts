/**
 * Tests for MemoryStore — the in-memory store backend.
 *
 * Covers: meta CRUD, key-value get/set with TTL, queue operations (enqueue,
 * dequeue, enqueueFront, enqueueUnique), lease-based queue operations,
 * lock acquisition/renewal/release, and garbage collection.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultMeta } from "@/shared/types";
import { MemoryStore } from "@/server/store/memory-store";

function makeStore(): MemoryStore {
  return new MemoryStore();
}

function makeMeta(version = 1) {
  const meta = createDefaultMeta(Date.now(), "test-token");
  meta.version = version;
  return meta;
}

// ---------------------------------------------------------------------------
// Meta operations
// ---------------------------------------------------------------------------

test("memory-store: getMeta returns null initially", async () => {
  const store = makeStore();
  assert.equal(await store.getMeta(), null);
});

test("memory-store: setMeta + getMeta round-trips", async () => {
  const store = makeStore();
  const meta = makeMeta();
  await store.setMeta(meta);
  const retrieved = await store.getMeta();
  assert.deepEqual(retrieved, meta);
});

test("memory-store: getMeta returns a clone", async () => {
  const store = makeStore();
  const meta = makeMeta();
  await store.setMeta(meta);
  const a = await store.getMeta();
  const b = await store.getMeta();
  assert.notStrictEqual(a, b, "should return distinct objects");
  assert.deepEqual(a, b);
});

test("memory-store: createMetaIfAbsent creates when absent", async () => {
  const store = makeStore();
  const meta = makeMeta();
  const created = await store.createMetaIfAbsent(meta);
  assert.equal(created, true);
  assert.deepEqual(await store.getMeta(), meta);
});

test("memory-store: createMetaIfAbsent does not overwrite when present", async () => {
  const store = makeStore();
  const first = makeMeta(1);
  const second = makeMeta(2);
  await store.setMeta(first);
  const created = await store.createMetaIfAbsent(second);
  assert.equal(created, false);
  const retrieved = await store.getMeta();
  assert.equal(retrieved!.version, 1);
});

test("memory-store: compareAndSetMeta succeeds with matching version", async () => {
  const store = makeStore();
  const meta = makeMeta(1);
  await store.setMeta(meta);
  const next = makeMeta(2);
  const ok = await store.compareAndSetMeta(1, next);
  assert.equal(ok, true);
  assert.equal((await store.getMeta())!.version, 2);
});

test("memory-store: compareAndSetMeta fails with mismatched version", async () => {
  const store = makeStore();
  await store.setMeta(makeMeta(1));
  const ok = await store.compareAndSetMeta(99, makeMeta(2));
  assert.equal(ok, false);
  assert.equal((await store.getMeta())!.version, 1);
});

test("memory-store: compareAndSetMeta fails when no meta exists", async () => {
  const store = makeStore();
  const ok = await store.compareAndSetMeta(1, makeMeta());
  assert.equal(ok, false);
});

// ---------------------------------------------------------------------------
// Key-value operations
// ---------------------------------------------------------------------------

test("memory-store: getValue returns null for missing key", async () => {
  const store = makeStore();
  assert.equal(await store.getValue("missing"), null);
});

test("memory-store: setValue + getValue round-trips", async () => {
  const store = makeStore();
  await store.setValue("key1", { hello: "world" });
  const value = await store.getValue<{ hello: string }>("key1");
  assert.deepEqual(value, { hello: "world" });
});

test("memory-store: setValue overwrites existing", async () => {
  const store = makeStore();
  await store.setValue("key1", "first");
  await store.setValue("key1", "second");
  assert.equal(await store.getValue("key1"), "second");
});

test("memory-store: deleteValue removes key", async () => {
  const store = makeStore();
  await store.setValue("key1", "value");
  await store.deleteValue("key1");
  assert.equal(await store.getValue("key1"), null);
});

test("memory-store: TTL expires values", async () => {
  const store = makeStore();
  // Set with 0 TTL (expires immediately in next gc cycle)
  await store.setValue("ephemeral", "gone", 0);
  // Wait for gc to pick it up — gc runs on next operation
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await store.getValue("ephemeral"), null);
});

test("memory-store: non-TTL values persist", async () => {
  const store = makeStore();
  await store.setValue("persistent", "stays");
  // Trigger gc via another operation
  await store.getValue("other");
  assert.equal(await store.getValue("persistent"), "stays");
});

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

test("memory-store: enqueue + dequeue FIFO order", async () => {
  const store = makeStore();
  await store.enqueue("q", "first");
  await store.enqueue("q", "second");
  await store.enqueue("q", "third");
  assert.equal(await store.dequeue("q"), "first");
  assert.equal(await store.dequeue("q"), "second");
  assert.equal(await store.dequeue("q"), "third");
  assert.equal(await store.dequeue("q"), null);
});

test("memory-store: enqueue returns queue length", async () => {
  const store = makeStore();
  assert.equal(await store.enqueue("q", "a"), 1);
  assert.equal(await store.enqueue("q", "b"), 2);
  assert.equal(await store.enqueue("q", "c"), 3);
});

test("memory-store: enqueueFront puts item at front", async () => {
  const store = makeStore();
  await store.enqueue("q", "second");
  await store.enqueueFront("q", "first");
  assert.equal(await store.dequeue("q"), "first");
  assert.equal(await store.dequeue("q"), "second");
});

test("memory-store: dequeue from empty queue returns null", async () => {
  const store = makeStore();
  assert.equal(await store.dequeue("empty"), null);
});

test("memory-store: getQueueLength returns correct count", async () => {
  const store = makeStore();
  assert.equal(await store.getQueueLength("q"), 0);
  await store.enqueue("q", "a");
  assert.equal(await store.getQueueLength("q"), 1);
  await store.enqueue("q", "b");
  assert.equal(await store.getQueueLength("q"), 2);
  await store.dequeue("q");
  assert.equal(await store.getQueueLength("q"), 1);
});

// ---------------------------------------------------------------------------
// enqueueUnique (dedup)
// ---------------------------------------------------------------------------

test("memory-store: enqueueUnique enqueues first time", async () => {
  const store = makeStore();
  const result = await store.enqueueUnique("q", "dedup:1", 60, "job1");
  assert.equal(result.enqueued, true);
  assert.equal(result.queueLength, 1);
});

test("memory-store: enqueueUnique rejects duplicate within TTL", async () => {
  const store = makeStore();
  await store.enqueueUnique("q", "dedup:1", 60, "job1");
  const result = await store.enqueueUnique("q", "dedup:1", 60, "job1-dup");
  assert.equal(result.enqueued, false);
  assert.equal(result.queueLength, 1);
});

test("memory-store: enqueueUnique allows after dedup TTL expires", async () => {
  const store = makeStore();
  await store.enqueueUnique("q", "dedup:1", 0, "job1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await store.enqueueUnique("q", "dedup:1", 60, "job1-retry");
  assert.equal(result.enqueued, true);
});

// ---------------------------------------------------------------------------
// Lease-based queue operations
// ---------------------------------------------------------------------------

test("memory-store: leaseQueueItem moves item to processing", async () => {
  const store = makeStore();
  await store.enqueue("q", "job1");
  const now = Date.now();
  const leased = await store.leaseQueueItem("q", "q:proc", now, 300);
  assert.ok(leased, "should return leased value");

  const envelope = JSON.parse(leased!) as { job: string; visibilityTimeoutAt: number };
  assert.equal(envelope.job, "job1");
  assert.ok(envelope.visibilityTimeoutAt > now);

  // Main queue should be empty
  assert.equal(await store.getQueueLength("q"), 0);
  // Processing queue should have the leased item
  assert.equal(await store.getQueueLength("q:proc"), 1);
});

test("memory-store: leaseQueueItem returns null for empty queue", async () => {
  const store = makeStore();
  const leased = await store.leaseQueueItem("empty", "empty:proc", Date.now(), 300);
  assert.equal(leased, null);
});

test("memory-store: ackQueueItem removes from processing", async () => {
  const store = makeStore();
  await store.enqueue("q", "job1");
  const leased = await store.leaseQueueItem("q", "q:proc", Date.now(), 300);
  assert.ok(leased);

  const acked = await store.ackQueueItem("q:proc", leased!);
  assert.equal(acked, true);
  assert.equal(await store.getQueueLength("q:proc"), 0);
});

test("memory-store: ackQueueItem returns false for unknown item", async () => {
  const store = makeStore();
  const acked = await store.ackQueueItem("q:proc", "nonexistent");
  assert.equal(acked, false);
});

test("memory-store: updateQueueLease replaces lease value", async () => {
  const store = makeStore();
  await store.enqueue("q", "job1");
  const now = Date.now();
  const leased = await store.leaseQueueItem("q", "q:proc", now, 300);
  assert.ok(leased);

  const newLease = JSON.stringify({ job: "job1", leasedAt: now, visibilityTimeoutAt: now + 600_000 });
  const updated = await store.updateQueueLease("q:proc", leased!, newLease);
  assert.equal(updated, true);
});

test("memory-store: requeueExpiredLeases moves expired items back", async () => {
  const store = makeStore();
  await store.enqueue("q", "job1");
  const past = Date.now() - 1000;
  // Lease with a timeout in the past
  const leased = await store.leaseQueueItem("q", "q:proc", past, 0);
  assert.ok(leased);

  const now = Date.now();
  const moved = await store.requeueExpiredLeases("q", "q:proc", now);
  assert.equal(moved, 1);
  assert.equal(await store.getQueueLength("q"), 1);
  assert.equal(await store.getQueueLength("q:proc"), 0);
});

test("memory-store: requeueExpiredLeases does not move non-expired items", async () => {
  const store = makeStore();
  await store.enqueue("q", "job1");
  const now = Date.now();
  await store.leaseQueueItem("q", "q:proc", now, 600);

  const moved = await store.requeueExpiredLeases("q", "q:proc", now);
  assert.equal(moved, 0);
  assert.equal(await store.getQueueLength("q:proc"), 1);
});

// ---------------------------------------------------------------------------
// Lock operations
// ---------------------------------------------------------------------------

test("memory-store: acquireLock returns token on success", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token, "should return a token string");
  assert.equal(typeof token, "string");
});

test("memory-store: acquireLock returns null if already locked", async () => {
  const store = makeStore();
  await store.acquireLock("lock1", 60);
  const second = await store.acquireLock("lock1", 60);
  assert.equal(second, null);
});

test("memory-store: acquireLock succeeds after TTL expires", async () => {
  const store = makeStore();
  await store.acquireLock("lock1", 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token, "should acquire after expiry");
});

test("memory-store: renewLock extends TTL with matching token", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 1);
  assert.ok(token);
  const renewed = await store.renewLock("lock1", token!, 60);
  assert.equal(renewed, true);
});

test("memory-store: renewLock fails with wrong token", async () => {
  const store = makeStore();
  await store.acquireLock("lock1", 60);
  const renewed = await store.renewLock("lock1", "wrong-token", 60);
  assert.equal(renewed, false);
});

test("memory-store: releaseLock frees the lock", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token);
  await store.releaseLock("lock1", token!);
  // Should be able to acquire again
  const newToken = await store.acquireLock("lock1", 60);
  assert.ok(newToken, "should acquire after release");
});

test("memory-store: releaseLock is no-op with wrong token", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token);
  await store.releaseLock("lock1", "wrong-token");
  // Lock should still be held
  const second = await store.acquireLock("lock1", 60);
  assert.equal(second, null, "lock should still be held");
});

// ---------------------------------------------------------------------------
// Store name
// ---------------------------------------------------------------------------

test("memory-store: name is 'memory'", () => {
  const store = makeStore();
  assert.equal(store.name, "memory");
});
