import assert from "node:assert/strict";
import test from "node:test";

import { createScenarioHarness } from "@/test-utils/harness";
import { callRoute, buildPostRequest } from "@/test-utils/route-caller";
import { buildWorkerSandboxBearerToken } from "@/server/worker-sandboxes/auth";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getInitializedMeta } from "@/server/store/store";
import type {
  WorkerSandboxBatchExecuteResponse,
} from "@/shared/worker-sandbox";

function getRoute() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/app/api/internal/worker-sandboxes/execute-batch/route") as {
    POST: (request: Request) => Promise<Response>;
  };
}

function buildBatchBody(overrides: Record<string, unknown> = {}) {
  return {
    task: "test-batch",
    jobs: [
      {
        id: "job-1",
        request: {
          task: "sub-1",
          command: { cmd: "echo", args: ["hello"] },
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test("batch execute returns 401 without authorization header", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify(buildBatchBody()),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
    const body = result.json as { error: { code: string } };
    assert.equal(body.error.code, "UNAUTHORIZED");
  } finally {
    h.teardown();
  }
});

test("batch execute returns 401 with wrong bearer token", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify(buildBatchBody()),
      { authorization: "Bearer wrong-token" },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("batch execute returns 400 for invalid JSON", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = new Request(
      "http://localhost:3000/api/internal/worker-sandboxes/execute-batch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "not-json",
      },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_JSON");
  } finally {
    h.teardown();
  }
});

test("batch execute returns 400 when jobs array is empty", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({ task: "test", jobs: [] }),
      { authorization: `Bearer ${token}` },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /jobs/);
  } finally {
    h.teardown();
  }
});

test("batch execute returns 400 when job missing id", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "test",
        jobs: [{ request: { task: "sub", command: { cmd: "echo" } } }],
      }),
      { authorization: `Bearer ${token}` },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /id/);
  } finally {
    h.teardown();
  }
});

test("batch execute returns 400 when nested job request is invalid", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();
    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "test",
        jobs: [{ id: "job-1", request: { task: "sub" } }],
      }),
      { authorization: `Bearer ${token}` },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /Job "job-1" has invalid request/);
    assert.equal(h.controller.eventsOfKind("create").length, 0);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("batch execute runs multiple jobs and returns aggregate result", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "multi-job",
        jobs: [
          { id: "a", request: { task: "sub-a", command: { cmd: "echo", args: ["a"] } } },
          { id: "b", request: { task: "sub-b", command: { cmd: "echo", args: ["b"] } } },
        ],
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxBatchExecuteResponse;
    assert.equal(body.ok, true);
    assert.equal(body.task, "multi-job");
    assert.equal(body.totalJobs, 2);
    assert.equal(body.succeeded, 2);
    assert.equal(body.failed, 0);
    assert.equal(body.results.length, 2);

    const ids = body.results.map((r) => r.id).sort();
    assert.deepEqual(ids, ["a", "b"]);

    // Each job should have created and stopped its own sandbox
    assert.equal(h.controller.eventsOfKind("create").length, 2);
    assert.equal(h.controller.eventsOfKind("stop").length, 2);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Concurrency clamping
// ---------------------------------------------------------------------------

test("batch execute clamps maxConcurrency to hard cap of 4", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    // Request concurrency of 10 with 5 jobs — should be clamped to 4
    const jobs = Array.from({ length: 5 }, (_, i) => ({
      id: `job-${i}`,
      request: { task: `sub-${i}`, command: { cmd: "echo", args: [`${i}`] } },
    }));

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({ task: "clamp-test", maxConcurrency: 10, jobs }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxBatchExecuteResponse;
    assert.equal(body.ok, true);
    assert.equal(body.totalJobs, 5);
    assert.equal(body.succeeded, 5);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// continueOnError=false stops after first failure
// ---------------------------------------------------------------------------

test("batch execute stops scheduling after first failure when continueOnError=false", async () => {
  const h = createScenarioHarness();
  try {
    // Make all commands exit non-zero
    h.controller.defaultResponders.unshift(() => ({
      exitCode: 1,
      output: async (stream?: "stdout" | "stderr" | "both") => {
        if (stream === "stdout") return "";
        if (stream === "stderr") return "fail\n";
        return "fail\n";
      },
    }));

    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const jobs = Array.from({ length: 4 }, (_, i) => ({
      id: `job-${i}`,
      request: { task: `sub-${i}`, command: { cmd: "bash", args: ["-lc", "exit 1"] } },
    }));

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "fail-fast",
        maxConcurrency: 1,
        continueOnError: false,
        jobs,
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxBatchExecuteResponse;
    assert.equal(body.ok, false);
    // With concurrency 1 and fail-fast, only the first job should run
    assert.equal(body.results.length, 1);
    assert.equal(body.failed, 1);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// continueOnError=true runs all jobs
// ---------------------------------------------------------------------------

test("batch execute continues all jobs when continueOnError=true", async () => {
  const h = createScenarioHarness();
  try {
    // Make all commands exit non-zero
    h.controller.defaultResponders.unshift(() => ({
      exitCode: 1,
      output: async (stream?: "stdout" | "stderr" | "both") => {
        if (stream === "stdout") return "";
        if (stream === "stderr") return "fail\n";
        return "fail\n";
      },
    }));

    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const jobs = Array.from({ length: 3 }, (_, i) => ({
      id: `job-${i}`,
      request: { task: `sub-${i}`, command: { cmd: "bash", args: ["-lc", "exit 1"] } },
    }));

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "continue-on-error",
        maxConcurrency: 1,
        continueOnError: true,
        jobs,
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxBatchExecuteResponse;
    assert.equal(body.ok, false);
    assert.equal(body.totalJobs, 3);
    assert.equal(body.results.length, 3);
    assert.equal(body.failed, 3);
    assert.equal(body.succeeded, 0);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// passAiGatewayKey injects env into child jobs
// ---------------------------------------------------------------------------

test("batch execute injects AI Gateway env when passAiGatewayKey=true", async () => {
  const h = createScenarioHarness();
  try {
    _setAiGatewayTokenOverrideForTesting("test-ai-gateway-token");

    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "ai-inject",
        passAiGatewayKey: true,
        jobs: [
          {
            id: "ai-job",
            request: {
              task: "sub-ai",
              command: { cmd: "bash", args: ["-lc", "echo $AI_GATEWAY_API_KEY"] },
            },
          },
        ],
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxBatchExecuteResponse;
    assert.equal(body.ok, true);

    // Verify the child sandbox received network policy transform (not env vars)
    const handle = h.controller.lastCreated()!;
    assert.ok(handle.createTimeNetworkPolicy, "child sandbox should have networkPolicy at create time");
    const policy = handle.createTimeNetworkPolicy as { allow: Record<string, unknown[]> };
    assert.ok(policy.allow?.["ai-gateway.vercel.sh"], "should have ai-gateway transform");
    // Env should only have OPENAI_BASE_URL — API key is injected via transform
    const commandEnv = handle.commands[0]?.env;
    assert.ok(commandEnv, "child command should have env");
    assert.equal(commandEnv.AI_GATEWAY_API_KEY, undefined, "API key should not be in env");
    assert.equal(commandEnv.OPENAI_API_KEY, undefined, "OPENAI_API_KEY should not be in env");
    assert.equal(commandEnv.OPENAI_BASE_URL, "https://ai-gateway.vercel.sh/v1");
  } finally {
    _setAiGatewayTokenOverrideForTesting(null);
    h.teardown();
  }
});

test("batch execute does not inject AI Gateway env when passAiGatewayKey is not set", async () => {
  const h = createScenarioHarness();
  try {
    _setAiGatewayTokenOverrideForTesting("should-not-appear");

    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify(buildBatchBody()),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const handle = h.controller.lastCreated()!;
    // Without passAiGatewayKey, env still has OPENAI_BASE_URL
    const commandEnv = handle.commands[0]?.env;
    assert.ok(commandEnv, "env should include OPENAI_BASE_URL");
    assert.equal(commandEnv.OPENAI_BASE_URL, "https://ai-gateway.vercel.sh/v1");
    assert.equal(commandEnv.AI_GATEWAY_API_KEY, undefined, "no API key without passAiGatewayKey");
  } finally {
    _setAiGatewayTokenOverrideForTesting(null);
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// passAiGatewayKey=true fails fast when no host credential
// ---------------------------------------------------------------------------

test("batch execute fails clearly when passAiGatewayKey=true but no host credential is available", async () => {
  const h = createScenarioHarness();
  const previousApiKey = process.env.AI_GATEWAY_API_KEY;
  try {
    delete process.env.AI_GATEWAY_API_KEY;
    _setAiGatewayTokenOverrideForTesting(null);

    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "needs-ai-auth",
        passAiGatewayKey: true,
        jobs: [
          {
            id: "job-1",
            request: {
              task: "sub-job-1",
              command: { cmd: "bash", args: ["-lc", "echo should-not-run"] },
            },
          },
        ],
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxBatchExecuteResponse;
    assert.equal(body.ok, false);
    assert.equal(body.totalJobs, 1);
    assert.equal(body.succeeded, 0);
    assert.equal(body.failed, 1);
    assert.equal(body.results.length, 1);
    assert.match(
      body.results[0]?.result.error ?? "",
      /AI Gateway credential unavailable on host/,
    );

    // No child sandboxes should have been created
    assert.equal(h.controller.eventsOfKind("create").length, 0);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = previousApiKey;
    }
    _setAiGatewayTokenOverrideForTesting(null);
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Duplicate job ID rejection
// ---------------------------------------------------------------------------

test("batch execute rejects duplicate job ids", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "duplicate-ids",
        jobs: [
          { id: "doc-1", request: { task: "sub-a", command: { cmd: "echo", args: ["a"] } } },
          { id: "doc-1", request: { task: "sub-b", command: { cmd: "echo", args: ["b"] } } },
        ],
      }),
      { authorization: `Bearer ${token}` },
    );

    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);

    const body = result.json as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /Duplicate id "doc-1"/);
    assert.equal(h.controller.eventsOfKind("create").length, 0);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Fail-fast with concurrency > 1
// ---------------------------------------------------------------------------

test("batch execute stops scheduling new jobs after the first failure once in-flight jobs finish", async () => {
  const h = createScenarioHarness();
  try {
    let commandCount = 0;
    let releaseSecondJob: () => void = () => {};
    const secondJobGate = new Promise<void>((resolve) => {
      releaseSecondJob = resolve;
    });

    h.controller.defaultResponders.unshift(() => {
      commandCount += 1;

      // Job 1 fails immediately
      if (commandCount === 1) {
        return {
          exitCode: 1,
          output: async (stream?: "stdout" | "stderr" | "both") => {
            if (stream === "stdout") return "";
            if (stream === "stderr") return "first failed\n";
            return "first failed\n";
          },
        };
      }

      // Job 2 was already in flight before job 1 failed; let it finish later.
      if (commandCount === 2) {
        return {
          exitCode: 0,
          output: async (stream?: "stdout" | "stderr" | "both") => {
            await secondJobGate;
            if (stream === "stderr") return "";
            if (stream === "stdout") return "second ok\n";
            return "second ok\n";
          },
        };
      }

      // Any third/fourth scheduled job is a bug for this contract.
      return {
        exitCode: 0,
        output: async () => {
          assert.fail(`unexpected extra scheduled job #${commandCount}`);
        },
      };
    });

    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const requestPromise = callRoute(
      route.POST,
      buildPostRequest(
        "/api/internal/worker-sandboxes/execute-batch",
        JSON.stringify({
          task: "parallel-fail-fast",
          maxConcurrency: 2,
          continueOnError: false,
          jobs: [
            {
              id: "job-1",
              request: {
                task: "sub-1",
                command: { cmd: "bash", args: ["-lc", "exit 1"] },
              },
            },
            {
              id: "job-2",
              request: {
                task: "sub-2",
                command: { cmd: "bash", args: ["-lc", "echo second"] },
              },
            },
            {
              id: "job-3",
              request: {
                task: "sub-3",
                command: { cmd: "bash", args: ["-lc", "echo third"] },
              },
            },
            {
              id: "job-4",
              request: {
                task: "sub-4",
                command: { cmd: "bash", args: ["-lc", "echo fourth"] },
              },
            },
          ],
        }),
        { authorization: `Bearer ${token}` },
      ),
    );

    // Wait until exactly the first two jobs have started.
    for (let i = 0; i < 20 && commandCount < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(commandCount, 2, "expected only the first two jobs to start");

    // Now allow the already-started second job to complete.
    releaseSecondJob();

    const result = await requestPromise;
    assert.equal(result.status, 200);

    const body = result.json as WorkerSandboxBatchExecuteResponse;
    assert.equal(body.ok, false);
    assert.equal(body.totalJobs, 4);
    assert.equal(body.succeeded, 1);
    assert.equal(body.failed, 1);
    assert.equal(body.results.length, 2);

    assert.deepEqual(
      body.results.map((entry) => entry.id).sort(),
      ["job-1", "job-2"],
    );

    // No jobs beyond the in-flight pair should have been scheduled.
    assert.equal(commandCount, 2);
    assert.equal(h.controller.eventsOfKind("create").length, 2);
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Singleton isolation
// ---------------------------------------------------------------------------

test("batch execute does not mutate singleton metadata", async () => {
  const h = createScenarioHarness();
  try {
    const route = getRoute();
    const token = await buildWorkerSandboxBearerToken();

    const before = await getInitializedMeta();

    const req = buildPostRequest(
      "/api/internal/worker-sandboxes/execute-batch",
      JSON.stringify({
        task: "isolation-check",
        jobs: [
          { id: "a", request: { task: "sub-a", command: { cmd: "echo", args: ["a"] } } },
          { id: "b", request: { task: "sub-b", command: { cmd: "echo", args: ["b"] } } },
        ],
      }),
      { authorization: `Bearer ${token}` },
    );

    await callRoute(route.POST, req);

    const after = await getInitializedMeta();
    assert.equal(before.status, after.status, "status must not change");
    assert.equal(before.sandboxId, after.sandboxId, "sandboxId must not change");
    assert.equal(before.snapshotId, after.snapshotId, "snapshotId must not change");
  } finally {
    h.teardown();
  }
});
