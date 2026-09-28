import { afterEach, describe, expect, it, vi } from "vitest";

import { createCacheStore, decodeRESP, encodeRESP, resetStoreForTests } from "@/lib/cache/store";

afterEach(() => {
  vi.useRealTimers();
  resetStoreForTests();
});

describe("RESP codec", () => {
  it("round-trips a command array", () => {
    const encoded = encodeRESP(["SET", "key", "value"]);
    const { reply, consumed } = decodeRESP(encoded.toString("utf8"));
    expect(reply).toEqual(["SET", "key", "value"]);
    expect(consumed).toBe(encoded.length);
  });

  it("handles empty and partial buffers", () => {
    const encoded = encodeRESP(["PING"]);
    const full = decodeRESP(encoded.toString("utf8"));
    expect(full.reply).toEqual(["PING"]);

    const partial = decodeRESP(encoded.toString("utf8").slice(0, 4));
    expect(partial.consumed).toBe(0);
  });
});

describe("memory cache store", () => {
  it("sets and gets values", async () => {
    resetStoreForTests();
    const store = await createCacheStore();
    await store.set("a", { n: 1 }, 60);
    expect(await store.get<{ n: number }>("a")).toEqual({ n: 1 });
    expect(await store.get("missing")).toBeNull();
  });

  it("deletes values", async () => {
    resetStoreForTests();
    const store = await createCacheStore();
    await store.set("a", "x", 60);
    await store.del("a");
    expect(await store.get("a")).toBeNull();
  });

  it("expires entries after their TTL", async () => {
    vi.useFakeTimers();
    resetStoreForTests();
    const store = await createCacheStore();
    await store.set("a", "x", 1);
    expect(await store.get("a")).toBe("x");
    vi.advanceTimersByTime(1500);
    expect(await store.get("a")).toBeNull();
  });

  it("increments a counter within its TTL", async () => {
    resetStoreForTests();
    const store = await createCacheStore();
    expect(await store.incr("rate", 60)).toBe(1);
    expect(await store.incr("rate", 60)).toBe(2);
    expect(await store.incr("rate", 60)).toBe(3);
  });

  it("withLock runs fn once and returns null on contention", async () => {
    resetStoreForTests();
    const store = await createCacheStore();
    const first = store.withLock("lock", 10, async () => "first");
    const second = store.withLock("lock", 10, async () => "second");
    expect(await second).toBeNull();
    expect(await first).toBe("first");
  });
});
