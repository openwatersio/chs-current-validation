// Each gate's disposition at the newest committed grid point: its year of
// evidence there and one grid point earlier, the claim the stability rule
// lets it ship, and how that changed.
import {
  chsFit,
  measuredClaim,
  stabilize,
  type Change,
  type ChsFit,
  type Claim,
} from "./claims.ts";
import { POOLED_GRID_POINTS, RECIPE_WINDOWS, evaluateWindow, type Evaluation } from "./derive.ts";
import type { GridPoint } from "./history.ts";
import type { ResultRow } from "./rows.ts";

export interface GateDisposition {
  status: Change | "insufficient" | "pending_backfill";
  /** What the gate ships as: the stability rule's claim. */
  chs_fit?: ChsFit;
  /** What the newest year alone measures. */
  measured?: ChsFit;
  note?: string;
  /** The newest year's evidence, per window. */
  windows?: Evaluation;
}

/** One gate's rows over the year of grid points ending at `points[at]`, on the IWLS station and flood axis of its newest row there, so rows across a change never pool. */
export function pooledRows(points: readonly GridPoint[], at: number, gate: string): ResultRow[] {
  if (at < 0) return [];
  const rows = points
    .slice(Math.max(0, at - POOLED_GRID_POINTS + 1), at + 1)
    .flatMap((p) => p.rows.filter((r) => r.gate === gate));
  const key = rows.at(-1);
  return key ? rows.filter((r) => r.iwls === key.iwls && r.flood === key.flood) : [];
}

/** A gate's evidence for the year ending at `points[at]`, or undefined when it has no scored week there. */
export function evaluateGate(
  points: readonly GridPoint[],
  at: number,
  gate: string,
): Evaluation | undefined {
  const rows = pooledRows(points, at, gate);
  if (!rows.some((r) => r.status === "scored")) return undefined;
  const e: Evaluation = {};
  for (const days of RECIPE_WINDOWS) e[days] = evaluateWindow(days, rows);
  if (rows.some((r) => r.fit_days === 365)) e[365] = evaluateWindow(365, rows);
  return e;
}

export function disposeGate(input: {
  points: readonly GridPoint[];
  gate: string;
  baseline: Claim | undefined;
  pending: boolean;
  carried?: GateDisposition;
}): GateDisposition {
  const { points, gate } = input;
  if (input.pending) {
    return {
      status: "pending_backfill",
      ...(input.carried?.chs_fit ? { chs_fit: input.carried.chs_fit } : {}),
      note: "its IWLS station, flood axis or CHS's predictions changed, so it is being scored again",
    };
  }
  const newest = evaluateGate(points, points.length - 1, gate);
  if (!newest) return { status: "insufficient", note: "no scored week in the newest year" };
  const previous = evaluateGate(points, points.length - 2, gate);
  if (!previous) {
    return { status: "insufficient", note: "no scored week in the year one grid point earlier" };
  }
  const { claim, change } = stabilize({ curated: input.baseline, newest, previous });
  return {
    status: change,
    chs_fit: chsFit(claim, newest, previous),
    measured: chsFit(measuredClaim(newest), newest, previous),
    windows: newest,
  };
}
