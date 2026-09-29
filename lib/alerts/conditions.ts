import { z } from "zod";

import { CATALYST_DIRECTIONS } from "@/lib/core/catalyst";
import { EVENT_TYPES } from "@/lib/core/event-types";

/**
 * Alert conditions schema (§8). Every field is optional, but at least one must
 * be present. Conditions are combined with AND semantics during evaluation.
 */
export const alertConditionsSchema = z
  .object({
    impact_score_gte: z.number().min(0).max(100).optional(),
    impact_score_lte: z.number().min(0).max(100).optional(),
    news_age_minutes_lt: z.number().int().min(0).optional(),
    rvol_gte: z.number().min(0).optional(),
    change_pct_gte: z.number().optional(),
    change_pct_lte: z.number().optional(),
    change_pct_abs_gte: z.number().min(0).optional(),
    tickers: z.array(z.string().min(1).max(20)).optional(),
    event_types: z.array(z.enum(EVENT_TYPES)).optional(),
    catalyst_direction: z.array(z.enum(CATALYST_DIRECTIONS)).optional(),
    sectors: z.array(z.string().min(1).max(60)).optional(),
  })
  .superRefine((value, ctx) => {
    const keys = [
      "impact_score_gte",
      "impact_score_lte",
      "news_age_minutes_lt",
      "rvol_gte",
      "change_pct_gte",
      "change_pct_lte",
      "change_pct_abs_gte",
      "tickers",
      "event_types",
      "catalyst_direction",
      "sectors",
    ] as const;
    if (!keys.some((key) => value[key] !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one condition is required",
      });
    }
  });

export type AlertConditions = z.infer<typeof alertConditionsSchema>;
