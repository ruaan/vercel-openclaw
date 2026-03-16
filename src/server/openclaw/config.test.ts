import assert from "node:assert/strict";
import test from "node:test";

import { buildGatewayConfig } from "@/server/openclaw/config";

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

test("buildGatewayConfig disables insecure auth by default but always disables device auth", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: undefined,
    },
    () => {
      const config = JSON.parse(buildGatewayConfig()) as {
        gateway: {
          controlUi: {
            allowInsecureAuth: boolean;
            dangerouslyDisableDeviceAuth: boolean;
          };
        };
      };

      assert.equal(config.gateway.controlUi.allowInsecureAuth, false);
      assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
    },
  );
});

test("buildGatewayConfig reads insecure auth toggle from env", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: "yes",
    },
    () => {
      const config = JSON.parse(buildGatewayConfig()) as {
        gateway: {
          controlUi: {
            allowInsecureAuth: boolean;
            dangerouslyDisableDeviceAuth: boolean;
          };
        };
      };

      assert.equal(config.gateway.controlUi.allowInsecureAuth, true);
      assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
    },
  );
});

test("buildGatewayConfig throws for invalid boolean env values", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: "maybe",
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: undefined,
    },
    () => {
      assert.throws(
        () => buildGatewayConfig(),
        /OPENCLAW_ALLOW_INSECURE_AUTH must be one of: true, false, 1, 0, yes, no, on, off\./,
      );
    },
  );
});
