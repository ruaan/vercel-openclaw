import { unstable_noStore as noStore } from "next/cache";
import { getAuthMode } from "@/server/env";
import { getStore, getInitializedMeta } from "@/server/store/store";

export async function GET(_request: Request): Promise<Response> {
  noStore();
  const meta = await getInitializedMeta();
  return Response.json({
    ok: true,
    authMode: getAuthMode(),
    storeBackend: getStore().name,
    status: meta.status,
    hasSnapshot: Boolean(meta.snapshotId),
  });
}
