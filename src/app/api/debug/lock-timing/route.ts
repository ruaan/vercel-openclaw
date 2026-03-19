import { requireDebugEnabled } from "@/server/auth/debug-guard";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getStore } from "@/server/store/store";
import { jsonOk } from "@/shared/http";

const DEBUG_LOCK_KEY = "openclaw-single:lock:debug-timing";

export async function GET(request: Request): Promise<Response> {
  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  const store = getStore();
  const timings: Record<string, number> = {};

  let t0 = performance.now();
  const token = await store.acquireLock(DEBUG_LOCK_KEY, 5);
  timings.acquireLockMs = Math.round((performance.now() - t0) * 100) / 100;

  if (!token) {
    return Response.json(
      { error: "Could not acquire debug lock", timings },
      { status: 409 },
    );
  }

  t0 = performance.now();
  await store.releaseLock(DEBUG_LOCK_KEY, token);
  timings.releaseLockMs = Math.round((performance.now() - t0) * 100) / 100;

  t0 = performance.now();
  const token2 = await store.acquireLock(DEBUG_LOCK_KEY, 5);
  timings.acquireLockWarmMs = Math.round((performance.now() - t0) * 100) / 100;

  if (token2) {
    t0 = performance.now();
    await store.releaseLock(DEBUG_LOCK_KEY, token2);
    timings.releaseLockWarmMs = Math.round((performance.now() - t0) * 100) / 100;
  }

  return jsonOk({ storeBackend: store.name, timings });
}
