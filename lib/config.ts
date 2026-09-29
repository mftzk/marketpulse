import { z } from "zod";

import type { LogLevel } from "@/lib/logger";

/**
 * Process environment is read exactly once here. Every other module reads typed
 * config from this module — never from `process.env` directly.
 *
 * The config is intentionally forgiving: missing optional variables (LLM key,
 * Redis URL, …) never throw. A missing `DATABASE_URL` is exposed as
 * `databaseConfigured: false` rather than failing at import time.
 */

function readEnv(): Record<string, string | undefined> {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }
  return process.env as Record<string, string | undefined>;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

const booleanSchema = z
  .enum(["0", "1", "true", "false"])
  .transform((v) => v === "1" || v === "true");

const intSchema = z.coerce.number().int().finite();

const newsProviderSchema = z.enum(["mock", "benzinga"]);
const marketProviderSchema = z.enum(["mock", "massive"]);
const fundamentalProviderSchema = z.enum(["mock", "fmp"]);

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

function parseProvider<T extends "mock" | "massive" | "benzinga" | "fmp">(
  value: string | null,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  if (value === null) {
    return fallback;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid provider value '${value}'. Check the configured feed provider.`);
  }
  return parsed.data;
}

function parseLogLevel(value: string | null): LogLevel {
  if (value === null) {
    return "info";
  }
  const parsed = logLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : "info";
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }
  const parsed = booleanSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback;
  }
  const parsed = intSchema.safeParse(value);
  if (!parsed.success || parsed.data < 1) {
    return fallback;
  }
  return parsed.data;
}

export interface Config {
  databaseUrl: string | null;
  databaseConfigured: boolean;
  redisUrl: string | null;
  redisConfigured: boolean;
  llmApiKey: string | null;
  llmBaseUrl: string | null;
  llmModel: string;
  llmConfigured: boolean;
  newsProvider: "mock" | "benzinga";
  newsMode: "backfill" | "live";
  marketProvider: "mock" | "massive";
  fundamentalProvider: "mock" | "fmp";
  massiveApiKey: string | null;
  benzingaApiKey: string | null;
  fmpApiKey: string | null;
  pipelineAutorun: boolean;
  pipelineTickSeconds: number;
  logLevel: LogLevel;
  appUrl: string | null;
  isProduction: boolean;
  /** Whether the auth gate is enforced. Defaults to `true` when unset. */
  authEnabled: boolean;
  /** HMAC key for `mp_session`; required (>=32 chars) when auth is enabled. */
  sessionSecret: string | null;
  /** Human-readable reason auth is misconfigured, or `null` when valid. */
  authConfigError: string | null;
  /** Single seeded owner account (reads resolve the owning user by this email). */
  adminEmail: string;
  adminDisplayName: string;
  /** Plaintext admin password; only the seeder consumes it, never a read path. */
  adminPassword: string | null;
  alertWebhookUrl: string | null;
  alertTelegramBotToken: string | null;
  alertTelegramChatId: string | null;
  alertDiscordWebhookUrl: string | null;
  alertSlackWebhookUrl: string | null;
  smtpUrl: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = readEnv()): Config {
  const databaseUrl = nonEmpty(env.DATABASE_URL);
  const redisUrl = nonEmpty(env.REDIS_URL);
  const llmApiKey = nonEmpty(env.LLM_API_KEY);
  const llmBaseUrl = nonEmpty(env.LLM_BASE_URL);
  const llmModel = nonEmpty(env.LLM_MODEL) ?? "gpt-4o-mini";
  const appUrl = nonEmpty(env.APP_URL);
  const massiveApiKey = nonEmpty(env.MASSIVE_API_KEY);
  const benzingaApiKey = nonEmpty(env.BENZINGA_API_KEY);
  const fmpApiKey = nonEmpty(env.FMP_API_KEY);

  const logLevel = parseLogLevel(nonEmpty(env.LOG_LEVEL));
  const pipelineTickSeconds = parsePositiveInt(nonEmpty(env.PIPELINE_TICK_SECONDS), 30);

  // Auth is enabled unless explicitly disabled. A missing/short secret never
  // throws at import time (that would break `next build`, which has no runtime
  // env); instead `authConfigError` is surfaced and the session helpers throw a
  // clear error when a token is actually signed or verified.
  const authEnabled = parseBoolean(nonEmpty(env.AUTH_ENABLED), true);
  const sessionSecret = nonEmpty(env.SESSION_SECRET);
  const authConfigError =
    authEnabled && (sessionSecret === null || sessionSecret.length < 32)
      ? "SESSION_SECRET must be set to at least 32 characters while AUTH_ENABLED is on"
      : null;

  return {
    databaseUrl,
    databaseConfigured: databaseUrl !== null,
    redisUrl,
    redisConfigured: redisUrl !== null,
    llmApiKey,
    llmBaseUrl,
    llmModel,
    llmConfigured: llmApiKey !== null,
    newsProvider: parseProvider(nonEmpty(env.NEWS_PROVIDER), newsProviderSchema, "mock"),
    newsMode: nonEmpty(env.NEWS_MODE) === "backfill" ? "backfill" : "live",
    marketProvider: parseProvider(nonEmpty(env.MARKET_PROVIDER), marketProviderSchema, "mock"),
    fundamentalProvider: parseProvider(nonEmpty(env.FUNDAMENTAL_PROVIDER), fundamentalProviderSchema, "mock"),
    massiveApiKey,
    benzingaApiKey,
    fmpApiKey,
    pipelineAutorun: parseBoolean(nonEmpty(env.PIPELINE_AUTORUN), false),
    pipelineTickSeconds,
    logLevel,
    appUrl,
    isProduction: nonEmpty(env.NODE_ENV) === "production",
    authEnabled,
    sessionSecret,
    authConfigError,
    adminEmail: (nonEmpty(env.ADMIN_EMAIL) ?? "zakaria@nrapken.dev").toLowerCase(),
    adminDisplayName: nonEmpty(env.ADMIN_DISPLAY_NAME) ?? "Zakaria",
    adminPassword: nonEmpty(env.ADMIN_PASSWORD),
    alertWebhookUrl: nonEmpty(env.ALERT_WEBHOOK_URL),
    alertTelegramBotToken: nonEmpty(env.ALERT_TELEGRAM_BOT_TOKEN),
    alertTelegramChatId: nonEmpty(env.ALERT_TELEGRAM_CHAT_ID),
    alertDiscordWebhookUrl: nonEmpty(env.ALERT_DISCORD_WEBHOOK_URL),
    alertSlackWebhookUrl: nonEmpty(env.ALERT_SLACK_WEBHOOK_URL),
    smtpUrl: nonEmpty(env.SMTP_URL),
  };
}

export const config: Config = loadConfig();
