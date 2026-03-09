import { randomUUID } from "node:crypto";

import type { SingleMeta } from "@/shared/types";

type MemoryLock = {
  token: string;
  expiresAt: number;
};

type MemoryValue = {
  value: string;
  expiresAt: number | null;
};

type StoreEnqueueUniqueResult = {
  enqueued: boolean;
  queueLength: number;
};

type QueueLeaseEnvelope = {
  job: string;
  leasedAt: number;
  visibilityTimeoutAt: number;
};

export class MemoryStore {
  readonly name = "memory";

  private meta: SingleMeta | null = null;

  private readonly values = new Map<string, MemoryValue>();

  private readonly queues = new Map<string, string[]>();

  private readonly locks = new Map<string, MemoryLock>();

  async getMeta(): Promise<SingleMeta | null> {
    return this.meta ? structuredClone(this.meta) : null;
  }

  async setMeta(meta: SingleMeta): Promise<void> {
    this.meta = structuredClone(meta);
  }

  async createMetaIfAbsent(meta: SingleMeta): Promise<boolean> {
    if (this.meta) {
      return false;
    }

    this.meta = structuredClone(meta);
    return true;
  }

  async compareAndSetMeta(expectedVersion: number, next: SingleMeta): Promise<boolean> {
    if (!this.meta) {
      return false;
    }

    const currentVersion =
      typeof this.meta.version === "number" && Number.isSafeInteger(this.meta.version)
        ? this.meta.version
        : 1;

    if (currentVersion !== expectedVersion) {
      return false;
    }

    this.meta = structuredClone(next);
    return true;
  }

  async getValue<T>(key: string): Promise<T | null> {
    this.gc();
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }

    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }

  async setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.gc();
    this.values.set(key, {
      value: JSON.stringify(value),
      expiresAt: typeof ttlSeconds === "number" ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async deleteValue(key: string): Promise<void> {
    this.values.delete(key);
  }

  async enqueue(key: string, value: string): Promise<number> {
    this.gc();
    const queue = this.queues.get(key) ?? [];
    queue.push(value);
    this.queues.set(key, queue);
    return queue.length;
  }

  async enqueueFront(key: string, value: string): Promise<number> {
    this.gc();
    const queue = this.queues.get(key) ?? [];
    queue.unshift(value);
    this.queues.set(key, queue);
    return queue.length;
  }

  async enqueueUnique(
    key: string,
    dedupKey: string,
    dedupTtlSeconds: number,
    value: string,
  ): Promise<StoreEnqueueUniqueResult> {
    this.gc();
    if (this.values.has(dedupKey)) {
      return {
        enqueued: false,
        queueLength: this.queues.get(key)?.length ?? 0,
      };
    }

    this.values.set(dedupKey, {
      value: JSON.stringify(true),
      expiresAt: Date.now() + dedupTtlSeconds * 1000,
    });

    const queueLength = await this.enqueueFront(key, value);
    return {
      enqueued: true,
      queueLength,
    };
  }

  async dequeue(key: string): Promise<string | null> {
    this.gc();
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      return null;
    }

    const value = queue.shift() ?? null;
    if (queue.length === 0) {
      this.queues.delete(key);
    } else {
      this.queues.set(key, queue);
    }
    return value;
  }

  async leaseQueueItem(
    queueKey: string,
    processingKey: string,
    nowMs: number,
    visibilityTimeoutSeconds: number,
  ): Promise<string | null> {
    this.gc();

    const queue = this.queues.get(queueKey);
    if (!queue || queue.length === 0) {
      return null;
    }

    const rawJob = queue.pop() ?? null;
    if (rawJob === null) {
      return null;
    }

    if (queue.length === 0) {
      this.queues.delete(queueKey);
    } else {
      this.queues.set(queueKey, queue);
    }

    const processing = this.queues.get(processingKey) ?? [];
    const leaseEnvelope: QueueLeaseEnvelope = {
      job: rawJob,
      leasedAt: nowMs,
      visibilityTimeoutAt: nowMs + visibilityTimeoutSeconds * 1000,
    };
    const leasedValue = JSON.stringify(leaseEnvelope);
    processing.unshift(leasedValue);
    this.queues.set(processingKey, processing);
    return leasedValue;
  }

  async ackQueueItem(processingKey: string, leasedValue: string): Promise<boolean> {
    this.gc();

    const processing = this.queues.get(processingKey);
    if (!processing || processing.length === 0) {
      return false;
    }

    const index = processing.indexOf(leasedValue);
    if (index < 0) {
      return false;
    }

    processing.splice(index, 1);
    if (processing.length === 0) {
      this.queues.delete(processingKey);
    } else {
      this.queues.set(processingKey, processing);
    }

    return true;
  }

  async updateQueueLease(
    processingKey: string,
    currentLeasedValue: string,
    nextLeasedValue: string,
  ): Promise<boolean> {
    this.gc();

    const processing = this.queues.get(processingKey);
    if (!processing || processing.length === 0) {
      return false;
    }

    const index = processing.indexOf(currentLeasedValue);
    if (index < 0) {
      return false;
    }

    processing[index] = nextLeasedValue;
    this.queues.set(processingKey, processing);
    return true;
  }

  async requeueExpiredLeases(
    queueKey: string,
    processingKey: string,
    nowMs: number,
  ): Promise<number> {
    this.gc();

    const processing = this.queues.get(processingKey);
    if (!processing || processing.length === 0) {
      return 0;
    }

    const queue = this.queues.get(queueKey) ?? [];
    let moved = 0;

    for (let index = processing.length - 1; index >= 0; index -= 1) {
      const entry = processing[index];
      if (!entry) {
        continue;
      }

      let rawJob: string | null = entry;
      let visibilityTimeoutAt = 0;

      try {
        const parsed = JSON.parse(entry) as Partial<QueueLeaseEnvelope>;
        if (typeof parsed.job === "string") {
          rawJob = parsed.job;
          visibilityTimeoutAt =
            typeof parsed.visibilityTimeoutAt === "number" ? parsed.visibilityTimeoutAt : 0;
        }
      } catch {
        rawJob = entry;
      }

      if (!rawJob || visibilityTimeoutAt > nowMs) {
        continue;
      }

      processing.splice(index, 1);
      queue.push(rawJob);
      moved += 1;
    }

    if (processing.length === 0) {
      this.queues.delete(processingKey);
    } else {
      this.queues.set(processingKey, processing);
    }

    if (queue.length > 0) {
      this.queues.set(queueKey, queue);
    }

    return moved;
  }

  async getQueueLength(key: string): Promise<number> {
    this.gc();
    return this.queues.get(key)?.length ?? 0;
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    this.gc();
    const existing = this.locks.get(key);
    if (existing) {
      return null;
    }

    const token = randomUUID();
    this.locks.set(key, {
      token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    return token;
  }

  async renewLock(key: string, token: string, ttlSeconds: number): Promise<boolean> {
    this.gc();

    const current = this.locks.get(key);
    if (!current || current.token !== token) {
      return false;
    }

    this.locks.set(key, {
      token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    return true;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    const current = this.locks.get(key);
    if (current?.token === token) {
      this.locks.delete(key);
    }
  }

  private gc(): void {
    const now = Date.now();

    for (const [key, value] of this.locks.entries()) {
      if (value.expiresAt <= now) {
        this.locks.delete(key);
      }
    }

    for (const [key, value] of this.values.entries()) {
      if (value.expiresAt !== null && value.expiresAt <= now) {
        this.values.delete(key);
      }
    }
  }
}
