// Plans one results run per target: which grid points to score, which gates
// to re-score over the newest history, and how to split the work into shards
// that each finish inside a GitHub Actions job.
export interface Target {
  stamp: string;
  /** A full openwatersio/slackwater commit whose engine produces `stamp`. */
  engine: string;
}

export interface GateInput {
  id: string;
  latitude: number;
  longitude: number;
}

/** The part of the engine's chs-current-grid.ts planning needs. */
export interface Grid {
  gridIndexOnOrBefore(date: string): number;
}

export interface Shard {
  id: string;
  gates: GateInput[];
  /** The engine's GRID, a..b. */
  grid: string;
  /** The engine's WINDOWS. */
  windows: string;
}

export interface TargetPlan {
  stamp: string;
  engine: string;
  scorer: number;
  offsets: number[];
  mode: "seed" | "monthly";
  /** New grid points, oldest first. */
  candidates: number[];
  /** Gates re-scored over `backfillGrid` in place of their committed rows. */
  backfill: string[];
  backfillGrid: number[];
  shards: Shard[];
}

/** A seed scores a year of fit ends plus one, so the stability rule has two consecutive grid points from the start. */
export const SEED_GRID_POINTS = 14;
/**
 * Six gates make a seed shard of roughly 1.3 hours at the engine's pace, well
 * inside a 6-hour job. More gates mean more shards, never bigger ones: shards
 * run one at a time, so their count doesn't change IWLS's load.
 */
export const GATES_PER_SHARD = 6;
/** The windows a seed or a backfill scores: the recipe's, and the report-only 365 days. */
export const FULL_WINDOWS: readonly number[] = [60, 210, 365];
/** The windows a monthly run scores. */
export const MONTHLY_WINDOWS: readonly number[] = [60, 210];

export function range(a: number, b: number): number[] {
  return a > b ? [] : Array.from({ length: b - a + 1 }, (_, k) => a + k);
}

/** Splits gates, in id order, round robin into the fewest shards of at most GATES_PER_SHARD. */
export function shardGates(gates: readonly GateInput[]): GateInput[][] {
  const sorted = [...gates].sort((a, b) => a.id.localeCompare(b.id));
  const count = Math.ceil(sorted.length / GATES_PER_SHARD);
  const shards: GateInput[][] = Array.from({ length: count }, () => []);
  sorted.forEach((gate, k) => shards[k % count].push(gate));
  return shards;
}

interface DatabaseStation {
  id: string;
  kind: string;
  latitude: number;
  longitude: number;
  source: { name: string };
  current?: { derived?: unknown };
}

/** The curated CHS current gates the benchmark fits: every one in the database except those whose slack derives from a tide port. */
export function fittedGates(stations: readonly DatabaseStation[]): GateInput[] {
  return stations
    .filter(
      (s) =>
        s.kind === "current" &&
        s.source.name === "Canadian Hydrographic Service" &&
        !s.current?.derived,
    )
    .map((s) => ({ id: s.id, latitude: s.latitude, longitude: s.longitude }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The gates a dispatch's `backfill` input names, or "all". Throws on a misspelt id, which planTarget would drop without a word. */
export function requestedBackfill(input: string, fitted: readonly GateInput[]): string[] | "all" {
  if (input.trim() === "all") return "all";
  const ids = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(fitted.map((g) => g.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(
      `the backfill input names ${unknown.join(", ")}, which aren't fitted CHS current gates`,
    );
  }
  return ids;
}

export function planTarget(input: {
  target: Target;
  scorer: number;
  offsets: number[];
  /** Committed grid indices, oldest first. */
  committed: readonly number[];
  /** Gates with a record at the newest committed grid point. */
  known: ReadonlySet<string>;
  gates: readonly GateInput[];
  /** Gates flagged or requested for a backfill, or every gate. */
  backfill: readonly string[] | "all";
  today: string;
  grid: Grid;
}): TargetPlan {
  const newest = input.grid.gridIndexOnOrBefore(input.today);
  const base = {
    stamp: input.target.stamp,
    engine: input.target.engine,
    scorer: input.scorer,
    offsets: input.offsets,
  };
  const shard = (
    gates: readonly GateInput[],
    grids: number[],
    windows: readonly number[],
    prefix: string,
  ) =>
    shardGates(gates).map((g, k) => ({
      id: `${prefix}${k + 1}`,
      gates: g,
      grid: `${grids[0]}..${grids.at(-1)}`,
      windows: windows.join(","),
    }));

  if (input.committed.length === 0) {
    const candidates = range(newest - SEED_GRID_POINTS + 1, newest);
    return {
      ...base,
      mode: "seed",
      candidates,
      backfill: [],
      backfillGrid: [],
      shards: shard(input.gates, candidates, FULL_WINDOWS, "seed-"),
    };
  }

  const first = input.committed[0];
  const last = input.committed[input.committed.length - 1];
  const candidates = range(last + 1, newest);
  const ids = input.gates.map((g) => g.id);
  const wanted =
    input.backfill === "all"
      ? ids
      : [...input.backfill, ...ids.filter((id) => !input.known.has(id))];
  const backfill = [...new Set(wanted)].filter((id) => ids.includes(id)).sort();
  // The 14 newest committed points as well as the new ones: if CHS has not published far enough
  // for the new points to commit, only last-13..last stay, and old-station rows must not remain.
  const backfillGrid = backfill.length
    ? range(Math.max(first, last - SEED_GRID_POINTS + 1), Math.max(last, newest))
    : [];
  const monthly = input.gates.filter((g) => !backfill.includes(g.id));
  const shards = [
    ...(candidates.length && monthly.length
      ? shard(monthly, candidates, MONTHLY_WINDOWS, "monthly-")
      : []),
    ...(backfill.length
      ? shard(
          input.gates.filter((g) => backfill.includes(g.id)),
          backfillGrid,
          FULL_WINDOWS,
          "backfill-",
        )
      : []),
  ];
  return { ...base, mode: "monthly", candidates, backfill, backfillGrid, shards };
}
