export const ERROR_CODES = [
  "validation_error",
  "unauthorized",
  "not_found",
  "conflict",
  "internal_error",
  "unavailable",
  "rate_limit",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const CODE_TO_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  internal_error: 500,
  unavailable: 503,
  rate_limit: 429,
};

/**
 * Application error carrying a stable machine-readable `code`, an HTTP `status`,
 * and an optional `fields` map (used to surface per-field validation messages).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string>;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { status?: number; fields?: Record<string, string>; cause?: unknown },
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options?.status ?? CODE_TO_STATUS[code];
    this.fields = options?.fields;
    this.cause = options?.cause;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) {
    return err;
  }
  if (err instanceof Error) {
    return new AppError("internal_error", err.message, { cause: err });
  }
  return new AppError("internal_error", String(err));
}

export function statusForCode(code: ErrorCode): number {
  return CODE_TO_STATUS[code];
}
