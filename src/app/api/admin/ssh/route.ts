import { getSandboxController } from "@/server/sandbox/controller";

import { ApiError, jsonError } from "@/shared/http";
import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import { getInitializedMeta } from "@/server/store/store";

const MAX_COMMAND_LENGTH = 2000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await getInitializedMeta();

  if (meta.status !== "running" || !meta.sandboxId) {
    return jsonError(
      new ApiError(409, "SANDBOX_NOT_RUNNING", "Sandbox is not running."),
    );
  }

  let body: { command?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }

  const { command } = body;

  if (typeof command !== "string" || command.trim().length === 0) {
    return jsonError(
      new ApiError(400, "MISSING_COMMAND", "A non-empty command is required."),
    );
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    return jsonError(
      new ApiError(
        400,
        "COMMAND_TOO_LONG",
        `Command must be at most ${MAX_COMMAND_LENGTH} characters.`,
      ),
    );
  }

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    const signal = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
    const result = await sandbox.runCommand("sh", ["-c", command], { signal });

    const stdout = (await result.output("stdout")).slice(0, MAX_OUTPUT_BYTES);
    const stderr = (await result.output("stderr")).slice(0, MAX_OUTPUT_BYTES);

    return authJsonOk(
      {
        stdout,
        stderr,
        exitCode: result.exitCode,
      },
      auth,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return jsonError(
        new ApiError(
          408,
          "COMMAND_TIMEOUT",
          `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s. Avoid long-running commands like "tail -f".`,
        ),
      );
    }
    return jsonError(error);
  }
}
