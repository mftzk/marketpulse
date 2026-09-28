import { cacheKeys } from "@/lib/cache/keys";
import { createCacheStore } from "@/lib/cache/store";

/**
 * Increments a namespaced counter in the cache store and reports whether the
 * limit was exceeded. The store degrades to memory when Redis is unavailable,
 * so this can never throw on a cache outage.
 */
export async function consumeRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const store = await createCacheStore();
  const count = await store.incr(cacheKeys.rateLimit(bucket), windowSeconds);
  return count > limit;
}

/**
 * Per-client-IP rate limiting, limit 30/min by default. Returns `true` when the
 * request exceeds the limit.
 */
export async function exceedsRateLimit(
  request: Request,
  bucket: string,
  limit = 30,
): Promise<boolean> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return consumeRateLimit(`${bucket}:${ip}`, limit, 60);
}
