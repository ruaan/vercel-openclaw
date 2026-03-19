import { after } from "next/server";

import { requireDebugEnabled } from "@/server/auth/debug-guard";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { jsonOk } from "@/shared/http";

const MODULE_LOAD_TS = Date.now();

/**
 * Stores the timestamp recorded inside the after() callback from the
 * previous request. Read on the *next* request to measure scheduling delay.
 *
 * Uses Date.now() (wall-clock) intentionally: the after() callback fires in
 * a separate execution context after the response is sent, so
 * performance.now() would reset and be meaningless across contexts.
 */
let lastAfterCallbackTs: number | null = null;
let lastAfterScheduledTs: number | null = null;

export async function GET(request: Request): Promise<Response> {
  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  const handlerEntryTs = Date.now();

  const previousAfterCallbackTs = lastAfterCallbackTs;
  const previousAfterScheduledTs = lastAfterScheduledTs;

  const afterScheduledTs = Date.now();
  after(() => {
    lastAfterCallbackTs = Date.now();
    lastAfterScheduledTs = afterScheduledTs;
  });

  const afterCallDelayMs =
    previousAfterCallbackTs && previousAfterScheduledTs
      ? previousAfterCallbackTs - previousAfterScheduledTs
      : null;

  return jsonOk({
    moduleLoadTs: MODULE_LOAD_TS,
    handlerEntryTs,
    afterScheduledTs,
    previousAfterCallbackTs,
    previousAfterScheduledTs,
    afterCallDelayMs,
    note:
      afterCallDelayMs === null
        ? "Hit this endpoint twice. The second response will include after() callback delay from the first request."
        : `after() callback fired ${afterCallDelayMs}ms after it was scheduled.`,
  });
}
