import { setWebhook } from "@/server/channels/telegram/bot-api";
import { logInfo } from "@/server/log";
import { getInitializedMeta, getStore } from "@/server/store/store";

export const TELEGRAM_WEBHOOK_RECONCILE_KEY =
  "telegram:webhook:last-reconciled-at";
export const TELEGRAM_WEBHOOK_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

export async function reconcileTelegramWebhook(options?: {
  force?: boolean;
}): Promise<boolean> {
  const meta = await getInitializedMeta();
  const config = meta.channels.telegram;
  if (!config) {
    return false;
  }

  if (!options?.force) {
    const lastReconciledAt = await getStore().getValue<number>(
      TELEGRAM_WEBHOOK_RECONCILE_KEY,
    );
    if (
      lastReconciledAt &&
      Date.now() - lastReconciledAt < TELEGRAM_WEBHOOK_RECONCILE_INTERVAL_MS
    ) {
      return false;
    }
  }

  await setWebhook(config.botToken, config.webhookUrl, config.webhookSecret);
  await getStore().setValue(TELEGRAM_WEBHOOK_RECONCILE_KEY, Date.now());

  logInfo("channels.telegram_webhook_reconciled", {
    webhookUrl: config.webhookUrl,
  });

  return true;
}
