import { APIError } from "@vercel/sandbox";

export async function deleteVercelSnapshot(snapshotId: string): Promise<void> {
  const { Snapshot } = await import("@vercel/sandbox");
  const snap = await Snapshot.get({ snapshotId });
  await snap.delete();
}

export function isSnapshotNotFoundError(error: unknown): boolean {
  return (
    error instanceof APIError && error.response?.status === 404
  );
}
