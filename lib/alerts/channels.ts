import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * Alert delivery channels (§8). `log` and `webhook` are implemented (webhook
 * performs a real `fetch` POST with a 5 s timeout and one retry). Telegram,
 * Discord, Slack and email are extension points that report
 * `{ delivered: false, reason: "not_configured" }` unless their credentials are
 * present in config.
 */

export const CHANNEL_NAMES = ["log", "webhook", "telegram", "discord", "slack", "email"] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

export interface AlertPayload {
  title: string;
  body: string;
  eventId: string;
  url?: string;
}

export interface DeliveryResult {
  channel: ChannelName;
  delivered: boolean;
  reason?: string;
}

export interface Channel {
  name: ChannelName;
  deliver(payload: AlertPayload): Promise<DeliveryResult>;
}

async function postWithRetry(url: string, body: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // fall through to retry
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

const logChannel: Channel = {
  name: "log",
  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    logger.info("alert_delivered", {
      event: "alert.channel.log",
      title: payload.title,
      eventId: payload.eventId,
    });
    return { channel: "log", delivered: true };
  },
};

const webhookChannel: Channel = {
  name: "webhook",
  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    const url = config.alertWebhookUrl;
    if (!url) {
      return { channel: "webhook", delivered: false, reason: "not_configured" };
    }
    const delivered = await postWithRetry(url, JSON.stringify(payload));
    return delivered
      ? { channel: "webhook", delivered: true }
      : { channel: "webhook", delivered: false, reason: "request_failed" };
  },
};

function unconfigured(name: ChannelName, configured: boolean): Channel {
  return {
    name,
    async deliver(): Promise<DeliveryResult> {
      if (!configured) {
        return { channel: name, delivered: false, reason: "not_configured" };
      }
      return { channel: name, delivered: false, reason: "not_implemented" };
    },
  };
}

const channels: Record<ChannelName, Channel> = {
  log: logChannel,
  webhook: webhookChannel,
  telegram: unconfigured("telegram", Boolean(config.alertTelegramBotToken && config.alertTelegramChatId)),
  discord: unconfigured("discord", Boolean(config.alertDiscordWebhookUrl)),
  slack: unconfigured("slack", Boolean(config.alertSlackWebhookUrl)),
  email: unconfigured("email", Boolean(config.smtpUrl)),
};

export function getChannel(name: ChannelName): Channel {
  return channels[name] ?? logChannel;
}

export function isChannelName(value: string): value is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(value);
}

/** Delivers a payload over every requested channel and returns the results. */
export async function deliver(
  requested: string[],
  payload: AlertPayload,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const name of requested) {
    if (!isChannelName(name)) {
      results.push({ channel: "log", delivered: false, reason: `unknown_channel:${name}` });
      continue;
    }
    const channel = getChannel(name);
    try {
      results.push(await channel.deliver(payload));
    } catch {
      results.push({ channel: name, delivered: false, reason: "error" });
    }
  }
  return results;
}
