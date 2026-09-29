import { beforeEach, describe, expect, it, vi } from "vitest";

import { pipelineJobs, pipelineRuns } from "@/lib/db/schema";

/**
 * Pipeline advisory-lock + deadline regression tests.
 *
 * The production incident: `pg_try_advisory_lock` was acquired via pooled
 * `db.execute()` and released on a DIFFERENT pooled connection, leaking the
 * session-scoped lock and skipping every later tick. These tests pin the lock to
 * a reserved connection and assert it is always released on the same one.
 */

type RecordedUpdate = { table: unknown; values: Record<string, unknown> };

const h = vi.hoisted(() => {
  interface HoistedState {
    events: string[];
    connCounter: number;
    acquire: boolean;
    unlockThrows: boolean;
    cacheThrows: boolean;
    stepMode: "ok" | "hang" | "throw";
    runningRows: Array<Record<string, unknown>>;
    updates: RecordedUpdate[];
  }

  const state: HoistedState = {
    events: [],
    connCounter: 0,
    acquire: true,
    unlockThrows: false,
    cacheThrows: false,
    stepMode: "ok",
    runningRows: [],
    updates: [],
  };

  function reset(): void {
    state.events = [];
    state.connCounter = 0;
    state.acquire = true;
    state.unlockThrows = false;
    state.cacheThrows = false;
    state.stepMode = "ok";
    state.runningRows = [];
    state.updates = [];
  }

  const step = async () => {
    if (state.stepMode === "throw") {
      throw new Error("provider exploded");
    }
    if (state.stepMode === "hang") {
      return new Promise<never>(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { name: "fetch_news", status: "succeeded" as const, durationMs: 1, processed: 0 };
  };

  function insertChain(table: unknown): unknown {
    const chain: unknown = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "values") {
          return (values: Record<string, unknown>) => {
            state.updates.push({ table, values });
            return chain;
          };
        }
        if (prop === "returning") {
          return () => chain;
        }
        if (prop === "then") {
          const promise = Promise.resolve([{ id: "job-1" }]);
          return (resolve: unknown, reject: unknown) => promise.then(resolve as never, reject as never);
        }
        if (prop === "catch") {
          const promise = Promise.resolve([{ id: "job-1" }]);
          return (reject: unknown) => promise.catch(reject as never);
        }
        if (prop === "finally") {
          const promise = Promise.resolve([{ id: "job-1" }]);
          return (onFinally: unknown) => promise.finally(onFinally as never);
        }
        return () => chain;
      },
      apply() {
        return chain;
      },
    });
    return chain;
  }

  function updateChain(table: unknown): unknown {
    const chain: unknown = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "set") {
          return (values: Record<string, unknown>) => {
            state.updates.push({ table, values });
            return chain;
          };
        }
        if (prop === "then") {
          const promise = Promise.resolve([]);
          return (resolve: unknown, reject: unknown) => promise.then(resolve as never, reject as never);
        }
        if (prop === "catch") {
          const promise = Promise.resolve([]);
          return (reject: unknown) => promise.catch(reject as never);
        }
        if (prop === "finally") {
          const promise = Promise.resolve([]);
          return (onFinally: unknown) => promise.finally(onFinally as never);
        }
        return () => chain;
      },
      apply() {
        return chain;
      },
    });
    return chain;
  }

  function selectChain(): unknown {
    let rows: unknown[] = [];
    const chain: unknown = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "from") {
          return () => {
            rows = state.runningRows;
            return chain;
          };
        }
        if (prop === "then") {
          const promise = Promise.resolve(rows);
          return (resolve: unknown, reject: unknown) => promise.then(resolve as never, reject as never);
        }
        if (prop === "catch") {
          const promise = Promise.resolve(rows);
          return (reject: unknown) => promise.catch(reject as never);
        }
        if (prop === "finally") {
          const promise = Promise.resolve(rows);
          return (onFinally: unknown) => promise.finally(onFinally as never);
        }
        return () => chain;
      },
      apply() {
        return chain;
      },
    });
    return chain;
  }

  const db = {
    insert: (table: unknown) => insertChain(table),
    update: (table: unknown) => updateChain(table),
    select: () => selectChain(),
  };

  const raw = {
    reserve: async () => {
      state.connCounter += 1;
      const id = `conn-${state.connCounter}`;
      state.events.push(`reserve:${id}`);
      return {
        unsafe: async (query: string) => {
          if (/pg_try_advisory_lock/i.test(query)) {
            state.events.push(`lock:${id}`);
            return [{ acquired: state.acquire }];
          }
          if (/pg_advisory_unlock/i.test(query)) {
            state.events.push(`unlock:${id}`);
            if (state.unlockThrows) {
              throw Object.assign(new Error("you don't own a lock of type ExclusiveLock"), {
                code: "01000",
              });
            }
            return [{ pg_advisory_unlock: true }];
          }
          return [];
        },
        release: () => {
          state.events.push(`release:${id}`);
        },
      };
    },
  };

  return { state, reset, step, db, raw };
});

vi.mock("@/lib/db/client", () => ({
  getDb: () => h.db,
  getRawClient: () => h.raw,
  normalizeParam: (value: unknown) => value,
  normalizeParams: (params: unknown) => params,
}));

vi.mock("@/lib/cache/store", () => ({
  createCacheStore: async () => {
    if (h.state.cacheThrows) {
      throw new Error("cache unavailable");
    }
    return {
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      incr: async () => 0,
      withLock: async () => null,
    };
  },
}));

vi.mock("@/lib/providers", () => ({
  getNewsProvider: () => ({}),
  getMarketDataProvider: () => ({}),
  getFundamentalDataProvider: () => ({}),
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

vi.mock("@/lib/pipeline/registry", () => ({
  PIPELINE_STEPS: [async () => h.step()],
  STEP_NAMES: ["fetch_news"],
  stepByName: () => async () => h.step(),
}));

const { runPipelineTick, isPipelineTickInFlight, startPipelineTickInBackground } = await import(
  "@/lib/pipeline/run"
);

beforeEach(() => {
  h.reset();
});

describe("runPipelineTick advisory lock", () => {
  it("acquires and releases the lock on the SAME reserved connection", async () => {
    const report = await runPipelineTick({ trigger: "manual" });

    expect(report.status).toBe("succeeded");
    expect(report.runId).not.toBeNull();
    expect(h.state.events).toEqual([
      "reserve:conn-1",
      "lock:conn-1",
      "unlock:conn-1",
      "release:conn-1",
    ]);
  });

  it("releases the reserved connection immediately when the lock is held", async () => {
    h.state.acquire = false;

    const report = await runPipelineTick({ trigger: "scheduler" });

    expect(report.status).toBe("skipped");
    expect(h.state.events).toEqual(["reserve:conn-1", "lock:conn-1", "release:conn-1"]);
  });

  it("always releases the connection when the tick throws", async () => {
    h.state.cacheThrows = true;

    await expect(runPipelineTick({ trigger: "manual" })).rejects.toThrow("cache unavailable");

    expect(h.state.events).toContain("unlock:conn-1");
    expect(h.state.events).toContain("release:conn-1");
  });

  it("tolerates a 01000 'not owner' unlock warning and still releases", async () => {
    h.state.unlockThrows = true;

    const report = await runPipelineTick({ trigger: "manual" });

    expect(report.status).toBe("succeeded");
    expect(h.state.events).toEqual([
      "reserve:conn-1",
      "lock:conn-1",
      "unlock:conn-1",
      "release:conn-1",
    ]);
  });

  it("uses exactly one reserved connection per tick (no second reserve for unlock)", async () => {
    await runPipelineTick({ trigger: "manual" });
    const reserveEvents = h.state.events.filter((event) => event.startsWith("reserve:"));
    expect(reserveEvents).toHaveLength(1);
  });
});

describe("runPipelineTick deadline", () => {
  it("releases the lock on timeout and never leaves the run 'running'", async () => {
    h.state.stepMode = "hang";

    const report = await runPipelineTick({ trigger: "manual", deadlineMs: 40 });

    expect(report.status).toBe("failed");
    expect(report.runId).not.toBeNull();
    expect(h.state.events).toContain("unlock:conn-1");
    expect(h.state.events).toContain("release:conn-1");

    const runUpdates = h.state.updates.filter((update) => update.table === pipelineRuns);
    const failedRun = runUpdates.find((update) => update.values.status === "failed");
    expect(failedRun).toBeTruthy();
    expect(failedRun?.values.error).toContain("deadline exceeded");
    expect(runUpdates.some((update) => update.values.status === "running")).toBe(true);

    const jobUpdates = h.state.updates.filter((update) => update.table === pipelineJobs);
    expect(jobUpdates.some((update) => update.values.status === "failed")).toBe(true);
  });
});

describe("background single-flight trigger", () => {
  it("reports nothing in flight before and after a background tick", async () => {
    expect(isPipelineTickInFlight()).toBe(false);
    const handle = startPipelineTickInBackground({ trigger: "api" });
    expect(handle.started).toBe(true);
    // Wait for the detached promise chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isPipelineTickInFlight()).toBe(false);
  });
});
