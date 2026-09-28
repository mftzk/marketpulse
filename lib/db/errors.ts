/**
 * Database error inspection. The `postgres` driver nests the original pg error
 * in the error's `cause` chain; we walk the chain to find the pg `code` (a
 * 5-char SQLSTATE) and the offending `constraint` name.
 */

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

function asErrorLike(value: unknown): PgErrorLike | null {
  if (value !== null && typeof value === "object") {
    return value as PgErrorLike;
  }
  return null;
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
