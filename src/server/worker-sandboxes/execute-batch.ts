import { getAiGatewayBearerTokenOptional } from "@/server/env";
import type {
  WorkerSandboxBatchExecuteRequest,
  WorkerSandboxBatchExecuteResponse,
  WorkerSandboxBatchJobResult,
} from "@/shared/worker-sandbox";
import { executeWorkerSandbox } from "@/server/worker-sandboxes/execute";

const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_BATCH_CONCURRENCY = 4;

export function clampBatchConcurrency(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_MAX_CONCURRENCY;
  }
  return Math.min(value, MAX_BATCH_CONCURRENCY);
}

function buildBatchConfigErrorResult(
  request: WorkerSandboxBatchExecuteRequest,
  message: string,
): WorkerSandboxBatchExecuteResponse {
  const results: WorkerSandboxBatchJobResult[] = request.jobs.map((job) => ({
    id: job.id,
    result: {
      ok: false,
      task: job.request.task,
      sandboxId: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      capturedFiles: [],
      error: message,
    },
  }));
  return {
    ok: false,
    task: request.task,
    totalJobs: request.jobs.length,
    succeeded: 0,
    failed: results.length,
    results,
  };
}

export async function executeWorkerSandboxBatch(
  request: WorkerSandboxBatchExecuteRequest,
): Promise<WorkerSandboxBatchExecuteResponse> {
  const maxConcurrency = clampBatchConcurrency(request.maxConcurrency);
  const results: WorkerSandboxBatchJobResult[] = [];
  let failed = 0;
  let nextJobIndex = 0;
  let stopScheduling = false;
  let queueLock = Promise.resolve();

  const aiGatewayApiKey = request.passAiGatewayKey
    ? await getAiGatewayBearerTokenOptional()
    : undefined;

  if (request.passAiGatewayKey && !aiGatewayApiKey) {
    return buildBatchConfigErrorResult(
      request,
      "AI Gateway credential unavailable on host. Set AI_GATEWAY_API_KEY or enable Vercel OIDC before using passAiGatewayKey=true.",
    );
  }

  async function withQueueLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = queueLock;
    let release: () => void = () => {};
    queueLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function takeNextJob() {
    return withQueueLock(() => {
      if (!request.continueOnError && stopScheduling) {
        return null;
      }
      const job = request.jobs[nextJobIndex];
      if (!job) {
        return null;
      }
      nextJobIndex += 1;
      return job;
    });
  }

  async function recordResult(result: WorkerSandboxBatchJobResult) {
    await withQueueLock(() => {
      results.push(result);
      if (!result.result.ok) {
        failed += 1;
        if (!request.continueOnError) {
          stopScheduling = true;
        }
      }
    });
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, request.jobs.length) },
    async () => {
      while (true) {
        const job = await takeNextJob();
        if (!job) {
          return;
        }
        const result = await executeWorkerSandbox(job.request, {
          aiGatewayApiKey,
        });
        await recordResult({ id: job.id, result });
      }
    },
  );

  await Promise.all(workers);

  const succeeded = results.filter((entry) => entry.result.ok).length;

  return {
    ok: failed === 0,
    task: request.task,
    totalJobs: request.jobs.length,
    succeeded,
    failed,
    results,
  };
}
