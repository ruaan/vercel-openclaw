import { ApiError, jsonError } from "@/shared/http";
import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import {
  deleteVercelSnapshot,
  isSnapshotNotFoundError,
} from "@/server/sandbox/snapshot-delete";

export type SnapshotsDeleteDeps = {
  deleteSnapshot?: (snapshotId: string) => Promise<void>;
};

export async function postAdminSnapshotsDelete(
  request: Request,
  deps: SnapshotsDeleteDeps = {},
): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let body: { snapshotId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }

  const snapshotId =
    typeof body.snapshotId === "string" ? body.snapshotId.trim() : "";
  if (!snapshotId) {
    return jsonError(
      new ApiError(400, "MISSING_SNAPSHOT_ID", "A snapshotId is required."),
    );
  }

  const meta = await getInitializedMeta();
  const inHistory = meta.snapshotHistory.some(
    (s) => s.snapshotId === snapshotId,
  );
  if (!inHistory) {
    return jsonError(
      new ApiError(
        404,
        "SNAPSHOT_NOT_FOUND",
        "Snapshot not found in history.",
      ),
    );
  }

  if (meta.snapshotId === snapshotId) {
    return jsonError(
      new ApiError(
        409,
        "CANNOT_DELETE_CURRENT_SNAPSHOT",
        "Cannot delete the current snapshot. Restore a different snapshot first, or take a new snapshot.",
      ),
    );
  }

  const del = deps.deleteSnapshot ?? deleteVercelSnapshot;

  try {
    await del(snapshotId);
  } catch (e) {
    if (!isSnapshotNotFoundError(e)) {
      return jsonError(e);
    }
  }

  const updated = await mutateMeta((next) => {
    next.snapshotHistory = next.snapshotHistory.filter(
      (s) => s.snapshotId !== snapshotId,
    );
  });

  return authJsonOk(
    { ok: true, snapshotId, snapshots: updated.snapshotHistory },
    auth,
  );
}

export async function POST(request: Request): Promise<Response> {
  return postAdminSnapshotsDelete(request);
}
