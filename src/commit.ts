// Decides which newly scored grid points enter the history, and what changed
// under each gate since the last one. A grid point commits only when every
// gate has rows or a recorded reason, some gate scored every recipe window and
// held-out week, and CHS has published events through its last held-out week.
import { RECIPE_WINDOWS } from "./derive.ts";
import type { GridPoint } from "./history.ts";
import type { GateRecord, ResultRow } from "./rows.ts";

export interface ScoredPoint {
  grid: number;
  rows: ResultRow[];
  gates: GateRecord[];
}

/** Each gate a run was given, with the windows it was scored at, and the held-out ages. */
export interface Expectation {
  gates: ReadonlyMap<string, readonly number[]>;
  offsets: readonly number[];
}

export interface StationChange {
  gate: string;
  kind: "station" | "axis" | "revision";
  from: string;
  to: string;
}

/** A gate record as it applies to one grid point: its failures there, and nothing about the others. */
export function recordAt(record: GateRecord, grid: number): GateRecord {
  const { failures, ...rest } = record;
  const here = (failures ?? []).filter((f) => f.grid === grid);
  return here.length ? { ...rest, failures: here } : rest;
}

/** Groups a run's rows and gate records by grid point. */
export function byGridPoint(
  rows: readonly ResultRow[],
  records: readonly GateRecord[],
  grids: readonly number[],
): ScoredPoint[] {
  return grids.map((grid) => ({
    grid,
    rows: rows.filter((r) => r.grid === grid),
    gates: records.map((r) => recordAt(r, grid)),
  }));
}

/** Throws when a run breaks the engine's contract: a gate with neither rows nor a reason for some window and held-out week. */
export function checkComplete(point: ScoredPoint, expected: Expectation): void {
  const records = new Map(point.gates.map((g) => [g.gate, g]));
  for (const [gate, windows] of expected.gates) {
    const record = records.get(gate);
    if (!record) throw new Error(`grid ${point.grid}: no gate record for ${gate}`);
    if (record.reason) continue;
    const failures = record.failures ?? [];
    if (failures.some((f) => f.fit_days === undefined)) continue;
    for (const days of windows) {
      if (failures.some((f) => f.fit_days === days)) continue;
      for (const offset of expected.offsets) {
        const found = point.rows.some(
          (r) => r.gate === gate && r.fit_days === days && r.offset_days === offset,
        );
        if (!found) {
          throw new Error(
            `grid ${point.grid}: ${gate} has no ${days}-day row at +${offset} d and no reason`,
          );
        }
      }
    }
  }
  const stray = point.rows.find((r) => !expected.gates.has(r.gate));
  if (stray) {
    throw new Error(`grid ${point.grid}: rows for ${stray.gate}, which the run was not given`);
  }
}

/**
 * Why a complete grid point cannot commit yet, or null when it can. Every
 * recipe window and held-out week needs at least one gate that scored it, or a
 * gate at the newest horizon beyond it, which the horizon check reports; the
 * 365-day window is report-only, so its failures never hold a grid point back.
 */
export function notScorable(point: ScoredPoint, expected: Expectation): string | null {
  const newest = point.gates
    .map((g) => g.horizon)
    .filter((h): h is string => h !== undefined)
    .sort()
    .at(-1);
  // A gate whose own horizon lags the rest records its weeks as beyond the
  // horizon, and that is its reason; the grid point waits only for CHS to
  // publish through the newest horizon.
  const current = new Set(point.gates.filter((g) => g.horizon === newest).map((g) => g.gate));
  const owed = new Set([...expected.gates.values()].flat());
  for (const days of RECIPE_WINDOWS.filter((d) => owed.has(d))) {
    for (const offset of expected.offsets) {
      const group = point.rows.filter((r) => r.fit_days === days && r.offset_days === offset);
      // Skip a week one of whose rows is a current gate's beyond the horizon:
      // the horizon check below reports it. A lagging gate's beyond-horizon row
      // is that gate's own reason, so it cannot stand in for a scored week.
      if (group.some((r) => current.has(r.gate) && r.status === "beyond_horizon")) continue;
      if (!group.some((r) => r.status === "scored")) {
        return `no gate scored the ${days}-day +${offset} d week`;
      }
    }
  }
  const beyond = point.rows.find((r) => current.has(r.gate) && r.status === "beyond_horizon");
  return beyond
    ? `CHS has not published events through ${beyond.gate}'s +${beyond.offset_days} d week`
    : null;
}

/** The leading run of grid points that commit, oldest first, and why the next one didn't, so the history never skips one. */
export function committable(
  points: readonly ScoredPoint[],
  expected: Expectation,
): { commit: ScoredPoint[]; stopped?: { grid: number; reason: string } } {
  const commit: ScoredPoint[] = [];
  for (const point of [...points].sort((a, b) => a.grid - b.grid)) {
    checkComplete(point, expected);
    const reason = notScorable(point, expected);
    if (reason) return { commit, stopped: { grid: point.grid, reason } };
    commit.push(point);
  }
  return { commit };
}

/** What changed under each gate since its last committed record: its IWLS station, its flood axis, or CHS's predictions. */
export function stationChanges(
  previous: ReadonlyMap<string, GateRecord>,
  current: readonly GateRecord[],
): StationChange[] {
  const out: StationChange[] = [];
  for (const now of current) {
    const before = previous.get(now.gate);
    if (!before || now.reason) continue;
    if (before.iwls && now.iwls && before.iwls !== now.iwls) {
      out.push({ gate: now.gate, kind: "station", from: before.iwls, to: now.iwls });
    } else if (
      before.flood !== undefined &&
      now.flood !== undefined &&
      before.flood !== now.flood
    ) {
      out.push({ gate: now.gate, kind: "axis", from: String(before.flood), to: String(now.flood) });
    }
    if (before.canary && now.canary && before.canary !== now.canary) {
      out.push({ gate: now.gate, kind: "revision", from: before.canary, to: now.canary });
    }
  }
  return out;
}

/** Each gate's newest committed record that names a station. */
export function latestRecords(points: readonly { gates: GateRecord[] }[]): Map<string, GateRecord> {
  const out = new Map<string, GateRecord>();
  for (const p of points) for (const g of p.gates) if (!g.reason && g.iwls) out.set(g.gate, g);
  return out;
}

/** Gates in a run that resolved to the same IWLS station; one of them sits at the wrong position. */
export function sharedStations(records: readonly GateRecord[]): string[] {
  const byCode = new Map<string, string[]>();
  for (const r of records) {
    if (r.iwls && !r.reason) byCode.set(r.iwls, [...(byCode.get(r.iwls) ?? []), r.gate]);
  }
  return [...byCode.values()]
    .filter((g) => g.length > 1)
    .flat()
    .sort();
}

/** A committed grid point with a backfill's rows and records in place of each re-scored gate's. */
export function replaceGates(
  point: GridPoint,
  scored: ScoredPoint,
  gates: ReadonlySet<string>,
): GridPoint {
  return {
    ...point,
    rows: [
      ...point.rows.filter((r) => !gates.has(r.gate)),
      ...scored.rows.filter((r) => gates.has(r.gate)),
    ],
    gates: [
      ...point.gates.filter((g) => !gates.has(g.gate)),
      ...scored.gates.filter((g) => gates.has(g.gate)),
    ],
  };
}
