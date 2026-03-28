"use client";

import type { ChannelConnectability } from "@/shared/channel-connectability";

export function ConnectabilityNotice({
  connectability,
  suppressedIds,
}: {
  connectability: ChannelConnectability;
  suppressedIds?: Set<string> | null;
}) {
  const visibleIssues = suppressedIds
    ? connectability.issues.filter((issue) => !suppressedIds.has(issue.id))
    : connectability.issues;

  if (visibleIssues.length === 0) {
    return null;
  }

  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      {visibleIssues.map((issue) => (
        <div
          key={`${connectability.channel}:${issue.id}`}
          className={
            issue.status === "fail"
              ? "error-banner"
              : "connectability-warning-banner"
          }
        >
          <p style={{ margin: 0 }}>
            {issue.message}
          </p>
          {issue.remediation ? (
            <p className="muted-copy" style={{ margin: "4px 0 0" }}>
              {issue.remediation}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
