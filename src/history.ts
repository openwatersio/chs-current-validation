// The committed history: one pair of files per grid point under
// history/<stamp>/scorer-<version>/, so rows from different recipes or
// scoring rules can never pool.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseJsonl, toJsonl, type GateRecord, type ResultRow } from "./rows.ts";

export interface HistoryKey {
  stamp: string;
  scorer: number;
}

export interface GridPoint {
  grid: number;
  /** YYYY-MM-DD. */
  fitEnd: string;
  rows: ResultRow[];
  gates: GateRecord[];
}

export interface HistoryState {
  /** Gates to re-score over the newest grid points before their next disposition. */
  needs_backfill: string[];
}

const ROWS_FILE = /^grid-\d{4}-\d{2}-\d{2}\.rows\.jsonl$/;

export function historyDir(root: string, key: HistoryKey): string {
  return join(root, "history", key.stamp, `scorer-${key.scorer}`);
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** A JSON file's contents, or undefined when there is no file. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * The committed grid points, oldest first. Throws on a row from another stamp
 * or scorer version, a file holding other than one grid point, or a gap.
 */
export async function readHistory(root: string, key: HistoryKey): Promise<GridPoint[]> {
  const dir = historyDir(root, key);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const points: GridPoint[] = [];
  for (const name of names.filter((n) => ROWS_FILE.test(n)).sort()) {
    const fitEnd = name.slice("grid-".length, "grid-".length + 10);
    const rows = parseJsonl<ResultRow>(await readFile(join(dir, name), "utf8"));
    const gates = parseJsonl<GateRecord>(
      await readFile(join(dir, `grid-${fitEnd}.gates.jsonl`), "utf8"),
    );
    const grids = [...new Set(rows.map((r) => r.grid))];
    if (grids.length !== 1) throw new Error(`${name} holds ${grids.length} grid points`);
    const stray = rows.find((r) => r.stamp !== key.stamp || r.scorer !== key.scorer);
    if (stray) {
      throw new Error(
        `${name} holds a row for ${stray.gate} from stamp ${stray.stamp}, scorer ${stray.scorer}`,
      );
    }
    points.push({ grid: grids[0], fitEnd, rows, gates });
  }
  for (let k = 1; k < points.length; k++) {
    if (points[k].grid !== points[k - 1].grid + 1) {
      throw new Error(
        `the history skips from grid point ${points[k - 1].grid} to ${points[k].grid}`,
      );
    }
  }
  return points;
}

const byGate = (a: { gate: string }, b: { gate: string }) => a.gate.localeCompare(b.gate);

/** Writes one grid point, sorted so a re-run that changes nothing leaves the files byte-identical. */
export async function writeGridPoint(
  root: string,
  key: HistoryKey,
  point: GridPoint,
): Promise<void> {
  const dir = historyDir(root, key);
  await mkdir(dir, { recursive: true });
  const rows = [...point.rows].sort(
    (a, b) => byGate(a, b) || a.fit_days - b.fit_days || a.offset_days - b.offset_days,
  );
  await writeFile(join(dir, `grid-${point.fitEnd}.rows.jsonl`), toJsonl(rows));
  await writeFile(
    join(dir, `grid-${point.fitEnd}.gates.jsonl`),
    toJsonl([...point.gates].sort(byGate)),
  );
}

export async function readState(root: string, key: HistoryKey): Promise<HistoryState> {
  const path = join(historyDir(root, key), "state.json");
  return (await readJson<HistoryState>(path)) ?? { needs_backfill: [] };
}

export async function writeState(
  root: string,
  key: HistoryKey,
  state: HistoryState,
): Promise<void> {
  await writeJson(join(historyDir(root, key), "state.json"), state);
}
