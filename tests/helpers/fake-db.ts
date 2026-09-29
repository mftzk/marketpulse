/**
 * Minimal scripted fake of the Drizzle query surface used by the incremental
 * pipeline steps. The steps issue a *fixed* sequence of batched statements, so
 * the fake returns scripted results in call order and records every operation —
 * which lets the regression tests assert "0 writes / bounded queries" without a
 * real database.
 */

export interface FakeDbOptions {
  /** Result rows for each `select` chain, in call order. */
  selects?: unknown[][];
  /** Result rows for each `execute(...)`, in call order. */
  executes?: unknown[][];
  /** Returning rows for each `insert(...).returning(...)`, in call order. */
  insertReturning?: unknown[][];
  /** Table objects for each insert, in call order (for assertions). */
  insertTables?: unknown[];
}

export interface FakeOp {
  op: "select" | "insert" | "delete" | "update" | "execute" | "transaction";
  table?: unknown;
  values?: unknown;
  limit?: unknown;
}

export interface FakeDb {
  db: unknown;
  ops: FakeOp[];
  selectCount: () => number;
  insertCount: () => number;
  executeCount: () => number;
  deleteCount: () => number;
  updateCount: () => number;
  insertValues: () => unknown[];
}

export function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const ops: FakeOp[] = [];
  const selectResults = [...(options.selects ?? [])];
  const executeResults = [...(options.executes ?? [])];
  const insertReturning = [...(options.insertReturning ?? [])];

  function makeChain(awaitValue: () => unknown): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    const passthrough = [
      "from",
      "leftJoin",
      "innerJoin",
      "where",
      "orderBy",
      "groupBy",
      "offset",
      "selectDistinctOn",
      "set",
      "onConflictDoUpdate",
      "onConflictDoNothing",
    ];
    for (const method of passthrough) {
      obj[method] = () => obj;
    }
    obj.limit = (value: unknown) => {
      (obj as { __limit?: unknown }).__limit = value;
      return obj;
    };
    obj.values = (value: unknown) => {
      (obj as { __values?: unknown }).__values = value;
      return obj;
    };
    obj.returning = () => Promise.resolve(awaitValue());
    obj.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) => {
      try {
        resolve(awaitValue());
      } catch (err) {
        if (reject) {
          reject(err);
        } else {
          throw err;
        }
      }
      return undefined;
    };
    return obj;
  }

  const db = {
    select: () => {
      const result = selectResults.shift() ?? [];
      const chain = makeChain(() => result);
      ops.push({ op: "select", limit: undefined });
      (chain as { __opIndex?: number }).__opIndex = ops.length - 1;
      const originalLimit = chain.limit as (value: unknown) => unknown;
      chain.limit = (value: unknown) => {
        ops[ops.length - 1] = { op: "select", limit: value };
        return originalLimit(value);
      };
      return chain;
    },
    insert: (table: unknown) => {
      const chain = makeChain(() => insertReturning.shift() ?? []);
      ops.push({ op: "insert", table, values: undefined });
      const originalValues = chain.values as (value: unknown) => unknown;
      chain.values = (value: unknown) => {
        ops[ops.length - 1] = { op: "insert", table, values: value };
        return originalValues(value);
      };
      return chain;
    },
    delete: (table: unknown) => {
      const chain = makeChain(() => undefined);
      ops.push({ op: "delete", table });
      return chain;
    },
    update: (table: unknown) => {
      const chain = makeChain(() => undefined);
      ops.push({ op: "update", table });
      return chain;
    },
    execute: async () => {
      const result = executeResults.shift() ?? [];
      ops.push({ op: "execute" });
      return result;
    },
    transaction: async (fn: (tx: unknown) => unknown) => {
      ops.push({ op: "transaction" });
      return fn(db);
    },
  };

  return {
    db,
    ops,
    selectCount: () => ops.filter((op) => op.op === "select").length,
    insertCount: () => ops.filter((op) => op.op === "insert").length,
    executeCount: () => ops.filter((op) => op.op === "execute").length,
    deleteCount: () => ops.filter((op) => op.op === "delete").length,
    updateCount: () => ops.filter((op) => op.op === "update").length,
    insertValues: () =>
      ops.filter((op) => op.op === "insert").map((op) => op.values),
  };
}
