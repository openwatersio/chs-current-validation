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

// Typed as records so a field added to or removed from an interface fails the typecheck until it is listed here.
const ROW_FIELDS: Record<keyof ResultRow, true> = {
  gate: true,
  iwls: true,
  flood: true,
  stamp: true,
  scorer: true,
  grid: true,
  fit_end: true,
  fit_days: true,
  fit_start: true,
  fit_samples: true,
  fit_rms_kn: true,
  offset_days: true,
  week_start: true,
  status: true,
  slack_errors: true,
  invented: true,
  extremum_errors: true,
  speed_errors: true,
  extrema: true,
  wrong_sign: true,
};
const RECORD_FIELDS: Record<keyof GateRecord, true> = {
  gate: true,
  iwls: true,
  flood: true,
  ebb: true,
  time_zone: true,
  horizon: true,
  canary: true,
  reason: true,
  failures: true,
};
const FAILURE_FIELDS: Record<keyof GateFailure, true> = {
  grid: true,
  fit_days: true,
  reason: true,
};

/** `item` with only the keys in `fields`, in its own order; each other key's name goes into `dropped`. */
function keep<T>(item: object, fields: object, dropped: Set<string>, prefix: string): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (Object.hasOwn(fields, key)) out[key] = value;
    else dropped.add(`${prefix}.${key}`);
  }
  return out as T;
}

/**
 * A run's rows and gate records with only the fields declared here, so
 * nothing else the engine emits, such as CHS times or samples, reaches the
 * history. `dropped` names each other field once, as `rows.<key>`,
 * `gates.<key>` or `gates.failures.<key>`.
 */
export function declaredOnly(
  rows: readonly object[],
  gates: readonly object[],
): { rows: ResultRow[]; gates: GateRecord[]; dropped: string[] } {
  const dropped = new Set<string>();
  return {
    rows: rows.map((r) => keep<ResultRow>(r, ROW_FIELDS, dropped, "rows")),
    gates: gates.map((g) => {
      const record = keep<GateRecord>(g, RECORD_FIELDS, dropped, "gates");
      if (!record.failures) return record;
      const failures = record.failures.map((f) =>
        keep<GateFailure>(f, FAILURE_FIELDS, dropped, "gates.failures"),
      );
      return { ...record, failures };
    }),
    dropped: [...dropped].sort(),
  };
}

/** The dropped fields whose names suggest CHS times or samples, which the history must never hold. */
export function suspectFields(dropped: readonly string[]): string[] {
  return dropped.filter((field) =>
    /time|date|sample|event/i.test(field.slice(field.lastIndexOf(".") + 1)),
  );
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
