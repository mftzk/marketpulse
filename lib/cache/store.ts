import net from "node:net";

import { config } from "@/lib/config";

/**
 * Cache store (§9). If `REDIS_URL` is configured we use a tiny, dependency-free
 * RESP client over `node:net` (AUTH / GET / SET / INCR / EXPIRE / DEL / PING,
 * one connection, reconnect with backoff, 1s timeouts, all errors swallowed →
 * fall back to memory). Otherwise we use an in-process `Map` with TTL.
 *
 * Guarantee: the cache is never a source of truth. Every read path re-reads
 * Postgres on a cache miss.
 */

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Returns the fn result, or `null` if the lock was already held. */
  withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null>;
}

// ---------------------------------------------------------------------------
// RESP codec (pure, exported for tests)
// ---------------------------------------------------------------------------

export function encodeRESP(args: readonly string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const data = Buffer.from(arg, "utf8");
    chunks.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

interface RESPParseResult {
  reply: unknown;
  end: number;
}

function readLine(input: string, offset: number): { line: string; end: number } | null {
  const idx = input.indexOf("\r\n", offset);
  if (idx === -1) {
    return null;
  }
  return { line: input.slice(offset, idx), end: idx + 2 };
}

function parseRESPAt(input: string, offset: number): RESPParseResult | null {
  if (offset >= input.length) {
    return null;
  }
  const type = input[offset];

  if (type === "+" || type === "-") {
    const r = readLine(input, offset + 1);
    if (r === null) {
      return null;
    }
    return { reply: r.line, end: r.end };
  }

  if (type === ":") {
    const r = readLine(input, offset + 1);
    if (r === null) {
      return null;
    }
    return { reply: parseInt(r.line, 10), end: r.end };
  }

  if (type === "$") {
    const r = readLine(input, offset + 1);
    if (r === null) {
      return null;
    }
    const len = parseInt(r.line, 10);
    if (len === -1) {
      return { reply: null, end: r.end };
    }
    const start = r.end;
    const end = start + len;
    if (end + 2 > input.length) {
      return null;
    }
    return { reply: input.slice(start, end), end: end + 2 };
  }

  if (type === "*") {
    const r = readLine(input, offset + 1);
    if (r === null) {
      return null;
    }
    const count = parseInt(r.line, 10);
    if (count === -1) {
      return { reply: null, end: r.end };
    }
    const items: unknown[] = [];
    let cursor = r.end;
    for (let i = 0; i < count; i += 1) {
      const item = parseRESPAt(input, cursor);
      if (item === null) {
        return null;
      }
      items.push(item.reply);
      cursor = item.end;
    }
    return { reply: items, end: cursor };
  }

  return null;
}

export function decodeRESP(input: string): { reply: unknown; consumed: number } {
  const parsed = parseRESPAt(input, 0);
  if (parsed === null) {
    return { reply: null, consumed: 0 };
  }
  return { reply: parsed.reply, consumed: parsed.end };
}

// ---------------------------------------------------------------------------
// Memory store (in-process Map + TTL)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

class MemoryStore implements CacheStore {
  private readonly map = new Map<string, MemoryEntry>();
  private readonly locks = new Map<string, number>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.map.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.map.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.map.set(key, { value: 1, expiresAt: Date.now() + ttlSeconds * 1000 });
      return 1;
    }
    const next = (entry.value as number) + 1;
    this.map.set(key, { value: next, expiresAt: entry.expiresAt });
    return next;
  }

  async withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
    const now = Date.now();
    const existing = this.locks.get(key);
    if (existing !== undefined && existing > now) {
      return null;
    }
    this.locks.set(key, now + ttlSeconds * 1000);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
    this.locks.clear();
  }
}

// ---------------------------------------------------------------------------
// Dependency-free Redis client (RESP over node:net)
// ---------------------------------------------------------------------------

interface RedisOptions {
  host: string;
  port: number;
  password?: string;
  database?: number;
}

export function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const databaseStr = parsed.pathname.replace(/^\//, "");
  const database = databaseStr.length > 0 ? parseInt(databaseStr, 10) : undefined;
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    password,
    database: Number.isFinite(database) ? database : undefined,
  };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class RedisClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending: PendingCommand[] = [];
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly opts: RedisOptions) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: this.opts.host, port: this.opts.port });
      socket.setNoDelay(true);
      socket.setTimeout(1000);
      this.socket = socket;

      const onError = (err: Error): void => {
        reject(err);
      };
      const onTimeout = (): void => {
        socket.destroy(new Error("redis connect timeout"));
      };
      const onConnect = (): void => {
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
        socket.setTimeout(0);
        resolve();
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("close", () => this.onClose());
      socket.on("error", () => this.onClose());
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }

    if (this.opts.password) {
      await this.raw(["AUTH", this.opts.password]);
    }
    if (this.opts.database !== undefined) {
      await this.raw(["SELECT", String(this.opts.database)]);
    }
  }

  async command(args: string[]): Promise<unknown> {
    await this.connect();
    return this.raw(args);
  }

  private raw(args: string[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        reject(new Error("redis not connected"));
        return;
      }
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.timer === timer);
        if (idx !== -1) {
          const [entry] = this.pending.splice(idx, 1);
          entry.reject(new Error("redis command timeout"));
        }
      }, 1000);

      this.pending.push({ resolve, reject, timer });
      socket.write(encodeRESP(args));
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      if (this.pending.length === 0) {
        return;
      }
      const { reply, consumed } = decodeRESP(this.buffer);
      if (consumed === 0) {
        return;
      }
      this.buffer = this.buffer.slice(consumed);
      const entry = this.pending.shift();
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      if (typeof reply === "string" && reply.startsWith("ERR")) {
        entry.reject(new Error(reply));
      } else {
        entry.resolve(reply);
      }
    }
  }

  private onClose(): void {
    const pending = this.pending.splice(0);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("redis connection closed"));
    }
    this.socket = null;
  }

  async ping(): Promise<string | null> {
    const reply = await this.command(["PING"]);
    return typeof reply === "string" ? reply : null;
  }
}

// ---------------------------------------------------------------------------
// Redis-backed store (memory fallback on any error)
// ---------------------------------------------------------------------------

class RedisStore implements CacheStore {
  constructor(
    private readonly client: RedisClient,
    private readonly fallback: MemoryStore,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const reply = await this.client.command(["GET", key]);
      if (typeof reply !== "string") {
        return null;
      }
      return JSON.parse(reply) as T;
    } catch {
      return this.fallback.get<T>(key);
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.command(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]);
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.command(["DEL", key]);
    } catch {
      await this.fallback.del(key);
    }
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    try {
      const reply = await this.client.command(["INCR", key]);
      if (typeof reply === "number") {
        await this.client.command(["EXPIRE", key, String(ttlSeconds)]);
        return reply;
      }
      throw new Error("unexpected INCR reply");
    } catch {
      return this.fallback.incr(key, ttlSeconds);
    }
  }

  async withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
    const token = Math.random().toString(36).slice(2);
    try {
      const reply = await this.client.command(["SET", key, token, "NX", "EX", String(ttlSeconds)]);
      if (reply === null) {
        return null;
      }
      try {
        return await fn();
      } finally {
        await this.client.command(["DEL", key]);
      }
    } catch {
      return this.fallback.withLock(key, ttlSeconds, fn);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory + test reset
// ---------------------------------------------------------------------------

let cachedStore: Promise<CacheStore> | null = null;
let memoryFallback: MemoryStore = new MemoryStore();

async function buildStore(): Promise<CacheStore> {
  if (config.redisConfigured && config.redisUrl) {
    const client = new RedisClient(parseRedisUrl(config.redisUrl));
    const redisStore = new RedisStore(client, memoryFallback);
    try {
      await client.connect();
      return redisStore;
    } catch {
      return memoryFallback;
    }
  }
  return memoryFallback;
}

export function createCacheStore(): Promise<CacheStore> {
  if (!cachedStore) {
    cachedStore = buildStore();
  }
  return cachedStore;
}

/** Resets the cached store and clears the in-process memory store. Test-only. */
export function resetStoreForTests(): void {
  cachedStore = null;
  memoryFallback.clear();
  memoryFallback = new MemoryStore();
}
