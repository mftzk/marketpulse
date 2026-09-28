import { z } from "zod";

import { EVENT_TYPES } from "@/lib/core/event-types";

/**
 * Strict LLM extraction schema (§5.2). The LLM only produces structured facts;
 * its output is validated against this schema before it is ever persisted.
 * Invalid output is never stored. The impact score is computed by deterministic
 * code (`lib/scoring/impact.ts`) — never from these fields.
 *
 * Note: `sentiment` and `catalyst_direction` describe *direction*, not
 * importance. `event_importance` (0..1) is a separate field the LLM must judge
 * on the magnitude of the event itself (vs. expectations), never as a function
 * of sentiment sign alone.
 */
export const classificationSchema = z
  .object({
    ticker: z
      .string()
      .regex(/^[A-Z][A-Z0-9.\-]{0,9}$/)
      .nullable(),
    company: z.string().min(1).max(160).nullable(),
    event_type: z.enum(EVENT_TYPES),
    summary: z.string().min(10).max(600),
    sentiment: z.number().min(-1).max(1),
    catalyst_direction: z.enum(["positive", "negative", "neutral", "mixed"]),
    company_relevance: z.number().min(0).max(1),
    event_importance: z.number().min(0).max(1),
    source_quality: z.number().min(0).max(1),
    affected_tickers: z.array(z.string().regex(/^[A-Z][A-Z0-9.\-]{0,9}$/)).max(12),
    affected_sectors: z.array(z.string().max(60)).max(6),
    reasoning: z.string().min(10).max(1200),
  })
  .strict();

export const classificationEnvelopeSchema = z
  .object({
    classifications: z.array(classificationSchema).max(20),
  })
  .strict();

export type Classification = z.infer<typeof classificationSchema>;

export type ClassificationEnvelope = z.infer<typeof classificationEnvelopeSchema>;
