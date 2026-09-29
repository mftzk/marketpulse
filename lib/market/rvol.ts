import { etWallClock, sessionFor, sessionForWallClock, type MarketSession } from "@/lib/core/session";

/**
 * Relative volume (§6.2). Pure functions.
 *
 * `RVOL = cumulative_session_volume / expected_volume_to_same_time_of_day`.
 *
 * Expected volume is the mean of 20 matching prior sessions' cumulative volume
 * at the same elapsed minute since the open. Insufficient history is unknown.
 */

export interface SessionVolumePoint {
  /** Minutes elapsed since the session open. */
  elapsedMinutes: number;
  /** Cumulative volume up to (and including) that minute. */
  cumulativeVolume: number;
}

/**
 * Synthetic intraday volume shape for explicit mock/DEMO feeds only. The RVOL
 * calculation below never uses this profile to replace missing history.
 */
const DEMO_PROFILE_ANCHORS: readonly [number, number][] = [
  [0, 0], [5, 0.03], [15, 0.08], [30, 0.13], [60, 0.2], [120, 0.32],
  [180, 0.43], [240, 0.53], [300, 0.63], [330, 0.7], [360, 0.8], [390, 0.95], [9999, 1],
];

export function volumeProfileFraction(elapsedMinutes: number): number {
  if (!Number.isFinite(elapsedMinutes)) return 0;
  if (elapsedMinutes <= DEMO_PROFILE_ANCHORS[0][0]) return DEMO_PROFILE_ANCHORS[0][1];
  for (let i = 0; i < DEMO_PROFILE_ANCHORS.length - 1; i += 1) {
    const [x0, y0] = DEMO_PROFILE_ANCHORS[i];
    const [x1, y1] = DEMO_PROFILE_ANCHORS[i + 1];
    if (elapsedMinutes <= x1) {
      const t = (elapsedMinutes - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return DEMO_PROFILE_ANCHORS[DEMO_PROFILE_ANCHORS.length - 1][1];
}

function interpolateAt(
  points: SessionVolumePoint[],
  elapsedMinutes: number,
): number | null {
  const sorted = [...points].sort((a, b) => a.elapsedMinutes - b.elapsedMinutes);
  return interpolateSortedAt(sorted, elapsedMinutes);
}

/**
 * Interpolates a cumulative-volume value from points already sorted ascending by
 * `elapsedMinutes` (binary search, no allocation). `curvesFromBars` produces
 * sorted points, so the hot RVOL loop uses this instead of re-sorting per call.
 */
function interpolateSortedAt(
  points: SessionVolumePoint[],
  elapsedMinutes: number,
): number | null {
  if (points.length === 0) {
    return null;
  }
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid];
    if (point.elapsedMinutes === elapsedMinutes) {
      return point.cumulativeVolume;
    }
    if (point.elapsedMinutes < elapsedMinutes) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const after = points[lo];
  const before = points[hi];
  if (!before || !after) {
    return null;
  }
  const span = after.elapsedMinutes - before.elapsedMinutes;
  if (span <= 0) {
    return before.cumulativeVolume;
  }
  const t = (elapsedMinutes - before.elapsedMinutes) / span;
  return before.cumulativeVolume + t * (after.cumulativeVolume - before.cumulativeVolume);
}

export interface ExpectedVolumeInput {
  /** Per-prior-session cumulative volume curves. */
  history: SessionVolumePoint[][];
  /** Minutes elapsed since the current session open. */
  elapsedMinutes: number;
  /** Number of matching prior sessions required; defaults to 20. */
  requiredSessions?: number;
}

/**
 * Expected cumulative volume by `elapsedMinutes` since the open. All required
 * prior sessions must contain an observation or interpolated point at that
 * time; no daily-volume profile is substituted.
 */
export function expectedVolumeToTime(input: ExpectedVolumeInput): number | null {
  const requiredSessions = input.requiredSessions ?? 20;
  if (!Number.isInteger(requiredSessions) || requiredSessions < 1) return null;
  const samples: number[] = [];
  const history = input.history.slice(-requiredSessions);
  if (history.length < requiredSessions) return null;
  for (const session of history) {
    const value = interpolateAt(session, input.elapsedMinutes);
    if (value !== null && Number.isFinite(value)) {
      samples.push(value);
    }
  }

  if (samples.length < requiredSessions) return null;
  return samples.reduce((sum, value) => sum + value, 0) / requiredSessions;
}

/**
 * Computes RVOL from a cumulative volume and an expected volume. Returns `null`
 * when either input is missing/non-finite or the expected volume is ≤ 0.
 */
export function computeRvol(
  cumulativeVolume: number | null,
  expectedVolume: number | null,
): number | null {
  if (
    cumulativeVolume === null ||
    expectedVolume === null ||
    !Number.isFinite(cumulativeVolume) ||
    !Number.isFinite(expectedVolume) ||
    expectedVolume <= 0
  ) {
    return null;
  }
  return cumulativeVolume / expectedVolume;
}
export interface TimedVolumeBar {
  time: number;
  volume: number;
}

export interface SessionRvolPoint {
  cumulativeVolume: number;
  expectedVolume: number | null;
  rvol: number | null;
  expectedSampleCount: number;
  session: MarketSession;
  asOf: Date;
  comparisonSession: string;
}

interface SessionCurve {
  date: string;
  session: Exclude<MarketSession, "closed">;
  points: SessionVolumePoint[];
  timestamps: Date[];
}

/**
 * Hoisted formatter: constructing `Intl.DateTimeFormat` per bar was the dominant
 * cost of the RVOL pass over a full 50-day minute series (tens of thousands of
 * constructions per ticker per tick).
 */
const ET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Memoised per epoch-second; all tickers share the same minute grid. */
const EASTERN_DATE_CACHE = new Map<number, string>();
const MAX_EASTERN_DATE_ENTRIES = 200_000;

function easternDate(ts: Date): string {
  const key = Math.floor(ts.getTime() / 1000);
  const cached = EASTERN_DATE_CACHE.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const parts = ET_DATE_FORMATTER.formatToParts(ts);
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? "";
  const value = `${get("year")}-${get("month")}-${get("day")}`;
  if (EASTERN_DATE_CACHE.size >= MAX_EASTERN_DATE_ENTRIES) {
    EASTERN_DATE_CACHE.clear();
  }
  EASTERN_DATE_CACHE.set(key, value);
  return value;
}

function sessionStartMinute(session: Exclude<MarketSession, "closed">): number {
  return session === "pre_market" ? 240 : session === "regular" ? 570 : 960;
}

function curvesFromBars(bars: readonly TimedVolumeBar[]): SessionCurve[] {
  const groups = new Map<string, { date: string; session: Exclude<MarketSession, "closed">; bars: { ts: Date; volume: number; minutes: number }[] }>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.time) || !Number.isFinite(bar.volume) || bar.volume < 0) continue;
    const ts = new Date(bar.time * 1000);
    const wall = etWallClock(ts);
    const session = sessionForWallClock(wall);
    if (session === "closed") continue;
    const date = easternDate(ts);
    const key = `${date}:${session}`;
    const group = groups.get(key) ?? { date, session, bars: [] };
    group.bars.push({ ts, volume: bar.volume, minutes: wall.minutes });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const ordered = group.bars.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    let cumulative = 0;
    const points: SessionVolumePoint[] = [];
    for (const item of ordered) {
      const elapsedMinutes = item.minutes - sessionStartMinute(group.session);
      if (elapsedMinutes < 0) continue;
      cumulative += item.volume;
      points.push({ elapsedMinutes, cumulativeVolume: cumulative });
    }
    return { date: group.date, session: group.session, points, timestamps: ordered.map((p) => p.ts) };
  }).filter((curve) => curve.points.length > 0).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Build same-session, same-time RVOL values from actual intraday volume bars.
 * A value is unavailable until the requested count of matching historical
 * sessions exists; daily-average/profile estimates are not substituted.
 */
export function matchedSessionRvol(
  bars: readonly TimedVolumeBar[],
  now: Date,
  priorSessionCount = 20,
): Map<number, SessionRvolPoint> {
  const curves = curvesFromBars(bars);
  const liveSession = sessionFor(now);
  const today = easternDate(now);
  let target = liveSession === "closed"
    ? [...curves].reverse().find((curve) => curve.session === "regular") ?? curves[curves.length - 1] ?? null
    : curves.find((curve) => curve.date === today && curve.session === liveSession) ?? null;
  // During an open session old bars are stale and must not masquerade as live.
  // A closed market may use the latest completed session with matching history.
  if (liveSession !== "closed" && target?.date !== today) return new Map();
  if (liveSession !== "closed" && target) {
    const latestBar = target.timestamps[target.timestamps.length - 1];
    if (!latestBar || now.getTime() - latestBar.getTime() > 15 * 60_000) return new Map();
  }
  const output = new Map<number, SessionRvolPoint>();
  if (!target) return output;

  const prior = curves.filter((curve) => curve.session === target?.session && curve.date < (target?.date ?? ""));
  const history = prior.slice(-priorSessionCount).map((curve) => curve.points);
  const at = liveSession === target.session && target.date === today
    ? etWallClock(now).minutes - sessionStartMinute(target.session)
    : target.points[target.points.length - 1].elapsedMinutes;
  for (let i = 0; i < target.points.length; i += 1) {
    const point = target.points[i];
    if (point.elapsedMinutes > at) continue;
    const samples = history.map((session) => interpolateSortedAt(session, point.elapsedMinutes))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const expected = samples.length >= priorSessionCount
      ? samples.slice(-priorSessionCount).reduce((sum, value) => sum + value, 0) / priorSessionCount
      : null;
    const rvol = computeRvol(point.cumulativeVolume, expected);
    const timestamp = target.timestamps[i];
    if (!timestamp) continue;
    output.set(Math.floor(timestamp.getTime() / 1000), {
      cumulativeVolume: point.cumulativeVolume,
      expectedVolume: expected,
      rvol,
      expectedSampleCount: samples.length,
      session: target.session,
      asOf: timestamp,
      comparisonSession: target.session,
    });
  }
  return output;
}
