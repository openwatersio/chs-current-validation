import type { GateRecord, ResultRow } from "../src/rows.ts";

export const STAMP = "8f85912ce223";
const DAY = 86_400_000;

/** A scored 210-day week at Active Pass with small errors; tests override what they measure. */
export function row(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    gate: "chs-active-pass",
    iwls: "07527",
    flood: 45,
    stamp: STAMP,
    scorer: 2,
    grid: 0,
    fit_end: "2026-10-29T07:00:00Z",
    fit_days: 210,
    fit_start: "2026-04-02T00:00:00Z",
    fit_samples: 20219,
    fit_rms_kn: 0.05,
    offset_days: 0,
    week_start: "2026-10-29T07:00:00Z",
    status: "scored",
    slack_errors: [5, 5, 5],
    invented: 0,
    extremum_errors: [10],
    speed_errors: [0.1],
    extrema: 4,
    wrong_sign: 0,
    ...overrides,
  };
}

export function record(overrides: Partial<GateRecord> = {}): GateRecord {
  return {
    gate: "chs-active-pass",
    iwls: "07527",
    flood: 45,
    ebb: 225,
    time_zone: "Canada/Pacific",
    horizon: "2028-01-01T00:00:00Z",
    canary: "6d055872a12d",
    ...overrides,
  };
}

/** A scored week starting on `date`, YYYY-MM-DD. */
export function weekOn(date: string, overrides: Partial<ResultRow> = {}): ResultRow {
  return row({ week_start: `${date}T07:00:00Z`, ...overrides });
}

const MID_MONTHS = Array.from(
  { length: 12 },
  (_, m) => `2026-${String(m + 1).padStart(2, "0")}-15`,
);

/** A year of passing weeks, one mid-month each month; `byMonth[m]` overrides month m (0 = January). */
export function year(
  overrides: Partial<ResultRow> = {},
  byMonth: Record<number, Partial<ResultRow>> = {},
): ResultRow[] {
  return MID_MONTHS.map((date, m) => weekOn(date, { ...overrides, ...byMonth[m] }));
}

/** The fit-end date tests give grid point i: a plain 28-day grid from the anchor. */
export function testFitEnd(i: number): string {
  return new Date(Date.parse("2026-10-29T00:00:00Z") + 28 * i * DAY).toISOString().slice(0, 10);
}
