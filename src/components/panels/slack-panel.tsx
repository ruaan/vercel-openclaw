import { useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
  SlackTestPayload,
} from "@/components/admin-types";
import type { ChannelPillModel } from "@/components/panels/channel-panel-shared";
import {
  ChannelCardFrame,
  ChannelCopyValue,
  ChannelInfoRow,
  ChannelSecretField,
  getChannelActionLabel,
} from "@/components/panels/channel-panel-shared";

type SlackPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

function getSlackPill(configured: boolean): ChannelPillModel {
  return {
    label: configured ? "connected" : "offline",
    variant: configured ? "good" : "idle",
  };
}

export function SlackPanel({
  status,
  busy,
  runAction,
  requestJson,
  preflightBlockerIds,
}: SlackPanelProps) {
  const [signingSecret, setSigningSecret] = useState("");
  const [botToken, setBotToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [testResult, setTestResult] = useState<SlackTestPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { confirm, dialogProps } = useConfirm();
  const sl = status.channels.slack;
  const botTokenValid = /^xoxb-/.test(botToken.trim());

  function clearDrafts(): void {
    setSigningSecret("");
    setBotToken("");
    setShowSecret(false);
    setShowToken(false);
    setTestResult(null);
    setPanelError(null);
  }

  async function handleTestToken(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    const result = await requestJson<SlackTestPayload>(
      "/api/channels/slack/test",
      {
        label: "Test Slack token",
        successMessage: "Slack token verified",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
        refreshAfter: false,
      },
    );
    if (result.ok && result.data) {
      setTestResult(result.data);
    }
  }

  async function handleConnect(): Promise<void> {
    if (!signingSecret.trim() || !botToken.trim()) return;
    setPanelError(null);
    const result = await requestJson("/api/channels/slack", {
      label: getChannelActionLabel("slack", editing ? "update" : "connect"),
      successMessage: editing ? "Slack credentials updated" : "Slack connected",
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signingSecret: signingSecret.trim(),
        botToken: botToken.trim(),
      }),
    });
    if (result.ok) {
      clearDrafts();
      setEditing(false);
    } else {
      setPanelError(result.error);
    }
  }

  async function handleCreateApp(): Promise<void> {
    const result = await requestJson<{ createAppUrl: string }>(
      "/api/channels/slack/manifest",
      {
        label: "Create Slack app",
        successMessage: "Slack app manifest opened",
        method: "GET",
        refreshAfter: false,
      },
    );
    if (result.ok && result.data?.createAppUrl) {
      window.open(result.data.createAppUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Disconnect Slack?",
      description:
        "This will remove the Slack credentials and stop processing messages from this workspace.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;

    setPanelError(null);
    const success = await runAction("/api/channels/slack", {
      label: getChannelActionLabel("slack", "disconnect"),
      successMessage: "Slack disconnected",
      method: "DELETE",
    });
    if (success) {
      clearDrafts();
      setEditing(false);
    }
  }

  function handleCopyWebhook(): void {
    void navigator.clipboard.writeText(sl.webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <ChannelCardFrame
      channel="slack"
      configured={sl.configured}
      channelClassName="channel-slack"
      title="Slack"
      summary={
        sl.configured
          ? `Connected${sl.team ? ` · ${sl.team}` : ""}`
          : "Not configured"
      }
      pill={getSlackPill(sl.configured)}
      errors={[panelError, sl.lastError]}
      connectability={sl.connectability}
      suppressedIds={preflightBlockerIds}
    >
      {sl.configured && !editing ? (
        <div className="channel-connected-view">
          <ChannelInfoRow label="Workspace">
            <code className="inline-code">
              {sl.team ?? "—"}
              {sl.botId ? ` · ${sl.botId}` : ""}
            </code>
          </ChannelInfoRow>
          <ChannelCopyValue
            label="Webhook URL"
            value={sl.webhookUrl}
            copied={copied}
            onCopy={handleCopyWebhook}
          />
          <ChannelInfoRow label="Health">
            <code className="inline-code">Ready</code>
          </ChannelInfoRow>
          <div className="inline-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setPanelError(null);
                setEditing(true);
              }}
            >
              Update credentials
            </button>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <form className="channel-wizard" onSubmit={(e) => { e.preventDefault(); void handleConnect(); }}>
          <p className="channel-wizard-title">
            {editing ? "Update Credentials" : "Connect Slack"}
          </p>

          {!editing ? (
            <div className="inline-actions" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void handleCreateApp()}
              >
                Create Slack App
              </button>
              <span className="muted-copy">or</span>
              <a
                className="button ghost"
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noreferrer"
              >
                Open existing app
              </a>
            </div>
          ) : null}

          <ChannelSecretField
            label="Signing Secret"
            value={signingSecret}
            onChange={setSigningSecret}
            placeholder="Signing Secret"
            shown={showSecret}
            onToggleShown={() => setShowSecret((v) => !v)}
            help="Basic Information → App Credentials → Signing Secret"
          />

          <ChannelSecretField
            label="Bot Token"
            value={botToken}
            onChange={(v) => {
              setBotToken(v);
              setTestResult(null);
            }}
            placeholder="xoxb-..."
            shown={showToken}
            onToggleShown={() => setShowToken((v) => !v)}
            help="OAuth & Permissions → Bot User OAuth Token (starts with xoxb-)"
            validationMessage={
              botToken.trim() && !botTokenValid
                ? "Bot token must start with xoxb-"
                : null
            }
          />

          {botTokenValid ? (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void handleTestToken()}
            >
              Test Connection
            </button>
          ) : null}

          {testResult?.ok ? (
            <p className="success-copy">
              Connected to {testResult.team} as {testResult.user}
            </p>
          ) : null}

          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={
                busy ||
                !sl.connectability.canConnect ||
                !signingSecret.trim() ||
                !botToken.trim()
              }
            >
              {editing ? "Update" : "Connect"}
            </button>
            {editing ? (
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  clearDrafts();
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      )}
      <ConfirmDialog {...dialogProps} />
    </ChannelCardFrame>
  );
}
