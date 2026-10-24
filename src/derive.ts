// Turns a year of one gate's held-out weeks into the evidence for a tier, by
// the disposition rules in the gate confidence design: the year's worst slack,
// each calendar quarter's medians, and the three disqualifiers.
import type { ResultRow } from "./rows.ts";

/** The bar in openwatersio/slackwater's docs/validation/chs-currents.md, with the bounded tier's ceiling. */
export const BAR = {
  slackMedianMin: 15,
  finalWorstMin: 30,
  boundedWorstMin: 45,
  extremumMedianMin: 20,
  speedMedianKn: 0.5,
  reversedShare: 0.6,
} as const;

/** How many of the newest grid points pool into one evaluation: a year of fit ends. */
export const POOLED_GRID_POINTS = 13;
/** The windows a gate can ship at. A 365-day window is scored in backfills but reported only. */
export const RECIPE_WINDOWS = [60, 210] as const;

export type MissClause =
  | "reversed_axis"
  | "invented_slack"
  | "missed_slack"
  | "slack_worst"
  | "slack_median"
  | "extremum_timing"
  | "peak_speed";

export interface Margin {
  minutes: number;
  knots: number;
}
export const NO_MARGIN: Margin = { minutes: 0, knots: 0 };
/** How far a promotion must clear each boundary, on two consecutive grid points. */
export const PROMOTION_MARGIN: Margin = { minutes: 1, knots: 0.05 };

export interface QuarterStats {
  quarter: number;
  weeks: number;
  slacks: number;
  extrema: number;
  slack_median_min: number | null;
  extremum_median_min: number | null;
  speed_median_kn: number | null;
}

export interface WindowEval {
  days: number;
  weeks: number;
  missed: number;
  invented: number;
  /** The worst week's share of CHS extrema at which the model's velocity had the wrong sign. */
  wrong_sign_share: number;
  worst_slack_min: number | null;
  /** Always four, January to March first. */
  quarters: QuarterStats[];
}

/** One window's evaluation per fit length; 60 and 210 days are always present. */
export type Evaluation = Record<number, WindowEval>;

export interface Miss {
  clause: MissClause;
  value: number | null;
}

export interface WindowVerdict {
  tier: "final" | "bounded" | "online";
  bound?: number;
}

// Float noise must not move a value across a bar: the median of 0.34 and 0.56 kn is 0.45000000000000007, over the 0.45 kn promotion bar.
export const EPSILON = 1e-9;
export const atMost = (value: number | null, limit: number) =>
  value !== null && value <= limit + EPSILON;
const upTo = (value: number, digits: number) =>
  Math.ceil(value * 10 ** digits - EPSILON) / 10 ** digits;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The calendar quarter a week starts in. Weeks start at a Canadian gate's local midnight, which falls on the same UTC date. */
export function quarterOf(weekStart: string): number {
  return Math.floor(new Date(weekStart).getUTCMonth() / 3) + 1;
}

/** Pools one window's scored weeks: medians over every matched slack, extremum and speed in each quarter. */
export function evaluateWindow(days: number, rows: readonly ResultRow[]): WindowEval {
  const quarters = [1, 2, 3, 4].map((quarter) => ({
    quarter,
    weeks: 0,
    slacks: [] as number[],
    extrema: [] as number[],
    speeds: [] as number[],
  }));
  let weeks = 0;
  let missed = 0;
  let invented = 0;
  let share = 0;
  let worst: number | null = null;
  for (const r of rows) {
    if (r.fit_days !== days || r.status !== "scored") continue;
    weeks++;
    const errors = r.slack_errors ?? [];
    const matched = errors.filter((e): e is number => e !== null);
    missed += errors.length - matched.length;
    invented += r.invented ?? 0;
    const extrema = r.extrema ?? 0;
    if (extrema > 0) share = Math.max(share, (r.wrong_sign ?? 0) / extrema);
    for (const e of matched) if (worst === null || e > worst) worst = e;
    const q = quarters[quarterOf(r.week_start) - 1];
    q.weeks++;
    q.slacks.push(...matched);
    q.extrema.push(...(r.extremum_errors ?? []));
    q.speeds.push(...(r.speed_errors ?? []));
  }
  return {
    days,
    weeks,
    missed,
    invented,
    wrong_sign_share: share,
    worst_slack_min: worst,
    quarters: quarters.map((q) => ({
      quarter: q.quarter,
      weeks: q.weeks,
      slacks: q.slacks.length,
      extrema: q.extrema.length,
      slack_median_min: median(q.slacks),
      extremum_median_min: median(q.extrema),
      speed_median_kn: median(q.speeds),
    })),
  };
}

/** The first disqualifier a window shows: a reversed axis in any week, then any invented slack, then any missed slack. */
export function disqualifier(
  w: WindowEval,
): "reversed_axis" | "invented_slack" | "missed_slack" | null {
  if (w.wrong_sign_share >= BAR.reversedShare - EPSILON) return "reversed_axis";
  if (w.invented > 0) return "invented_slack";
  if (w.missed > 0) return "missed_slack";
  return null;
}

/** The first median clause some quarter fails, each limit tightened by `margin`. A quarter with nothing to measure fails. */
export function failingMedian(
  w: WindowEval,
  margin: Margin,
): "slack_median" | "extremum_timing" | "peak_speed" | null {
  const every = (pick: (q: QuarterStats) => number | null, limit: number) =>
    w.quarters.every((q) => atMost(pick(q), limit));
  if (!every((q) => q.slack_median_min, BAR.slackMedianMin - margin.minutes)) {
    return "slack_median";
  }
  if (!every((q) => q.extremum_median_min, BAR.extremumMedianMin - margin.minutes)) {
    return "extremum_timing";
  }
  if (!every((q) => q.speed_median_kn, BAR.speedMedianKn - margin.knots)) return "peak_speed";
  return null;
}

/** Rounds a worst slack error up to the next 5 minutes for a quoted bound, never below 5, so no bound reads 0. */
export function roundUpTo5(minutes: number): number {
  return Math.max(5, Math.ceil(minutes / 5 - EPSILON) * 5);
}

/** The tier one window earns on its own. */
export function windowVerdict(w: WindowEval): WindowVerdict {
  if (disqualifier(w) || failingMedian(w, NO_MARGIN) || w.worst_slack_min === null) {
    return { tier: "online" };
  }
  if (atMost(w.worst_slack_min, BAR.finalWorstMin)) return { tier: "final" };
  if (atMost(w.worst_slack_min, BAR.boundedWorstMin)) {
    return { tier: "bounded", bound: roundUpTo5(w.worst_slack_min) };
  }
  return { tier: "online" };
}

function worstQuarter(
  w: WindowEval,
  pick: (q: QuarterStats) => number | null,
  digits: number,
): number | null {
  const values = w.quarters.map(pick);
  if (values.some((v) => v === null)) return null;
  return upTo(Math.max(...(values as number[])), digits);
}

/**
 * Why a window falls short of the bounded tier, as the first failing clause in
 * the design's order with its value, each limit tightened by `margin`; null
 * when it doesn't fall short. A worst slack is a miss only above 45 minutes.
 */
export function missOf(w: WindowEval, margin: Margin = NO_MARGIN): Miss | null {
  const d = disqualifier(w);
  if (d === "reversed_axis") {
    return { clause: d, value: Math.ceil(w.wrong_sign_share * 100 - EPSILON) };
  }
  if (d === "invented_slack") return { clause: d, value: w.invented };
  if (d === "missed_slack") return { clause: d, value: w.missed };
  if (
    w.worst_slack_min !== null &&
    !atMost(w.worst_slack_min, BAR.boundedWorstMin - margin.minutes)
  ) {
    return { clause: "slack_worst", value: upTo(w.worst_slack_min, 1) };
  }
  switch (failingMedian(w, margin)) {
    case "slack_median":
      return { clause: "slack_median", value: worstQuarter(w, (q) => q.slack_median_min, 1) };
    case "extremum_timing":
      return {
        clause: "extremum_timing",
        value: worstQuarter(w, (q) => q.extremum_median_min, 1),
      };
    case "peak_speed":
      return { clause: "peak_speed", value: worstQuarter(w, (q) => q.speed_median_kn, 2) };
    default:
      return null;
  }
}
