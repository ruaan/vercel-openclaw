import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { buildPublicUrl } from "@/server/public-url";

// Scopes aligned with OpenClaw's native Slack manifest plus extras for
// the proxied HTTP-mode integration (assistant:write, im:write).
const SLACK_BOT_SCOPES = [
  // Messaging — post, edit, delete, ephemeral
  "chat:write",
  // Slash commands
  "commands",
  // Reactions — ack emoji, status reactions
  "reactions:write",
  "reactions:read",
  // History — thread context, conversation replies (including multi-person DMs)
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  // Channel/user info — room detection, user display names, @mention events
  "channels:read",
  "groups:read",
  "im:write",
  "users:read",
  "app_mentions:read",
  // Files — image uploads, file attachments
  "files:read",
  "files:write",
  // Pins
  "pins:read",
  "pins:write",
  // Custom emoji — list workspace emojis for agent use
  "emoji:read",
  // Slack AI assistant threads — status, title, suggested prompts
  "assistant:write",
] as const;

// Events aligned with OpenClaw's native manifest — covers @mentions,
// all message types (channels, groups, DMs, multi-person DMs), reactions,
// membership changes, renames, and pins.
const SLACK_BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
  "reaction_removed",
  "member_joined_channel",
  "member_left_channel",
  "channel_rename",
  "pin_added",
  "pin_removed",
] as const;

function buildManifest(webhookUrl: string): Record<string, unknown> {
  return {
    display_information: {
      name: "OpenClaw Gateway",
      description: "OpenClaw Slack integration",
      background_color: "#0f172a",
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: "OpenClaw",
        always_online: false,
      },
      slash_commands: [
        {
          command: "/openclaw",
          description: "Send a message to OpenClaw",
          should_escape: false,
          url: webhookUrl,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: webhookUrl,
        bot_events: [...SLACK_BOT_EVENTS],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const webhookUrl = buildPublicUrl("/api/channels/slack/webhook", request);
    const manifest = buildManifest(webhookUrl);
    const manifestJson = JSON.stringify(manifest);
    const createAppUrl =
      `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson)}`;

    return authJsonOk(
      {
        manifest,
        createAppUrl,
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
