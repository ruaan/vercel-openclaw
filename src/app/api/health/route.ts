import { getAuthMode } from "@/server/env";
import { getStore, getInitializedMeta } from "@/server/store/store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request): Promise<Response> {
  const meta = await getInitializedMeta();
  return Response.json({
    ok: true,
    authMode: getAuthMode(),
    storeBackend: getStore().name,
    status: meta.status,
    hasSnapshot: Boolean(meta.snapshotId),
  });
}
