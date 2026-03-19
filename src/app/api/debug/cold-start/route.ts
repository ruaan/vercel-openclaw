import { jsonOk } from "@/shared/http";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { requireDebugEnabled } from "@/server/auth/debug-guard";

let coldStart = true;
const moduleLoadedAt = performance.now();

export async function POST(request: Request): Promise<Response> {
  const handlerStartedAt = performance.now();

  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  const wasColdStart = coldStart;
  coldStart = false;

  return jsonOk({
    coldStart: wasColdStart,
    moduleToHandlerMs: handlerStartedAt - moduleLoadedAt,
    timestamp: Date.now(),
  });
}
