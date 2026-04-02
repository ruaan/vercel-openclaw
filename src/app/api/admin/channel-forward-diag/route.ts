import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { channelForwardDiagnosticKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  const diag = await getStore().getValue<Record<string, unknown>>(channelForwardDiagnosticKey());
  if (!diag) {
    return Response.json({ error: "NO_DIAGNOSTIC_DATA", message: "No channel forward diagnostic found. Trigger a wake-from-sleep Telegram message first." }, { status: 404 });
  }

  return Response.json(diag);
}
