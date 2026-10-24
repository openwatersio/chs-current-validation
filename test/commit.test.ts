import { describe, expect, test } from "vitest";
import {
  byGridPoint,
  checkComplete,
  committable,
  latestRecords,
  notScorable,
  recordAt,
  replaceGates,
  sharedStations,
  stationChanges,
  type ScoredPoint,
} from "../src/commit.ts";
import type { ResultRow } from "../src/rows.ts";
import { record, row } from "./builders.ts";

const OFFSETS = [0, 28, 90, 180, 270];
/** Every row a gate owes one grid point. */
function full(
  gate: string,
  grid: number,
  windows = [60, 210],
  overrides: Partial<ResultRow> = {},
): ResultRow[] {
  return windows.flatMap((fit_days) =>
    OFFSETS.map((offset_days) => row({ gate, grid, fit_days, offset_days, ...overrides })),
  );
}
const owed = (gates: string[], windows = [60, 210]) => ({
  gates: new Map(gates.map((g) => [g, windows])),
  offsets: OFFSETS,
});

describe("recordAt and byGridPoint", () => {
  test("keeps only the failures at that grid point", () => {
    const r = record({
      failures: [
        { grid: -1, reason: "a" },
        { grid: 0, fit_days: 365, reason: "b" },
      ],
    });
    expect(recordAt(r, 0).failures).toEqual([{ grid: 0, fit_days: 365, reason: "b" }]);
    expect("failures" in recordAt(r, 1)).toBe(false);
  });

  test("splits a run's rows by grid point and gives each its records", () => {
    const points = byGridPoint([...full("a", 0), ...full("a", 1)], [record({ gate: "a" })], [0, 1]);
    expect(points.map((p) => [p.grid, p.rows.length, p.gates.length])).toEqual([
      [0, 10, 1],
      [1, 10, 1],
    ]);
  });
});

describe("checkComplete", () => {
  const point = (rows: ResultRow[], gates = [record({ gate: "a" })]): ScoredPoint => ({
    grid: 0,
    rows,
    gates,
  });

  test("accepts a gate with every window and held-out week", () => {
    expect(() => checkComplete(point(full("a", 0)), owed(["a"]))).not.toThrow();
  });

  test("accepts a reason, a whole-grid failure or a window failure in place of rows", () => {
    expect(() =>
      checkComplete(point([], [record({ gate: "a", reason: "no IWLS station" })]), owed(["a"])),
    ).not.toThrow();
    expect(() =>
      checkComplete(
        point([], [record({ gate: "a", failures: [{ grid: 0, reason: "refused" }] })]),
        owed(["a"]),
      ),
    ).not.toThrow();
    expect(() =>
      checkComplete(
        point(full("a", 0, [210]), [
          record({ gate: "a", failures: [{ grid: 0, fit_days: 60, reason: "rank deficient" }] }),
        ]),
        owed(["a"]),
      ),
    ).not.toThrow();
  });

  test("throws when a gate lacks a row with no reason, a record, or was never asked for", () => {
    const rows = full("a", 0).filter((r) => !(r.fit_days === 60 && r.offset_days === 28));
    expect(() => checkComplete(point(rows), owed(["a"]))).toThrow(/no 60-day row at \+28 d/);
    expect(() => checkComplete(point(full("a", 0)), owed(["a", "b"]))).toThrow(
      /no gate record for b/,
    );
    expect(() => checkComplete(point([...full("a", 0), ...full("c", 0)]), owed(["a"]))).toThrow(
      /which the run was not given/,
    );
  });
});

describe("notScorable and committable", () => {
  test("waits when no gate scored a week", () => {
    const rows = full("a", 0, [60, 210], { status: "no_events" });
    expect(notScorable({ grid: 0, rows, gates: [record({ gate: "a" })] }, owed(["a"]))).toBe(
      "no gate scored the 60-day +0 d week",
    );
  });

  test("waits when every gate failed a recipe window", () => {
    const failed = { failures: [{ grid: 0, fit_days: 60, reason: "refused" }] };
    const point = {
      grid: 0,
      rows: [...full("a", 0, [210]), ...full("b", 0, [210])],
      gates: [record({ gate: "a", ...failed }), record({ gate: "b", ...failed })],
    };
    expect(() => checkComplete(point, owed(["a", "b"]))).not.toThrow();
    expect(notScorable(point, owed(["a", "b"]))).toBe("no gate scored the 60-day +0 d week");
  });

  test("never waits on the report-only window", () => {
    const point = {
      grid: 0,
      rows: full("a", 0, [60, 210]),
      gates: [
        record({ gate: "a", failures: [{ grid: 0, fit_days: 365, reason: "rank deficient" }] }),
      ],
    };
    expect(notScorable(point, owed(["a"], [60, 210, 365]))).toBeNull();
  });

  test("waits for CHS to publish through the last held-out week", () => {
    const rows = [
      ...full("a", 0),
      ...full("b", 0).map((r) =>
        r.offset_days === 270 ? { ...r, status: "beyond_horizon" as const } : r,
      ),
    ];
    const gates = [record({ gate: "a" }), record({ gate: "b" })];
    expect(notScorable({ grid: 0, rows, gates }, owed(["a", "b"]))).toMatch(/b's \+270 d week/);
  });

  test("lets a gate whose own horizon lags record it as its reason", () => {
    const rows = [
      ...full("a", 0),
      ...full("b", 0).map((r) =>
        r.offset_days === 270 ? { ...r, status: "beyond_horizon" as const } : r,
      ),
    ];
    const gates = [record({ gate: "a" }), record({ gate: "b", horizon: "2027-01-01T00:00:00Z" })];
    expect(notScorable({ grid: 0, rows, gates }, owed(["a", "b"]))).toBeNull();
  });

  test("commits only the leading run of scorable grid points", () => {
    const points: ScoredPoint[] = [0, 1, 2].map((grid) => ({
      grid,
      rows: full("a", grid, [60, 210], grid === 1 ? { status: "no_events" } : {}),
      gates: [record({ gate: "a" })],
    }));
    const { commit, stopped } = committable(points, owed(["a"]));
    expect(commit.map((p) => p.grid)).toEqual([0]);
    expect(stopped).toEqual({ grid: 1, reason: "no gate scored the 60-day +0 d week" });
  });
});

describe("stationChanges, latestRecords and sharedStations", () => {
  const before = new Map([["a", record({ gate: "a" })]]);

  test("sees a new IWLS station, a new flood axis and a CHS revision", () => {
    expect(stationChanges(before, [record({ gate: "a", iwls: "07528" })])).toEqual([
      { gate: "a", kind: "station", from: "07527", to: "07528" },
    ]);
    expect(stationChanges(before, [record({ gate: "a", flood: 50 })])).toEqual([
      { gate: "a", kind: "axis", from: "45", to: "50" },
    ]);
    expect(stationChanges(before, [record({ gate: "a", canary: "000000000000" })])).toEqual([
      { gate: "a", kind: "revision", from: "6d055872a12d", to: "000000000000" },
    ]);
  });

  test("ignores gates with a reason, gates it has not seen, and a missing canary", () => {
    expect(stationChanges(before, [record({ gate: "a", reason: "x", iwls: "1" })])).toEqual([]);
    expect(stationChanges(before, [record({ gate: "z", iwls: "1" })])).toEqual([]);
    expect(stationChanges(before, [record({ gate: "a", canary: undefined })])).toEqual([]);
  });

  test("takes each gate's newest record that names a station", () => {
    const latest = latestRecords([
      { gates: [record({ gate: "a", iwls: "1" })] },
      { gates: [record({ gate: "a", iwls: "2" }), record({ gate: "b", reason: "none" })] },
    ]);
    expect(latest.get("a")?.iwls).toBe("2");
    expect(latest.has("b")).toBe(false);
  });

  test("names every gate that shares an IWLS station with another", () => {
    expect(
      sharedStations([
        record({ gate: "b", iwls: "1" }),
        record({ gate: "a", iwls: "1" }),
        record({ gate: "c", iwls: "2" }),
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("replaceGates", () => {
  test("swaps in a backfill's rows and records for the re-scored gates only", () => {
    const point = {
      grid: 0,
      fitEnd: "2026-10-29",
      rows: [...full("a", 0), ...full("b", 0)],
      gates: [record({ gate: "a" }), record({ gate: "b" })],
    };
    const scored = {
      grid: 0,
      rows: full("b", 0, [60, 210, 365], { iwls: "07999" }),
      gates: [record({ gate: "b", iwls: "07999" })],
    };
    const out = replaceGates(point, scored, new Set(["b"]));
    expect(out.rows.filter((r) => r.gate === "a")).toHaveLength(10);
    expect(out.rows.filter((r) => r.gate === "b").every((r) => r.iwls === "07999")).toBe(true);
    expect(out.rows.filter((r) => r.gate === "b")).toHaveLength(15);
    expect(out.gates.find((g) => g.gate === "b")?.iwls).toBe("07999");
  });
});
