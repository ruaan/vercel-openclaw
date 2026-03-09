import { randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";

import type { SingleMeta } from "@/shared/types";
import { getStoreEnv } from "@/server/env";

const META_KEY = "openclaw-single:meta";

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const RENEW_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

const CAS_META_LUA = `
local current = redis.call("get", KEYS[1])
if not current then
  return -1
end

local decoded = cjson.decode(current)
local currentVersion = tonumber(decoded["version"])
if not currentVersion then
  currentVersion = 1
end

if currentVersion ~= tonumber(ARGV[1]) then
  return 0
end

redis.call("set", KEYS[1], ARGV[2])
return 1
`;

const ENQUEUE_UNIQUE_LUA = `
local inserted = redis.call("set", KEYS[2], "1", "NX", "EX", tonumber(ARGV[2]))
if not inserted then
  return {0, redis.call("llen", KEYS[1])}
end

local queueLength = redis.call("lpush", KEYS[1], ARGV[1])
return {1, queueLength}
`;

const LEASE_QUEUE_ITEM_LUA = `
local rawJob = redis.call("rpoplpush", KEYS[1], KEYS[2])
if not rawJob then
  return nil
end

local leased = cjson.encode({
  job = rawJob,
  leasedAt = tonumber(ARGV[1]),
  visibilityTimeoutAt = tonumber(ARGV[2]),
})

redis.call("lset", KEYS[2], 0, leased)
return leased
`;

const ACK_QUEUE_ITEM_LUA = `
return redis.call("lrem", KEYS[1], 1, ARGV[1])
`;

const UPDATE_QUEUE_LEASE_LUA = `
local entries = redis.call("lrange", KEYS[1], 0, -1)
for index, entry in ipairs(entries) do
  if entry == ARGV[1] then
    redis.call("lset", KEYS[1], index - 1, ARGV[2])
    return 1
  end
end

return 0
`;

const REQUEUE_EXPIRED_LEASES_LUA = `
local nowMs = tonumber(ARGV[1])
local moved = 0
local entries = redis.call("lrange", KEYS[2], 0, -1)

for _, entry in ipairs(entries) do
  local ok, decoded = pcall(cjson.decode, entry)
  local rawJob = nil
  local visibilityTimeoutAt = nil

  if ok and type(decoded) == "table" then
    rawJob = decoded["job"]
    visibilityTimeoutAt = tonumber(decoded["visibilityTimeoutAt"])
  else
    rawJob = entry
  end

  if type(rawJob) == "string" and (not visibilityTimeoutAt or visibilityTimeoutAt <= nowMs) then
    if redis.call("lrem", KEYS[2], 1, entry) > 0 then
      redis.call("rpush", KEYS[1], rawJob)
      moved = moved + 1
    end
  end
end

return moved
`;

type StoreEnqueueUniqueResult = {
  enqueued: boolean;
  queueLength: number;
};

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

export class UpstashStore {
  readonly name = "upstash";

  constructor(private readonly redis: Redis) {}

  static fromEnv(): UpstashStore | null {
    const env = getStoreEnv();
    if (!env) {
      return null;
    }

    return new UpstashStore(
      new Redis({
        url: env.url,
        token: env.token,
      }),
    );
  }

  async getMeta(): Promise<SingleMeta | null> {
    const raw = await this.redis.get<SingleMeta | string>(META_KEY);
    if (!raw) {
      return null;
    }

    if (typeof raw === "object") {
      return raw as SingleMeta;
    }

    try {
      return JSON.parse(raw) as SingleMeta;
    } catch {
      return null;
    }
  }

  async setMeta(meta: SingleMeta): Promise<void> {
    await this.redis.set(META_KEY, JSON.stringify(meta));
  }

  async createMetaIfAbsent(meta: SingleMeta): Promise<boolean> {
    const result = await this.redis.set(META_KEY, JSON.stringify(meta), { nx: true });
    return result === "OK";
  }

  async compareAndSetMeta(expectedVersion: number, next: SingleMeta): Promise<boolean> {
    const result = await this.redis.eval<[string, string], number>(
      CAS_META_LUA,
      [META_KEY],
      [String(expectedVersion), JSON.stringify(next)],
    );

    return toNumber(result) === 1;
  }

  async getValue<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get<T | string>(key);
    if (!raw) {
      return null;
    }

    if (typeof raw === "object") {
      return raw as T;
    }

    try {
      return JSON.parse(String(raw)) as T;
    } catch {
      return null;
    }
  }

  async setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (typeof ttlSeconds === "number") {
      await this.redis.set(key, payload, { ex: ttlSeconds });
      return;
    }

    await this.redis.set(key, payload);
  }

  async deleteValue(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async enqueue(key: string, value: string): Promise<number> {
    return this.redis.rpush(key, value);
  }

  async enqueueFront(key: string, value: string): Promise<number> {
    return this.redis.lpush(key, value);
  }

  async enqueueUnique(
    key: string,
    dedupKey: string,
    dedupTtlSeconds: number,
    value: string,
  ): Promise<StoreEnqueueUniqueResult> {
    const rawResult = await this.redis.eval<
      [string, string],
      [number | string, number | string]
    >(
      ENQUEUE_UNIQUE_LUA,
      [key, dedupKey],
      [value, String(dedupTtlSeconds)],
    );

    const enqueued = Array.isArray(rawResult) ? toNumber(rawResult[0]) === 1 : false;
    const queueLength = Array.isArray(rawResult) ? toNumber(rawResult[1]) : 0;

    return {
      enqueued,
      queueLength,
    };
  }

  async dequeue(key: string): Promise<string | null> {
    return this.redis.lpop<string>(key);
  }

  async leaseQueueItem(
    queueKey: string,
    processingKey: string,
    nowMs: number,
    visibilityTimeoutSeconds: number,
  ): Promise<string | null> {
    const leased = await this.redis.eval<[string, string], string | null>(
      LEASE_QUEUE_ITEM_LUA,
      [queueKey, processingKey],
      [
        String(nowMs),
        String(nowMs + visibilityTimeoutSeconds * 1000),
      ],
    );

    return typeof leased === "string" ? leased : null;
  }

  async ackQueueItem(processingKey: string, leasedValue: string): Promise<boolean> {
    const removed = await this.redis.eval<[string], number>(
      ACK_QUEUE_ITEM_LUA,
      [processingKey],
      [leasedValue],
    );

    return toNumber(removed) > 0;
  }

  async updateQueueLease(
    processingKey: string,
    currentLeasedValue: string,
    nextLeasedValue: string,
  ): Promise<boolean> {
    const updated = await this.redis.eval<[string, string], number>(
      UPDATE_QUEUE_LEASE_LUA,
      [processingKey],
      [currentLeasedValue, nextLeasedValue],
    );

    return toNumber(updated) > 0;
  }

  async requeueExpiredLeases(
    queueKey: string,
    processingKey: string,
    nowMs: number,
  ): Promise<number> {
    const moved = await this.redis.eval<[string], number>(
      REQUEUE_EXPIRED_LEASES_LUA,
      [queueKey, processingKey],
      [String(nowMs)],
    );

    return toNumber(moved);
  }

  async getQueueLength(key: string): Promise<number> {
    return this.redis.llen(key);
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, {
      nx: true,
      ex: ttlSeconds,
    });

    return result === "OK" ? token : null;
  }

  async renewLock(key: string, token: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.eval<[string, string], number>(
      RENEW_LOCK_LUA,
      [key],
      [token, String(ttlSeconds)],
    );

    return toNumber(result) > 0;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_LUA, [key], [token]);
  }
}
