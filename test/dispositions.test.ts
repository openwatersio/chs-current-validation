import { describe, expect, test } from "vitest";
import { disposeGate, evaluateGate, pooledRows } from "../src/dispositions.ts";
import type { GridPoint } from "../src/history.ts";
import { range } from "../src/plan.ts";
import type { ResultRow } from "../src/rows.ts";
import { record, testFitEnd, year } from "./builders.ts";

/** Grid points 0..n-1, each holding a year-shaped spread of good weeks at both windows. */
function points(n: number, rows: (grid: number) => ResultRow[] = goodRows): GridPoint[] {
  return range(0, n - 1).map((grid) => ({
    grid,
    fitEnd: testFitEnd(grid),
    rows: rows(grid),
    gates: [record()],
  }));
}
function goodRows(grid: number): ResultRow[] {
  return [...year({ grid, fit_days: 60 }), ...year({ grid })];
}

describe("pooledRows and evaluateGate", () => {
  test("pools the 13 grid points ending at the one asked for", () => {
    const grids = new Set(pooledRows(points(15), 14, "chs-active-pass").map((r) => r.grid));
    expect([...grids].sort((a, b) => a - b)).toEqual(range(2, 14));
  });

  test("pools only rows on the gate's newest IWLS station and flood axis", () => {
    const history = points(15, (grid) =>
      goodRows(grid).map((r) => (grid >= 13 ? { ...r, iwls: "07999" } : r)),
    );
    const grids = new Set(pooledRows(history, 14, "chs-active-pass").map((r) => r.grid));
    expect([...grids]).toEqual([13, 14]);
    const axis = points(15, (grid) =>
      goodRows(grid).map((r) => (grid === 14 ? { ...r, flood: 50 } : r)),
    );
    expect(new Set(pooledRows(axis, 14, "chs-active-pass").map((r) => r.grid))).toEqual(
      new Set([14]),
    );
  });

  test("has no evaluation without a scored week", () => {
    const empty = points(14, (grid) =>
      goodRows(grid).map((r) => ({ ...r, status: "no_events" as const })),
    );
    expect(evaluateGate(empty, 13, "chs-active-pass")).toBeUndefined();
  });

  test("evaluates the 365-day window only where it was scored", () => {
    const with365 = points(14, (grid) => [...goodRows(grid), ...year({ grid, fit_days: 365 })]);
    expect(Object.keys(evaluateGate(with365, 13, "chs-active-pass")!)).toEqual([
      "60",
      "210",
      "365",
    ]);
    expect(Object.keys(evaluateGate(points(14), 13, "chs-active-pass")!)).toEqual(["60", "210"]);
  });
});

describe("disposeGate", () => {
  test("curates a gate afresh from a good year", () => {
    const d = disposeGate({
      points: points(14),
      gate: "chs-active-pass",
      baseline: undefined,
      pending: false,
    });
    expect(d).toMatchObject({
      status: "fresh",
      chs_fit: { tier: "final", days: 60 },
      measured: { tier: "final", days: 60 },
    });
    expect(Object.keys(d.windows!)).toEqual(["60", "210"]);
  });

  test("holds a gate to its baseline and promotes it on two good grid points", () => {
    const d = disposeGate({
      points: points(14),
      gate: "chs-active-pass",
      baseline: { tier: "bounded", days: 60, bound: 40 },
      pending: false,
    });
    expect(d).toMatchObject({ status: "promoted", chs_fit: { tier: "final", days: 60 } });
  });

  test("is insufficient without scored weeks in its newest and previous years", () => {
    expect(
      disposeGate({ points: points(14), gate: "chs-other", baseline: undefined, pending: false }),
    ).toMatchObject({ status: "insufficient" });
  });

  test("carries a gate's previous chs_fit while it waits for a backfill", () => {
    const d = disposeGate({
      points: points(14),
      gate: "chs-active-pass",
      baseline: undefined,
      pending: true,
      carried: { status: "kept", chs_fit: { tier: "bounded", days: 210, slack_bound_minutes: 35 } },
    });
    expect(d).toMatchObject({
      status: "pending_backfill",
      chs_fit: { tier: "bounded", days: 210, slack_bound_minutes: 35 },
    });
  });
});
