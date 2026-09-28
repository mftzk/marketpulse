/**
 * Database error inspection. The `postgres` driver nests the original pg error
 * in the error's `cause` chain; we walk the chain to find the pg `code` (a
 * 5-char SQLSTATE) and the offending `constraint` name.
 */

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

function asErrorLike(value: unknown): PgErrorLike | null {
  if (value !== null && typeof value === "object") {
    return value as PgErrorLike;
  }
  return null;
}

/**
 * Human-readable message for an unknown error. Drizzle wraps driver failures
 * (`Failed query: …`), so the useful text lives deeper in the `cause` chain —
 * this returns the deepest message it can find.
 */
export function errorMessage(err: unknown): string {
  let current: unknown = err;
  let best = "";
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error && current.message) {
      best = current.message;
      current = current.cause;
      continue;
    }
    if (typeof current === "string") {
      best = current;
      break;
    }
    const like = asErrorLike(current);
    if (like === null) {
      break;
    }
    const message = like.message;
    if (typeof message === "string" && message.length > 0) {
      best = message;
    }
    current = like.cause;
  }
  if (best.length > 0) {
    return best;
  }
  return err === undefined ? "unknown error" : String(err);
}

/** Walks the `cause` chain and returns the first pg error `code` (SQLSTATE). */
export function pgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  while (current !== null && current !== undefined) {
    const errorLike = asErrorLike(current);
    if (errorLike && typeof errorLike.code === "string" && errorLike.code.length > 0) {
      return errorLike.code;
    }
    current = errorLike?.cause;
  }
  return null;
}

/** Returns the violated constraint name (e.g. a unique index name), if any. */
export function pgConstraintName(err: unknown): string | null {
  let current: unknown = err;
  while (current !== null && current !== undefined) {
    const errorLike = asErrorLike(current);
    if (errorLike && typeof errorLike.constraint === "string" && errorLike.constraint.length > 0) {
      return errorLike.constraint;
    }
    current = errorLike?.cause;
  }
  return null;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23503";
}

export function isNotNullViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23502";
}

export function isCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23514";
}

export function isExclusionViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23P01";
}
