import { logger } from "@/lib/logger";

/**
 * Server-side guard used by pages: runs an async data loader and, on any
 * failure (e.g. the database is unreachable, or `DATABASE_URL` is absent),
 * returns a fallback so the page still renders an empty/degraded state instead
 * of crashing. Errors are logged once per call site.
 */
export async function safeCall<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn("page_service_failed", {
      event: "ui.safe_call",
      label,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
