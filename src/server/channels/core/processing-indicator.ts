// src/server/channels/core/processing-indicator.ts
import type {
  ExtractedChannelMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";

export interface ProcessingIndicator {
  stop(): Promise<void>;
}

const NOOP_PROCESSING_INDICATOR: ProcessingIndicator = {
  async stop() {},
};

export function startKeepAlive(
  pulse: () => Promise<void>,
  intervalMs: number,
): ProcessingIndicator {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const runPulse = () => {
    if (stopped) {
      return;
    }
    void pulse().catch(() => {});
  };

  runPulse();

  timer = setInterval(() => {
    runPulse();
  }, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export function startDelayed(
  startFn: () => Promise<ProcessingIndicator>,
  delayMs: number,
): ProcessingIndicator {
  let stopped = false;
  let startedIndicator: ProcessingIndicator | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const begin = () => {
    startPromise = startFn()
      .then(async (indicator) => {
        if (stopped) {
          await indicator.stop().catch(() => {});
          return;
        }
        startedIndicator = indicator;
      })
      .catch(() => {});
  };

  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    begin();
  } else {
    timeout = setTimeout(() => {
      timeout = null;
      if (stopped) {
        return;
      }
      begin();
    }, delayMs);
    timeout.unref?.();
  }

  return {
    async stop() {
      if (stopPromise) {
        return stopPromise;
      }

      stopPromise = (async () => {
        stopped = true;

        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }

        await startPromise;
        await startedIndicator?.stop().catch(() => {});
      })();

      return stopPromise;
    },
  };
}

export async function startPlatformProcessingIndicator<
  TPayload,
  TMessage extends ExtractedChannelMessage,
>(
  adapter: PlatformAdapter<TPayload, TMessage>,
  message: TMessage,
  options: {
    delayMs: number;
    onError?: (error: unknown) => void;
  },
): Promise<ProcessingIndicator> {
  if (adapter.startProcessingIndicator) {
    return startDelayed(async () => {
      try {
        return await adapter.startProcessingIndicator!(message);
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    }, options.delayMs);
  }

  if (adapter.sendTypingIndicator) {
    try {
      await adapter.sendTypingIndicator(message);
    } catch (error) {
      options.onError?.(error);
      return NOOP_PROCESSING_INDICATOR;
    }

    return {
      async stop() {
        await adapter.clearTypingIndicator?.(message).catch(() => {});
      },
    };
  }

  return NOOP_PROCESSING_INDICATOR;
}
