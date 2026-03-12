import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  log,
  logInfo,
  logWarn,
  logError,
  logDebug,
  getServerLogs,
  getFilteredServerLogs,
  extractRequestId,
  _resetLogBuffer,
} from "@/server/log";

beforeEach(() => {
  _resetLogBuffer();
});

describe("log() ring buffer", () => {
  it("stores entries in the buffer", () => {
    log("info", "test message");
    const logs = getServerLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "test message");
    assert.equal(logs[0].level, "info");
  });

  it("generates unique ids with slog- prefix", () => {
    log("info", "first");
    log("info", "second");
    const logs = getServerLogs();
    assert.ok(logs[0].id.startsWith("slog-"), `Expected slog- prefix, got ${logs[0].id}`);
    assert.ok(logs[1].id.startsWith("slog-"), `Expected slog- prefix, got ${logs[1].id}`);
    assert.notEqual(logs[0].id, logs[1].id);
  });

  it("assigns timestamps", () => {
    const before = Date.now();
    log("info", "timed");
    const after = Date.now();
    const entry = getServerLogs()[0];
    assert.ok(entry.timestamp >= before && entry.timestamp <= after);
  });

  it("evicts oldest entries when buffer exceeds 1000", () => {
    for (let i = 0; i < 1050; i++) {
      log("info", `msg-${i}`);
    }
    const logs = getServerLogs();
    assert.equal(logs.length, 1000);
    assert.equal(logs[0].message, "msg-50");
    assert.equal(logs[999].message, "msg-1049");
  });

  it("stores context data", () => {
    log("warn", "with data", { key: "value", count: 42 });
    const entry = getServerLogs()[0];
    assert.deepEqual(entry.data, { key: "value", count: 42 });
  });

  it("omits data field when context is empty", () => {
    log("info", "no ctx");
    const entry = getServerLogs()[0];
    assert.equal(entry.data, undefined);
  });

  it("omits data field when context only contains source", () => {
    log("info", "system.test", { source: "system" });
    const entry = getServerLogs()[0];
    assert.equal(entry.data, undefined);
  });

  it("convenience helpers log at correct levels", () => {
    logInfo("i");
    logWarn("w");
    logError("e");
    logDebug("d");
    const logs = getServerLogs();
    assert.equal(logs.length, 4);
    assert.equal(logs[0].level, "info");
    assert.equal(logs[1].level, "warn");
    assert.equal(logs[2].level, "error");
    assert.equal(logs[3].level, "debug");
  });
});

describe("inferSource() prefix mapping", () => {
  it("maps sandbox prefix to lifecycle", () => {
    log("info", "sandbox.create started");
    assert.equal(getServerLogs()[0].source, "lifecycle");
  });

  it("maps gateway prefix to proxy", () => {
    log("info", "gateway.probe ready");
    assert.equal(getServerLogs()[0].source, "proxy");
  });

  it("maps firewall prefix to firewall", () => {
    log("info", "firewall.sync complete");
    assert.equal(getServerLogs()[0].source, "firewall");
  });

  it("maps channels prefix to channels", () => {
    log("info", "channels.drain started");
    assert.equal(getServerLogs()[0].source, "channels");
  });

  it("maps auth prefix to auth", () => {
    log("info", "auth.verify token");
    assert.equal(getServerLogs()[0].source, "auth");
  });

  it("defaults to system for unknown prefixes", () => {
    log("info", "unknown.thing happened");
    assert.equal(getServerLogs()[0].source, "system");
  });

  it("uses explicit source from context over prefix", () => {
    log("info", "sandbox.create", { source: "auth" });
    assert.equal(getServerLogs()[0].source, "auth");
  });

  it("uses source prefix key from context mapping", () => {
    log("info", "some message", { source: "firewall" });
    assert.equal(getServerLogs()[0].source, "firewall");
  });

  it("defaults to system for no dots in message", () => {
    log("info", "plain message");
    assert.equal(getServerLogs()[0].source, "system");
  });
});

describe("extractRequestId()", () => {
  it("prefers x-vercel-id header", () => {
    const req = new Request("https://example.com", {
      headers: {
        "x-vercel-id": "vercel-123",
        "x-request-id": "req-456",
      },
    });
    assert.equal(extractRequestId(req), "vercel-123");
  });

  it("falls back to x-request-id", () => {
    const req = new Request("https://example.com", {
      headers: { "x-request-id": "req-456" },
    });
    assert.equal(extractRequestId(req), "req-456");
  });

  it("returns undefined when no ID headers present", () => {
    const req = new Request("https://example.com");
    assert.equal(extractRequestId(req), undefined);
  });
});

describe("getFilteredServerLogs()", () => {
  beforeEach(() => {
    _resetLogBuffer();
    log("info", "sandbox.create started");
    log("warn", "firewall.sync delayed", { extra: "data" });
    log("error", "auth.verify failed");
    log("info", "channels.drain ok");
    log("debug", "gateway.probe check");
  });

  it("filters by level", () => {
    const results = getFilteredServerLogs({ level: "warn" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "firewall.sync delayed");
  });

  it("filters by source", () => {
    const results = getFilteredServerLogs({ source: "auth" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "auth.verify failed");
  });

  it("filters by search term in message", () => {
    const results = getFilteredServerLogs({ search: "drain" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "channels.drain ok");
  });

  it("filters by search term in data", () => {
    const results = getFilteredServerLogs({ search: "extra" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "firewall.sync delayed");
  });

  it("combines level and source filters", () => {
    const results = getFilteredServerLogs({ level: "info", source: "lifecycle" });
    assert.equal(results.length, 1);
    assert.equal(results[0].message, "sandbox.create started");
  });

  it("returns empty array when no matches", () => {
    const results = getFilteredServerLogs({ level: "debug", source: "auth" });
    assert.equal(results.length, 0);
  });

  it("returns all entries with no filters", () => {
    const results = getFilteredServerLogs({});
    assert.equal(results.length, 5);
  });

  it("search is case-insensitive", () => {
    const results = getFilteredServerLogs({ search: "DRAIN" });
    assert.equal(results.length, 1);
  });

  it("returns a copy, not a reference to internal buffer", () => {
    const results = getFilteredServerLogs({});
    results.push({
      id: "fake",
      timestamp: 0,
      level: "info",
      source: "system",
      message: "injected",
    });
    assert.equal(getServerLogs().length, 5);
  });
});

describe("_resetLogBuffer()", () => {
  it("clears all entries", () => {
    log("info", "before reset");
    assert.equal(getServerLogs().length, 1);
    _resetLogBuffer();
    assert.equal(getServerLogs().length, 0);
  });

  it("resets id counter so new ids start fresh", () => {
    log("info", "first");
    const firstId = getServerLogs()[0].id;
    _resetLogBuffer();
    log("info", "after reset");
    const afterId = getServerLogs()[0].id;
    const firstNum = parseInt(firstId.split("-").pop()!, 10);
    const afterNum = parseInt(afterId.split("-").pop()!, 10);
    assert.ok(afterNum <= firstNum, "ID counter should reset");
  });
});
