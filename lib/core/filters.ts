import { z } from "zod";

import { CATALYST_DIRECTIONS } from "@/lib/core/catalyst";
import { EVENT_TYPES } from "@/lib/core/event-types";
import { MARKET_SESSIONS } from "@/lib/core/session";

export const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;

const eventTypeEnum = z.enum(EVENT_TYPES);
const catalystDirectionEnum = z.enum(CATALYST_DIRECTIONS);
const sessionEnum = z.enum(MARKET_SESSIONS);

export const limitFilter = z.coerce.number().int().min(1).max(100).default(25);

export const offsetFilter = z.coerce.number().int().min(0).default(0);

export const tickerFilter = z
  .string()
  .trim()
  .toUpperCase()
  .regex(TICKER_PATTERN, "Invalid ticker symbol");

export const sectorFilter = z.string().trim().min(1).max(60);

export const eventTypeFilter = z
  .string()
  .trim()
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(eventTypeEnum).min(1));

export const minImpactFilter = z.coerce.number().min(0).max(100);

export const maxImpactFilter = z.coerce.number().min(0).max(100);

export const sourceFilter = z.string().trim().min(1).max(80);

export const maxAgeMinutesFilter = z.coerce.number().int().min(0);

export const sessionFilter = sessionEnum;

export const catalystDirectionFilter = z
  .string()
  .trim()
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(catalystDirectionEnum).min(1));

export const qFilter = z.string().trim().min(1).max(200);

export const sortFilter = z
  .enum(["impact_desc", "published_desc", "impact_asc"])
  .default("impact_desc");

export const eventFiltersSchema = z
  .object({
    ticker: tickerFilter.optional(),
    sector: sectorFilter.optional(),
    event_type: eventTypeFilter.optional(),
    min_impact: minImpactFilter.optional(),
    max_impact: maxImpactFilter.optional(),
    source: sourceFilter.optional(),
    max_age_minutes: maxAgeMinutesFilter.optional(),
    session: sessionFilter.optional(),
    catalyst_direction: catalystDirectionFilter.optional(),
    q: qFilter.optional(),
    sort: sortFilter,
    limit: limitFilter,
    offset: offsetFilter,
  })
  .strict();

export type EventFilters = z.infer<typeof eventFiltersSchema>;

export const paginationSchema = z.object({
  limit: limitFilter,
  offset: offsetFilter,
});

export type Pagination = z.infer<typeof paginationSchema>;
