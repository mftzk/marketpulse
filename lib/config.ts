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

const providerSchema = z.enum(["mock"]);

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

function parseProvider(value: string | null, fallback: "mock"): "mock" {
  if (value === null) {
    return fallback;
  }
  const parsed = providerSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
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
  newsProvider: "mock";
  marketProvider: "mock";
  fundamentalProvider: "mock";
  pipelineAutorun: boolean;
  pipelineTickSeconds: number;
  logLevel: LogLevel;
  appUrl: string | null;
  isProduction: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = readEnv()): Config {
  const databaseUrl = nonEmpty(env.DATABASE_URL);
  const redisUrl = nonEmpty(env.REDIS_URL);
  const llmApiKey = nonEmpty(env.LLM_API_KEY);
  const llmBaseUrl = nonEmpty(env.LLM_BASE_URL);
  const llmModel = nonEmpty(env.LLM_MODEL) ?? "gpt-4o-mini";
  const appUrl = nonEmpty(env.APP_URL);

  const logLevel = parseLogLevel(nonEmpty(env.LOG_LEVEL));
  const pipelineTickSeconds = parsePositiveInt(nonEmpty(env.PIPELINE_TICK_SECONDS), 30);

  return {
    databaseUrl,
    databaseConfigured: databaseUrl !== null,
    redisUrl,
    redisConfigured: redisUrl !== null,
    llmApiKey,
    llmBaseUrl,
    llmModel,
    llmConfigured: llmApiKey !== null,
    newsProvider: parseProvider(nonEmpty(env.NEWS_PROVIDER), "mock"),
    marketProvider: parseProvider(nonEmpty(env.MARKET_PROVIDER), "mock"),
    fundamentalProvider: parseProvider(nonEmpty(env.FUNDAMENTAL_PROVIDER), "mock"),
    pipelineAutorun: parseBoolean(nonEmpty(env.PIPELINE_AUTORUN), false),
    pipelineTickSeconds,
    logLevel,
    appUrl,
    isProduction: nonEmpty(env.NODE_ENV) === "production",
  };
}

export const config: Config = loadConfig();
