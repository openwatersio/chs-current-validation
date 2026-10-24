import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  readHistory,
  readJson,
  readState,
  writeGridPoint,
  writeJson,
  writeState,
} from "../src/history.ts";
import { STAMP, record, row } from "./builders.ts";

const key = { stamp: STAMP, scorer: 2 };
const temp = () => mkdtemp(join(tmpdir(), "history-"));

describe("the history", () => {
  test("reads back the grid points it wrote, oldest first", async () => {
    const root = await temp();
    await writeGridPoint(root, key, {
      grid: 0,
      fitEnd: "2026-10-29",
      rows: [row({ grid: 0 })],
      gates: [record()],
    });
    await writeGridPoint(root, key, {
      grid: -1,
      fitEnd: "2026-10-22",
      rows: [row({ grid: -1 })],
      gates: [record()],
    });
    const points = await readHistory(root, key);
    expect(points.map((p) => [p.grid, p.fitEnd])).toEqual([
      [-1, "2026-10-22"],
      [0, "2026-10-29"],
    ]);
    expect(points[1].gates).toEqual([record()]);
  });

  test("has no grid points before its first write", async () => {
    expect(await readHistory(await temp(), key)).toEqual([]);
  });

  test("refuses a row from another stamp or scorer version, so they never pool", async () => {
    const root = await temp();
    await writeGridPoint(root, key, {
      grid: 0,
      fitEnd: "2026-10-29",
      rows: [row({ stamp: "000000000000" })],
      gates: [],
    });
    await expect(readHistory(root, key)).rejects.toThrow(/stamp 000000000000/);
    const other = await temp();
    await writeGridPoint(other, key, {
      grid: 0,
      fitEnd: "2026-10-29",
      rows: [row({ scorer: 3 })],
      gates: [],
    });
    await expect(readHistory(other, key)).rejects.toThrow(/scorer 3/);
  });

  test("refuses a gap between grid points", async () => {
    const root = await temp();
    await writeGridPoint(root, key, {
      grid: -2,
      fitEnd: "2026-09-17",
      rows: [row({ grid: -2 })],
      gates: [],
    });
    await writeGridPoint(root, key, {
      grid: 0,
      fitEnd: "2026-10-29",
      rows: [row({ grid: 0 })],
      gates: [],
    });
    await expect(readHistory(root, key)).rejects.toThrow(/skips from grid point -2 to 0/);
  });

  test("keeps no gates to backfill until told", async () => {
    const root = await temp();
    expect(await readState(root, key)).toEqual({ needs_backfill: [] });
    await writeState(root, key, { needs_backfill: ["chs-active-pass"] });
    expect(await readState(root, key)).toEqual({ needs_backfill: ["chs-active-pass"] });
  });
});

describe("the JSON helpers", () => {
  test("read nothing from a missing file and round-trip what they write", async () => {
    const path = join(await temp(), "nested", "value.json");
    expect(await readJson(path)).toBeUndefined();
    await writeJson(path, { gates: ["chs-active-pass"], count: 1 });
    expect(await readJson(path)).toEqual({ gates: ["chs-active-pass"], count: 1 });
  });
});
