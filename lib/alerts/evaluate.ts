import type { AlertConditions } from "@/lib/alerts/conditions";
import type { CatalystDirection } from "@/lib/core/catalyst";
import type { EventType } from "@/lib/core/event-types";

/**
 * Rule evaluation (§8). Pure and deterministic: `evaluateRule` returns whether
 * an event matches a rule and which conditions matched. Conditions combine with
 * AND semantics; a condition with a missing input on the event side (e.g. no
 * RVOL) does not match.
 */

export interface AlertEventView {
  impactScore: number | null;
  newsAgeMinutes: number | null;
  rvol: number | null;
  changePct: number | null;
  ticker: string | null;
  eventType: EventType;
  catalystDirection: CatalystDirection | null;
  sector: string | null;
}

export interface RuleEvaluation {
  matches: boolean;
  matched: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function evaluateRule(
  conditions: AlertConditions,
  event: AlertEventView,
): RuleEvaluation {
  const checks: Array<{ key: string; passes: boolean }> = [];

  if (conditions.impact_score_gte !== undefined) {
    checks.push({
      key: "impact_score_gte",
      passes: event.impactScore !== null && isFiniteNumber(event.impactScore) && event.impactScore >= conditions.impact_score_gte,
    });
  }
  if (conditions.impact_score_lte !== undefined) {
    checks.push({
      key: "impact_score_lte",
      passes: event.impactScore !== null && isFiniteNumber(event.impactScore) && event.impactScore <= conditions.impact_score_lte,
    });
  }
  if (conditions.news_age_minutes_lt !== undefined) {
    checks.push({
      key: "news_age_minutes_lt",
      passes: event.newsAgeMinutes !== null && isFiniteNumber(event.newsAgeMinutes) && event.newsAgeMinutes < conditions.news_age_minutes_lt,
    });
  }
  if (conditions.rvol_gte !== undefined) {
    checks.push({
      key: "rvol_gte",
      passes: event.rvol !== null && isFiniteNumber(event.rvol) && event.rvol >= conditions.rvol_gte,
    });
  }
  if (conditions.change_pct_gte !== undefined) {
    checks.push({
      key: "change_pct_gte",
      passes: event.changePct !== null && isFiniteNumber(event.changePct) && event.changePct >= conditions.change_pct_gte,
    });
  }
  if (conditions.change_pct_lte !== undefined) {
    checks.push({
      key: "change_pct_lte",
      passes: event.changePct !== null && isFiniteNumber(event.changePct) && event.changePct <= conditions.change_pct_lte,
    });
  }
  if (conditions.change_pct_abs_gte !== undefined) {
    checks.push({
      key: "change_pct_abs_gte",
      passes: event.changePct !== null && isFiniteNumber(event.changePct) && Math.abs(event.changePct) >= conditions.change_pct_abs_gte,
    });
  }
  if (conditions.tickers !== undefined) {
    checks.push({
      key: "tickers",
      passes: event.ticker !== null && conditions.tickers.includes(event.ticker),
    });
  }
  if (conditions.event_types !== undefined) {
    checks.push({
      key: "event_types",
      passes: conditions.event_types.includes(event.eventType),
    });
  }
  if (conditions.catalyst_direction !== undefined) {
    checks.push({
      key: "catalyst_direction",
      passes:
        event.catalystDirection !== null &&
        conditions.catalyst_direction.includes(event.catalystDirection),
    });
  }
  if (conditions.sectors !== undefined) {
    checks.push({
      key: "sectors",
      passes: event.sector !== null && conditions.sectors.includes(event.sector),
    });
  }

  const matches = checks.length > 0 && checks.every((check) => check.passes);
  const matched = checks.filter((check) => check.passes).map((check) => check.key);

  return { matches, matched };
}
