import { describe, expect, test } from "vitest";
import {
  FULL_WINDOWS,
  fittedGates,
  MONTHLY_WINDOWS,
  planTarget,
  range,
  shardGates,
  type GateInput,
} from "../src/plan.ts";

const DAY = 86_400_000;
// A plain 28-day grid from the anchor is enough to plan against.
const grid = {
  gridIndexOnOrBefore: (date: string) =>
    Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse("2026-10-29T00:00:00Z")) / (28 * DAY)),
};
const gates = (n: number): GateInput[] =>
  Array.from({ length: n }, (_, k) => ({
    id: `chs-gate-${String(k).padStart(2, "0")}`,
    latitude: 49,
    longitude: -123,
  }));
const target = { stamp: "8f85912ce223", engine: "a".repeat(40) };
// 2026-11-30 is 32 days after the anchor, so grid point 1 is the newest.
const base = {
  target,
  scorer: 2,
  offsets: [0, 28, 90, 180, 270],
  backfill: [] as string[],
  today: "2026-11-30",
  grid,
};
const ids = (n: number) => new Set(gates(n).map((g) => g.id));

describe("planTarget", () => {
  test("seeds 14 grid points ending at the newest one on or before today", () => {
    const plan = planTarget({ ...base, committed: [], known: new Set(), gates: gates(23) });
    expect(plan.mode).toBe("seed");
    expect(plan.candidates).toEqual(range(-12, 1));
    expect(plan.shards.map((s) => [s.id, s.gates.length, s.grid, s.windows])).toEqual([
      ["seed-1", 6, "-12..1", "60,210,365"],
      ["seed-2", 6, "-12..1", "60,210,365"],
      ["seed-3", 6, "-12..1", "60,210,365"],
      ["seed-4", 5, "-12..1", "60,210,365"],
    ]);
  });

  test("scores each grid point after the newest committed one", () => {
    const plan = planTarget({
      ...base,
      committed: range(-12, 0),
      known: ids(23),
      gates: gates(23),
    });
    expect(plan.mode).toBe("monthly");
    expect(plan.candidates).toEqual([1]);
    expect(plan.backfill).toEqual([]);
    expect(plan.shards.map((s) => [s.id, s.grid, s.windows])).toEqual([
      ["monthly-1", "1..1", "60,210"],
      ["monthly-2", "1..1", "60,210"],
      ["monthly-3", "1..1", "60,210"],
      ["monthly-4", "1..1", "60,210"],
    ]);
  });

  test("has nothing to score when the history is up to date", () => {
    const plan = planTarget({
      ...base,
      committed: range(-12, 1),
      known: ids(23),
      gates: gates(23),
    });
    expect(plan.candidates).toEqual([]);
    expect(plan.shards).toEqual([]);
  });

  test("backfills a gate the history has never seen over the newest grid points", () => {
    const known = ids(23);
    known.delete("chs-gate-22");
    const plan = planTarget({ ...base, committed: range(-12, 0), known, gates: gates(23) });
    expect(plan.backfill).toEqual(["chs-gate-22"]);
    expect(plan.backfillGrid).toEqual(range(-12, 1));
    const backfill = plan.shards.filter((s) => s.id.startsWith("backfill-"));
    expect(backfill.map((s) => [s.gates.map((g) => g.id), s.grid, s.windows])).toEqual([
      [["chs-gate-22"], "-12..1", "60,210,365"],
    ]);
    const monthly = plan.shards.filter((s) => s.id.startsWith("monthly-")).flatMap((s) => s.gates);
    expect(monthly.map((g) => g.id)).not.toContain("chs-gate-22");
    expect(monthly).toHaveLength(22);
  });

  test("backfills flagged and requested gates it still has, and every gate on request", () => {
    const flagged = planTarget({
      ...base,
      committed: range(-20, 1),
      known: ids(3),
      gates: gates(3),
      backfill: ["chs-gate-01", "chs-gone"],
    });
    expect(flagged.backfill).toEqual(["chs-gate-01"]);
    expect(flagged.backfillGrid).toEqual(range(-12, 1));
    const all = planTarget({
      ...base,
      committed: range(-12, 1),
      known: ids(3),
      gates: gates(3),
      backfill: "all",
    });
    expect(all.backfill).toEqual([...ids(3)]);
    expect(all.shards.every((s) => s.id.startsWith("backfill-"))).toBe(true);
  });

  test("backfills over the 14 newest committed grid points and the new ones", () => {
    const plan = planTarget({
      ...base,
      committed: range(-29, 0),
      known: ids(3),
      gates: gates(3),
      backfill: ["chs-gate-01"],
    });
    expect(plan.candidates).toEqual([1]);
    expect(plan.backfillGrid).toEqual(range(-13, 1));
    const backfill = plan.shards.filter((s) => s.id.startsWith("backfill-"));
    expect(backfill.map((s) => [s.gates.map((g) => g.id), s.grid])).toEqual([
      [["chs-gate-01"], "-13..1"],
    ]);
  });
});

describe("windows", () => {
  test("a monthly run scores the recipe's windows and a seed or backfill adds the report-only year", () => {
    expect(MONTHLY_WINDOWS).toEqual([60, 210]);
    expect(FULL_WINDOWS).toEqual([60, 210, 365]);
  });
});

describe("shardGates and fittedGates", () => {
  test("splits gates into the fewest shards of about six, at most four", () => {
    expect(shardGates(gates(1)).map((s) => s.length)).toEqual([1]);
    expect(shardGates(gates(7)).map((s) => s.length)).toEqual([4, 3]);
    expect(shardGates(gates(30)).map((s) => s.length)).toEqual([8, 8, 7, 7]);
  });

  test("fits every CHS current gate except those whose slack derives from a tide port", () => {
    const station = (id: string, extra: object = {}) => ({
      id,
      kind: "current",
      latitude: 1,
      longitude: 2,
      source: { name: "Canadian Hydrographic Service" },
      ...extra,
    });
    expect(
      fittedGates([
        station("chs-b"),
        station("chs-a"),
        station("chs-malibu-rapids", { current: { derived: { reference: "chs-point-atkinson" } } }),
        station("noaa/PCT1391", { source: { name: "NOAA" } }),
        station("chs-tide", { kind: "tide" }),
      ]),
    ).toEqual([
      { id: "chs-a", latitude: 1, longitude: 2 },
      { id: "chs-b", latitude: 1, longitude: 2 },
    ]);
  });
});
