/**
 * Relative volume (§6.2). Pure functions.
 *
 * `RVOL = cumulative_session_volume / expected_volume_to_same_time_of_day`.
 *
 * Expected volume is the mean of the last up-to-20 sessions' cumulative volume
 * at the same elapsed minute since the open. When no intraday history exists we
 * fall back to the previous session's full-day volume scaled by a U-shaped
 * intraday volume profile (fast open ≈13% of the day in the first 30 minutes,
 * a lunch trough, then a closing ramp).
 */

export interface SessionVolumePoint {
  /** Minutes elapsed since the session open. */
  elapsedMinutes: number;
  /** Cumulative volume up to (and including) that minute. */
  cumulativeVolume: number;
}

/**
 * U-shaped intraday volume profile, expressed as the fraction of a full-day
 * volume that has typically traded by `elapsedMinutes` since the open.
 * Piecewise-linear anchors (elapsed minutes → cumulative fraction).
 */
const PROFILE_ANCHORS: readonly [number, number][] = [
  [0, 0],
  [5, 0.03],
  [15, 0.08],
  [30, 0.13],
  [60, 0.2],
  [120, 0.32],
  [180, 0.43],
  [240, 0.53],
  [300, 0.63],
  [330, 0.7],
  [360, 0.8],
  [390, 0.95],
  [9999, 1],
];

function piecewiseLinear(points: readonly [number, number][], x: number): number {
  if (!Number.isFinite(x)) {
    return 0;
  }
  if (x <= points[0][0]) {
    return points[0][1];
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

/**
 * Returns the fraction of a full-day volume that has traded by `elapsedMinutes`
 * since the open (0..1), via the U-shaped profile.
 */
export function volumeProfileFraction(elapsedMinutes: number): number {
  return piecewiseLinear(PROFILE_ANCHORS, elapsedMinutes);
}

function interpolateAt(
  points: SessionVolumePoint[],
  elapsedMinutes: number,
): number | null {
  const sorted = [...points].sort((a, b) => a.elapsedMinutes - b.elapsedMinutes);
  if (sorted.length === 0) {
    return null;
  }
  const exact = sorted.find((p) => p.elapsedMinutes === elapsedMinutes);
  if (exact) {
    return exact.cumulativeVolume;
  }
  const before = [...sorted].reverse().find((p) => p.elapsedMinutes < elapsedMinutes);
  const after = sorted.find((p) => p.elapsedMinutes > elapsedMinutes);
  if (before && after) {
    const span = after.elapsedMinutes - before.elapsedMinutes;
    const t = (elapsedMinutes - before.elapsedMinutes) / span;
    return before.cumulativeVolume + t * (after.cumulativeVolume - before.cumulativeVolume);
  }
  if (before) {
    return before.cumulativeVolume;
  }
  if (after) {
    return after.cumulativeVolume;
  }
  return null;
}

export interface ExpectedVolumeInput {
  /** Per-prior-session cumulative volume curves (up to 20 used). */
  history: SessionVolumePoint[][];
  /** Previous session full-day volume (fallback). */
  prevSessionFullVolume: number | null;
  /** Minutes elapsed since the current session open. */
  elapsedMinutes: number;
}

/**
 * Expected cumulative volume by `elapsedMinutes` since the open: the mean of the
 * last up-to-20 sessions' cumulative volume at the same elapsed minute. Falls
 * back to `prevSessionFullVolume * volumeProfileFraction(elapsedMinutes)` when
 * no intraday history is available, and to `null` when neither is available.
 */
export function expectedVolumeToTime(input: ExpectedVolumeInput): number | null {
  const samples: number[] = [];
  const history = input.history.slice(-20);
  for (const session of history) {
    const value = interpolateAt(session, input.elapsedMinutes);
    if (value !== null && Number.isFinite(value)) {
      samples.push(value);
    }
  }

  if (samples.length > 0) {
    const sum = samples.reduce((acc, v) => acc + v, 0);
    return sum / samples.length;
  }

  if (
    input.prevSessionFullVolume !== null &&
    Number.isFinite(input.prevSessionFullVolume)
  ) {
    return input.prevSessionFullVolume * volumeProfileFraction(input.elapsedMinutes);
  }

  return null;
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
