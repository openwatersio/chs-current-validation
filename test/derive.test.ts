import { describe, expect, test } from "vitest";
import {
  NO_MARGIN,
  PROMOTION_MARGIN,
  disqualifier,
  evaluateWindow,
  failingMedian,
  median,
  missOf,
  quarterOf,
  roundUpTo5,
  windowVerdict,
} from "../src/derive.ts";
import type { ResultRow } from "../src/rows.ts";
import { weekOn, year } from "./builders.ts";

const w210 = (byMonth: Record<number, Partial<ResultRow>> = {}) =>
  evaluateWindow(210, year({}, byMonth));
const q1 = (o: Partial<ResultRow>) => ({ 0: o, 1: o, 2: o });
const q2 = (o: Partial<ResultRow>) => ({ 3: o, 4: o, 5: o });

describe("evaluateWindow", () => {
  test("pools matched slacks, extrema and speeds by the quarter each week starts in", () => {
    const w = evaluateWindow(210, [
      weekOn("2026-01-10", { slack_errors: [1, 3], extremum_errors: [4], speed_errors: [0.25] }),
      weekOn("2026-03-31", { slack_errors: [5], extremum_errors: [6], speed_errors: [0.75] }),
      weekOn("2026-04-01", { slack_errors: [7] }),
      weekOn("2026-04-01", { fit_days: 60, slack_errors: [99] }),
      weekOn("2026-07-01", { status: "no_events", slack_errors: undefined }),
    ]);
    expect(w.weeks).toBe(3);
    expect(w.quarters[0]).toEqual({
      quarter: 1,
      weeks: 2,
      slacks: 3,
      extrema: 2,
      slack_median_min: 3,
      extremum_median_min: 5,
      speed_median_kn: 0.5,
    });
    expect(w.quarters[1]).toMatchObject({ weeks: 1, slack_median_min: 7 });
    expect(w.quarters[2]).toMatchObject({ weeks: 0, slack_median_min: null });
    expect(w.worst_slack_min).toBe(7);
  });

  test("counts missed and invented slacks, and keeps the worst week's wrong-sign share", () => {
    const w = evaluateWindow(210, [
      weekOn("2026-02-01", { slack_errors: [2, null], invented: 1, extrema: 5, wrong_sign: 2 }),
      weekOn("2026-05-01", { extrema: 4, wrong_sign: 3 }),
      weekOn("2026-08-01", { extrema: 0, wrong_sign: 0 }),
    ]);
    expect(w).toMatchObject({ missed: 1, invented: 1, wrong_sign_share: 0.75, worst_slack_min: 5 });
  });

  test("has no worst slack and empty quarters when nothing scored", () => {
    const w = evaluateWindow(210, [
      weekOn("2026-02-01", { status: "beyond_horizon", slack_errors: undefined }),
    ]);
    expect(w).toMatchObject({ weeks: 0, worst_slack_min: null });
    expect(w.quarters.every((q) => q.slack_median_min === null)).toBe(true);
  });
});

describe("quarterOf and median", () => {
  test("puts a week in the quarter its start date falls in", () => {
    expect(quarterOf("2026-03-31T07:00:00Z")).toBe(1);
    expect(quarterOf("2026-04-01T07:00:00Z")).toBe(2);
    expect(quarterOf("2026-12-31T08:00:00Z")).toBe(4);
  });

  test("takes the middle value, or the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("roundUpTo5", () => {
  test("rounds a worst slack up to the next 5 minutes, never below 5", () => {
    expect(roundUpTo5(30.1)).toBe(35);
    expect(roundUpTo5(35)).toBe(35);
    expect(roundUpTo5(35.000000000001)).toBe(35);
    expect(roundUpTo5(44)).toBe(45);
    expect(roundUpTo5(45.1)).toBe(50);
    expect(roundUpTo5(0)).toBe(5);
  });
});

describe("windowVerdict", () => {
  test("is final with a worst slack of exactly 30 minutes", () => {
    expect(windowVerdict(w210({ 6: { slack_errors: [5, 30] } }))).toEqual({ tier: "final" });
  });

  test("quotes a bound, rounded up to 5 minutes, past 30 minutes", () => {
    expect(windowVerdict(w210({ 6: { slack_errors: [5, 30.1] } }))).toEqual({
      tier: "bounded",
      bound: 35,
    });
    expect(windowVerdict(w210({ 6: { slack_errors: [5, 45] } }))).toEqual({
      tier: "bounded",
      bound: 45,
    });
  });

  test("is online past 45 minutes", () => {
    expect(windowVerdict(w210({ 6: { slack_errors: [5, 45.1] } }))).toEqual({ tier: "online" });
  });

  test("holds each median clause in every quarter, at the bar inclusive", () => {
    expect(windowVerdict(w210(q1({ slack_errors: [15, 15, 15] })))).toEqual({ tier: "final" });
    expect(windowVerdict(w210(q1({ slack_errors: [15.1, 15.1, 15.1] })))).toEqual({
      tier: "online",
    });
    expect(windowVerdict(w210(q1({ extremum_errors: [20] })))).toEqual({ tier: "final" });
    expect(windowVerdict(w210(q1({ extremum_errors: [20.1] })))).toEqual({ tier: "online" });
    expect(windowVerdict(w210(q1({ speed_errors: [0.5] })))).toEqual({ tier: "final" });
    expect(windowVerdict(w210(q1({ speed_errors: [0.51] })))).toEqual({ tier: "online" });
  });

  test("fails a quarter with nothing to measure", () => {
    const rows = year().filter((r) => quarterOf(r.week_start) !== 2);
    expect(windowVerdict(evaluateWindow(210, rows))).toEqual({ tier: "online" });
  });

  test("is online with any disqualifier", () => {
    expect(windowVerdict(w210({ 3: { slack_errors: [5, null] } }))).toEqual({ tier: "online" });
    expect(windowVerdict(w210({ 3: { invented: 1 } }))).toEqual({ tier: "online" });
    expect(windowVerdict(w210({ 3: { extrema: 5, wrong_sign: 3 } }))).toEqual({ tier: "online" });
    expect(windowVerdict(w210({ 3: { extrema: 5, wrong_sign: 2 } }))).toEqual({ tier: "final" });
  });
});

describe("disqualifier and failingMedian", () => {
  test("names a reversed axis before an invented slack, and an invented slack before a missed one", () => {
    expect(
      disqualifier(w210({ 1: { extrema: 5, wrong_sign: 3, invented: 1, slack_errors: [null] } })),
    ).toBe("reversed_axis");
    expect(disqualifier(w210({ 1: { invented: 1, slack_errors: [null] } }))).toBe("invented_slack");
    expect(disqualifier(w210({ 1: { slack_errors: [null] } }))).toBe("missed_slack");
    expect(disqualifier(w210())).toBeNull();
  });

  test("tightens each median by the promotion margin without float noise", () => {
    expect(failingMedian(w210(q1({ slack_errors: [14, 14, 14] })), PROMOTION_MARGIN)).toBeNull();
    expect(failingMedian(w210(q1({ slack_errors: [14.1, 14.1, 14.1] })), PROMOTION_MARGIN)).toBe(
      "slack_median",
    );
    expect(failingMedian(w210(q1({ speed_errors: [0.45] })), PROMOTION_MARGIN)).toBeNull();
    expect(failingMedian(w210(q1({ speed_errors: [0.46] })), PROMOTION_MARGIN)).toBe("peak_speed");
    // The median of 0.34 and 0.56 is 0.45000000000000007: over the 0.45 kn bar by float noise only.
    expect(median([0.34, 0.56])).toBeGreaterThan(0.45);
    expect(failingMedian(w210(q1({ speed_errors: [0.34, 0.56] })), PROMOTION_MARGIN)).toBeNull();
    expect(failingMedian(w210(q1({ extremum_errors: [19.1] })), PROMOTION_MARGIN)).toBe(
      "extremum_timing",
    );
    expect(failingMedian(w210(q1({ extremum_errors: [19.1] })), NO_MARGIN)).toBeNull();
  });
});

describe("missOf", () => {
  test("names the first failing clause with its value", () => {
    expect(missOf(w210({ 1: { extrema: 5, wrong_sign: 3, invented: 2 } }))).toEqual({
      clause: "reversed_axis",
      value: 60,
    });
    expect(missOf(w210({ 1: { invented: 1 }, 4: { invented: 1 } }))).toEqual({
      clause: "invented_slack",
      value: 2,
    });
    expect(missOf(w210({ 1: { slack_errors: [null, null, 5] } }))).toEqual({
      clause: "missed_slack",
      value: 2,
    });
    expect(missOf(w210({ 6: { slack_errors: [5, 50] } }))).toEqual({
      clause: "slack_worst",
      value: 50,
    });
  });

  test("reports a worst slack only above 45 minutes, and the worst quarter's median otherwise", () => {
    const miss = missOf(
      w210({
        ...q1({ slack_errors: [16, 16, 16] }),
        6: { slack_errors: [18, 18, 40] },
        7: { slack_errors: [18, 18, 18] },
        8: { slack_errors: [18, 18, 18] },
      }),
    );
    expect(miss).toEqual({ clause: "slack_median", value: 18 });
  });

  test("names the extremum and speed clauses after the slack ones", () => {
    expect(missOf(w210(q2({ extremum_errors: [25] })))).toEqual({
      clause: "extremum_timing",
      value: 25,
    });
    expect(missOf(w210(q2({ speed_errors: [0.6] })))).toEqual({ clause: "peak_speed", value: 0.6 });
  });

  test("rounds a median up to its unit", () => {
    const quarter = {
      0: { slack_errors: [18.2] },
      1: { slack_errors: [18.3] },
      2: { slack_errors: [18.2, 18.3] },
    };
    expect(missOf(w210(quarter))).toEqual({ clause: "slack_median", value: 18.3 });
  });

  test("has no value for a quarter with nothing to measure", () => {
    const rows = year().filter((r) => quarterOf(r.week_start) !== 2);
    expect(missOf(evaluateWindow(210, rows))).toEqual({ clause: "slack_median", value: null });
  });

  test("finds nothing for a window that meets the bounded tier, unless tightened by the margin", () => {
    const w = w210({ 6: { slack_errors: [5, 44.5] } });
    expect(missOf(w)).toBeNull();
    expect(missOf(w, PROMOTION_MARGIN)).toEqual({ clause: "slack_worst", value: 44.5 });
  });
});
