/**
 * Centralised cache key namespacing. Every key in the system is built here so
 * the Redis/memory stores and the pipeline share a single naming convention.
 */

export const cacheKeys = {
  /** Latest market snapshot for a ticker. */
  latest: (ticker: string): string => `latest:${ticker}`,

  /** Event dedupe short-circuit key (ticker + event type + time bucket). */
  dedupe: (ticker: string, eventType: string, bucket: string): string =>
    `event:dedupe:${ticker}:${eventType}:${bucket}`,

  /** Per-bucket rate limit counter. */
  rateLimit: (bucket: string): string => `ratelimit:${bucket}`,

  /** Distributed lock key. */
  lock: (name: string): string => `lock:${name}`,
};
