export type ChannelCommandDefinition = {
  name: string;
  description: string;
  telegram: { enabled: boolean };
  discord?: {
    type: 1;
    options: ReadonlyArray<{
      name: "text";
      description: string;
      type: 3;
      required: true;
    }>;
  };
};

const CHANNEL_COMMAND_DEFINITIONS = [
  {
    name: "ask",
    description: "Ask the AI a question",
    telegram: { enabled: true },
    discord: {
      type: 1 as const,
      options: [
        {
          name: "text" as const,
          description: "Your question",
          type: 3 as const,
          required: true as const,
        },
      ],
    },
  },
  {
    name: "help",
    description: "Show available commands",
    telegram: { enabled: true },
  },
  {
    name: "status",
    description: "Show current session status",
    telegram: { enabled: true },
  },
  {
    name: "model",
    description: "Switch or view the current model",
    telegram: { enabled: true },
  },
  {
    name: "reset",
    description: "Start a new conversation",
    telegram: { enabled: true },
  },
  {
    name: "think",
    description: "Set thinking level (off, low, medium, high)",
    telegram: { enabled: true },
  },
  {
    name: "compact",
    description: "Compact the conversation context",
    telegram: { enabled: true },
  },
  {
    name: "stop",
    description: "Stop the current response",
    telegram: { enabled: true },
  },
] as const satisfies readonly ChannelCommandDefinition[];

export function getChannelCommandDefinitions(): readonly ChannelCommandDefinition[] {
  return CHANNEL_COMMAND_DEFINITIONS;
}
