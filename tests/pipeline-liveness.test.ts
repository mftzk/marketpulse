import { describe, expect, it } from "vitest";

import { pipelineJobs, pipelineRuns } from "@/lib/db/schema";
import {
  STALE_RUN_ERROR,
  findRunLiveness,
  recoverStaleRuns,
  staleThresholdMs,
} from "@/lib/pipeline/liveness";

type RunningRow = { id: string; startedAt: Date | null };

function makeDb(rows: RunningRow[]) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
          return [];
        },
      }),
    }),
  };
  return { db: db as never, updates };
}

const NOW = new Date("2026-09-29T12:00:00.000Z");

describe("pipeline run liveness", () => {
  it("treats a freshly started run as genuinely running", async () => {
    const { db } = makeDb([{ id: "run-fresh", startedAt: new Date(NOW.getTime() - 20_000) }]);

    const liveness = await findRunLiveness(db, NOW);

    expect(liveness.running).toBe(true);
    expect(liveness.stale).toBe(false);
    expect(liveness.staleRunIds).toEqual([]);
  });

  it("flags a run old past max(3*deadline, 5min) as stale", async () => {
    const { db } = makeDb([{ id: "run-old", startedAt: new Date(NOW.getTime() - 10 * 60_000) }]);

    const liveness = await findRunLiveness(db, NOW);

    expect(liveness.running).toBe(false);
    expect(liveness.stale).toBe(true);
    expect(liveness.staleRunIds).toEqual(["run-old"]);
  });

  it("uses a floor of 5 minutes for the stale threshold", () => {
    expect(staleThresholdMs(90_000)).toBe(5 * 60_000);
    expect(staleThresholdMs(10 * 60_000)).toBe(30 * 60_000);
  });

  it("marks an old running run and its running job as failed", async () => {
    const { db, updates } = makeDb([
      { id: "run-old", startedAt: new Date(NOW.getTime() - 10 * 60_000) },
    ]);

    const recovered = await recoverStaleRuns(db, NOW);

    expect(recovered).toEqual(["run-old"]);
    const runUpdate = updates.find((update) => update.table === pipelineRuns);
    expect(runUpdate?.values.status).toBe("failed");
    expect(runUpdate?.values.error).toBe(STALE_RUN_ERROR);
    const jobUpdate = updates.find((update) => update.table === pipelineJobs);
    expect(jobUpdate?.values.status).toBe("failed");
    expect(jobUpdate?.values.error).toBe(STALE_RUN_ERROR);
  });

  it("does nothing when there is no stale run", async () => {
    const { db, updates } = makeDb([
      { id: "run-fresh", startedAt: new Date(NOW.getTime() - 1_000) },
    ]);

    const recovered = await recoverStaleRuns(db, NOW);

    expect(recovered).toEqual([]);
    expect(updates).toHaveLength(0);
  });
});
