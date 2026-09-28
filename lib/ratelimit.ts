import { cacheKeys } from "@/lib/cache/keys";
import { createCacheStore } from "@/lib/cache/store";

/**
 * Per-client-IP rate limiting via the cache store (`incr(key, 60)`), limit
 * 30/min. Returns `true` when the request exceeds the limit. The cache store
 * degrades to memory when Redis is unavailable.
 */
export async function exceedsRateLimit(
  request: Request,
  bucket: string,
  limit = 30,
): Promise<boolean> {
  const store = await createCacheStore();
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const count = await store.incr(cacheKeys.rateLimit(`${bucket}:${ip}`), 60);
  return count > limit;
}
