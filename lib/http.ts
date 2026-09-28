import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";

import { AppError, isAppError, type ErrorCode } from "@/lib/errors";
import { logger } from "@/lib/logger";

export interface ListPage {
  limit: number;
  offset: number;
  next_offset: number | null;
  has_more: boolean;
  total: number;
}

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  fields?: Record<string, string>;
}

function zodFields(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    if (!(path in fields)) {
      fields[path] = issue.message;
    }
  }
  return fields;
}

export function jsonResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function listResponse<T>(
  data: T[],
  page: ListPage,
  meta?: object,
): NextResponse {
  return jsonResponse({
    data,
    page,
    generated_at: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  });
}

export function errorResponse(err: unknown): NextResponse {
  if (isAppError(err)) {
    const body: ErrorEnvelope = { error: err.message, code: err.code };
    if (err.fields) {
      body.fields = err.fields;
    }
    return jsonResponse(body, err.status);
  }

  if (err instanceof ZodError) {
    return jsonResponse(
      {
        error: "Invalid request",
        code: "validation_error",
        fields: zodFields(err),
      } satisfies ErrorEnvelope,
      400,
    );
  }

  logger.error("unhandled_error", {
    event: "http.error_response",
    error: err instanceof Error ? err.message : String(err),
  });

  return jsonResponse(
    { error: "Internal error", code: "internal_error" } satisfies ErrorEnvelope,
    500,
  );
}

export function notFound(message = "Not found"): NextResponse {
  return jsonResponse(
    { error: message, code: "not_found" } satisfies ErrorEnvelope,
    404,
  );
}

export function rateLimitResponse(message = "Too many requests"): NextResponse {
  return jsonResponse(
    { error: message, code: "rate_limit" } satisfies ErrorEnvelope,
    429,
  );
}

/**
 * Parses a request's query string against a zod schema. On failure it throws an
 * `AppError` with `validation_error` (so callers can pass it to `errorResponse`).
 * The schema decides strictness (use `.strict()` to reject unknown params).
 */
export function parseQuery<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): z.infer<S> {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const result = schema.safeParse(params);
  if (!result.success) {
    throw new AppError("validation_error", "Invalid query parameters", {
      fields: zodFields(result.error),
    });
  }
  return result.data;
}
