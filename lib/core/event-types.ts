export const EVENT_TYPES = [
  "EARNINGS",
  "GUIDANCE",
  "PRODUCT",
  "CONTRACT",
  "PARTNERSHIP",
  "M&A",
  "ANALYST_UPGRADE",
  "ANALYST_DOWNGRADE",
  "REGULATION",
  "LAWSUIT",
  "MANAGEMENT",
  "BUYBACK",
  "DIVIDEND",
  "OFFERING",
  "INSIDER_TRANSACTION",
  "MACRO",
  "OTHER",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  EARNINGS: "Earnings",
  GUIDANCE: "Guidance",
  PRODUCT: "Product",
  CONTRACT: "Contract",
  PARTNERSHIP: "Partnership",
  "M&A": "M&A",
  ANALYST_UPGRADE: "Analyst Upgrade",
  ANALYST_DOWNGRADE: "Analyst Downgrade",
  REGULATION: "Regulation",
  LAWSUIT: "Lawsuit",
  MANAGEMENT: "Management",
  BUYBACK: "Buyback",
  DIVIDEND: "Dividend",
  OFFERING: "Offering",
  INSIDER_TRANSACTION: "Insider Transaction",
  MACRO: "Macro",
  OTHER: "Other",
};

/**
 * Baseline importance for each event type (0..1). A type's intrinsic weight is
 * multiplied by the per-event `event_importance` before entering the impact
 * score (see §6.1). Sentiment alone never decides importance.
 */
export const EVENT_TYPE_BASE_IMPORTANCE: Record<EventType, number> = {
  EARNINGS: 1.0,
  GUIDANCE: 1.0,
  "M&A": 0.95,
  MACRO: 0.85,
  REGULATION: 0.8,
  ANALYST_DOWNGRADE: 0.7,
  LAWSUIT: 0.65,
  OFFERING: 0.6,
  PRODUCT: 0.6,
  CONTRACT: 0.6,
  PARTNERSHIP: 0.55,
  MANAGEMENT: 0.5,
  BUYBACK: 0.5,
  ANALYST_UPGRADE: 0.45,
  INSIDER_TRANSACTION: 0.4,
  DIVIDEND: 0.35,
  OTHER: 0.25,
};
