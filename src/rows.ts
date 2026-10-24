// The engine benchmark's outputs as this repository reads them: rows and gate
// records from openwatersio/slackwater's benchmarks/chs-current-fit.ts, whose
// benchmarks/chs-current-score.ts defines them. Rows carry error magnitudes
// and the benchmark's own grid dates, never CHS timestamps or samples.
export type RowStatus = "scored" | "no_events" | "beyond_horizon";

export interface ResultRow {
  gate: string;
  iwls: string;
  flood: number;
  stamp: string;
  scorer: number;
  grid: number;
  fit_end: string;
  fit_days: number;
  fit_start: string;
  fit_samples: number;
  fit_rms_kn: number;
  offset_days: number;
  week_start: string;
  status: RowStatus;
  /** Each CHS slack's error in minutes, in CHS event order; null for a missed slack. */
  slack_errors?: (number | null)[];
  invented?: number;
  extremum_errors?: number[];
  speed_errors?: number[];
  extrema?: number;
  wrong_sign?: number;
}

export interface GateFailure {
  grid: number;
  /** Absent when the whole grid point failed. */
  fit_days?: number;
  reason: string;
}

export interface GateRecord {
  gate: string;
  iwls?: string;
  flood?: number;
  ebb?: number;
  time_zone?: string;
  /** The end of CHS's published events for the station. */
  horizon?: string;
  /** A hash of one fixed past week of CHS's speed predictions; a change means CHS revised them. */
  canary?: string;
  /** Why the gate has no rows at all. */
  reason?: string;
  failures?: GateFailure[];
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export function toJsonl(items: readonly object[]): string {
  return items.map((item) => JSON.stringify(item) + "\n").join("");
}
