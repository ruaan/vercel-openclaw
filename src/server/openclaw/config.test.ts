import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGatewayConfig,
  buildWebSearchSkill,
  buildWebSearchScript,
  buildVisionSkill,
  buildVisionScript,
  buildTtsSkill,
  buildTtsScript,
  buildStructuredExtractSkill,
  buildStructuredExtractScript,
} from "@/server/openclaw/config";

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

// ---------------------------------------------------------------------------
// buildGatewayConfig — model aliases and providers
// ---------------------------------------------------------------------------

test("buildGatewayConfig with apiKey includes model aliases and providers", () => {
  const config = JSON.parse(buildGatewayConfig("test-key")) as Record<string, unknown>;

  // Model aliases
  const agents = config.agents as { defaults: { models: Record<string, unknown> } };
  assert.ok(agents.defaults.models["vercel-ai-gateway/openai/gpt-5.3-chat"]);
  assert.ok(agents.defaults.models["vercel-ai-gateway/google/gemini-3.1-flash-image-preview"]);

  // Provider models
  const models = config.models as { providers: { openai: { models: { id: string }[] } } };
  const modelIds = models.providers.openai.models.map((m) => m.id);
  assert.ok(modelIds.includes("gpt-image-1"));
  assert.ok(modelIds.includes("dall-e-3"));
  assert.ok(modelIds.includes("gpt-4o"));
  assert.ok(modelIds.includes("gpt-4o-mini-tts"));
  assert.ok(modelIds.includes("text-embedding-3-small"));
  assert.ok(modelIds.includes("text-embedding-3-large"));

  // Media tools
  const tools = config.tools as { media: { audio: { enabled: boolean } } };
  assert.equal(tools.media.audio.enabled, true);
});

// ---------------------------------------------------------------------------
// Skill builders — content assertions
// ---------------------------------------------------------------------------

test("buildWebSearchSkill returns valid skill metadata", () => {
  const skill = buildWebSearchSkill();
  assert.ok(skill.includes("name: web-search"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildWebSearchScript references web_search and chat completions", () => {
  const script = buildWebSearchScript();
  assert.ok(script.includes("web_search"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildVisionSkill returns valid skill metadata", () => {
  const skill = buildVisionSkill();
  assert.ok(skill.includes("name: vision"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildVisionScript references image_url and chat completions", () => {
  const script = buildVisionScript();
  assert.ok(script.includes("image_url"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildTtsSkill returns valid skill metadata", () => {
  const skill = buildTtsSkill();
  assert.ok(skill.includes("name: tts"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildTtsScript uses AI Gateway and outputs MEDIA line", () => {
  const script = buildTtsScript();
  assert.ok(script.includes("ai-gateway.vercel.sh/v1/audio/speech"));
  assert.ok(script.includes("MEDIA:"));
});

test("buildStructuredExtractSkill returns valid skill metadata", () => {
  const skill = buildStructuredExtractSkill();
  assert.ok(skill.includes("name: structured-extract"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildStructuredExtractScript uses json_schema response format", () => {
  const script = buildStructuredExtractScript();
  assert.ok(script.includes("json_schema"));
  assert.ok(script.includes("response_format"));
});
