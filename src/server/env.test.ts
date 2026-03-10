import assert from "node:assert/strict";
import test from "node:test";

import { getBaseOrigin } from "@/server/env";

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
  }
}

test("getBaseOrigin returns the configured origin", () => {
  withEnv(
    {
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "https://example.com/app/path",
    },
    () => {
      const request = new Request("http://localhost:3000/api/test");
      assert.equal(getBaseOrigin(request), "https://example.com");
    },
  );
});

test("getBaseOrigin throws in production when NEXT_PUBLIC_APP_URL is missing", () => {
  withEnv(
    {
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_URL: undefined,
    },
    () => {
      const request = new Request("https://runtime.example/api/test");
      assert.throws(
        () => getBaseOrigin(request),
        /NEXT_PUBLIC_APP_URL is required in production/,
      );
    },
  );
});

test("getBaseOrigin falls back to the request origin outside production", () => {
  withEnv(
    {
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: undefined,
    },
    () => {
      const request = new Request("http://localhost:3000/api/test");
      assert.equal(getBaseOrigin(request), "http://localhost:3000");
    },
  );
});
