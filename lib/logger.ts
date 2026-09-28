export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Structured JSON logger. Emits one JSON object per line with the shape
 * `{ level, ts, msg, ...ctx }`. No external dependency. `event`, `duration_ms`
 * and any other structured fields are passed through via `ctx`.
 */
export class JsonLogger implements Logger {
  private readonly threshold: number;

  constructor(level: LogLevel = "info") {
    this.threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  }

  debug(msg: string, ctx?: LogContext): void {
    this.write("debug", msg, ctx);
  }

  info(msg: string, ctx?: LogContext): void {
    this.write("info", msg, ctx);
  }

  warn(msg: string, ctx?: LogContext): void {
    this.write("warn", msg, ctx);
  }

  error(msg: string, ctx?: LogContext): void {
    this.write("error", msg, ctx);
  }

  private write(level: LogLevel, msg: string, ctx?: LogContext): void {
    if (LEVEL_ORDER[level] < this.threshold) {
      return;
    }
    const entry: Record<string, unknown> = {
      level,
      ts: new Date().toISOString(),
      msg,
      ...(ctx ?? {}),
    };
    const line = safeStringify(entry);
    if (level === "error" || level === "warn") {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }
}

export function createLogger(level?: LogLevel): Logger {
  return new JsonLogger(level);
}

export const logger: Logger = new JsonLogger("info");
