export const MARKET_SESSIONS = ["pre_market", "regular", "after_hours", "closed"] as const;

export type MarketSession = (typeof MARKET_SESSIONS)[number];

export const MARKET_SESSION_LABELS: Record<MarketSession, string> = {
  pre_market: "Pre-market",
  regular: "Regular",
  after_hours: "After-hours",
  closed: "Closed",
};

// US equity session boundaries (Eastern Time, minutes since midnight).
const PRE_MARKET_OPEN = 4 * 60; // 04:00
const REGULAR_OPEN = 9 * 60 + 30; // 09:30
const REGULAR_CLOSE = 16 * 60; // 16:00
const AFTER_HOURS_CLOSE = 20 * 60; // 20:00

const ET_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const ET_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface EtWallClock {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Minutes since midnight, Eastern Time */
  minutes: number;
}

/**
 * Resolves a timestamp to its Eastern Time wall-clock (weekday + minutes since
 * midnight) using the fixed `America/New_York` timezone (DST-aware via the
 * Intl API).
 */
export function etWallClock(ts: Date): EtWallClock {
  let hour = 0;
  let minute = 0;
  for (const part of ET_TIME_FORMATTER.formatToParts(ts)) {
    if (part.type === "hour") {
      hour = Number(part.value);
    } else if (part.type === "minute") {
      minute = Number(part.value);
    }
  }
  if (hour === 24) {
    hour = 0;
  }

  let weekdayAbbr = "";
  for (const part of ET_WEEKDAY_FORMATTER.formatToParts(ts)) {
    if (part.type === "weekday") {
      weekdayAbbr = part.value;
    }
  }

  const weekday = WEEKDAYS.indexOf(weekdayAbbr as (typeof WEEKDAYS)[number]);

  return { weekday, minutes: hour * 60 + minute };
}

/**
 * Maps a timestamp to the US equity market session it falls in. Weekends are
 * always `closed`. Overnight hours (20:00–04:00 ET) are also `closed`.
 */
export function sessionFor(ts: Date): MarketSession {
  const { weekday, minutes } = etWallClock(ts);
  if (weekday === 0 || weekday === 6) {
    return "closed";
  }
  if (minutes >= PRE_MARKET_OPEN && minutes < REGULAR_OPEN) {
    return "pre_market";
  }
  if (minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE) {
    return "regular";
  }
  if (minutes >= REGULAR_CLOSE && minutes < AFTER_HOURS_CLOSE) {
    return "after_hours";
  }
  return "closed";
}

/**
 * Resolves the session name for a given session value (identity, typed).
 */
export function isMarketSession(value: string): value is MarketSession {
  return (MARKET_SESSIONS as readonly string[]).includes(value);
}
