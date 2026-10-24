import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CuratedGate } from "../src/curated.ts";
import { historyDir, readHistory, readState, writeState } from "../src/history.ts";
import { range, type GateInput, type TargetPlan } from "../src/plan.ts";
import { readDispositions } from "../src/release.ts";
import type { GateRecord, ResultRow } from "../src/rows.ts";
import { recordTarget, type Outputs } from "../src/run.ts";
import { STAMP, record, row, testFitEnd } from "./builders.ts";

const DAY = 86_400_000;
const OFFSETS = [0, 28, 90, 180, 270];
const GATES: GateInput[] = [
  { id: "chs-a", latitude: 49, longitude: -123 },
  { id: "chs-b", latitude: 50, longitude: -124 },
];
const iwlsOf = (gate: string) => (gate === "chs-a" ? "00001" : "00002");

/** A run's outputs: every gate scored at every grid point, window and age, with good errors unless overridden. */
function scored(
  grids: number[],
  windows: number[],
  gates = GATES.map((g) => g.id),
  tweak: (gate: string, grid: number) => Partial<ResultRow> = () => ({}),
  recordTweak: (gate: string) => Partial<GateRecord> = () => ({}),
): Outputs {
  const rows = grids.flatMap((grid) =>
    gates.flatMap((gate) =>
      windows.flatMap((fit_days) =>
        OFFSETS.map((offset_days) => {
          const fitEnd = Date.parse(`${testFitEnd(grid)}T07:00:00Z`);
          return row({
            gate,
            iwls: iwlsOf(gate),
            grid,
            fit_days,
            offset_days,
            fit_end: new Date(fitEnd).toISOString().replace(".000Z", "Z"),
            week_start: new Date(fitEnd + offset_days * DAY).toISOString().replace(".000Z", "Z"),
            ...tweak(gate, grid),
          });
        }),
      ),
    ),
  );
  return {
    rows,
    gates: gates.map((gate) => record({ gate, iwls: iwlsOf(gate), ...recordTweak(gate) })),
  };
}

function plan(overrides: Partial<TargetPlan>): TargetPlan {
  return {
    stamp: STAMP,
    engine: "f".repeat(40),
    scorer: 2,
    offsets: OFFSETS,
    mode: "monthly",
    candidates: [],
    backfill: [],
    backfillGrid: [],
    shards: [],
    ...overrides,
  };
}

const key = { stamp: STAMP, scorer: 2 };
const SEED_TAG = `fit-${testFitEnd(0)}-8f85912-r1`;

/** Every file in a directory, by name, with its contents. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort())
    out[name] = await readFile(join(dir, name), "utf8");
  return out;
}

const seedInput = (root: string) => ({
  root,
  outDir: join(root, "out"),
  plan: plan({ mode: "seed", candidates: range(-13, 0) }),
  gates: GATES,
  database: "1.0.0-beta.20261017",
  outputs: scored(range(-13, 0), [60, 210, 365]),
  curated: new Map<string, CuratedGate>(),
  tags: [] as string[],
  ships: true,
  repo: "openwatersio/chs-current-validation",
});

async function seeded() {
  const root = await mkdtemp(join(tmpdir(), "run-"));
  const announcement = await recordTarget(seedInput(root));
  return { root, announcement };
}

describe("recordTarget", () => {
  test("commits a seed and releases it with fresh dispositions", async () => {
    const { root, announcement } = await seeded();
    expect((await readHistory(root, key)).map((p) => p.grid)).toEqual(range(-13, 0));
    const tag = `fit-${testFitEnd(0)}-8f85912-r1`;
    expect(announcement.releases.map((r) => r.tag)).toEqual([tag]);
    expect(announcement.issues).toEqual([]);
    const doc = await readDispositions(root, key);
    expect(doc?.release).toBe(tag);
    expect(doc?.gates["chs-a"]).toMatchObject({
      status: "fresh",
      chs_fit: { tier: "final", days: 60 },
    });
    expect(
      JSON.parse(await readFile(join(historyDir(root, key), "releases.json"), "utf8")),
    ).toEqual([tag]);
  });

  test("changes nothing on a re-run with nothing new", async () => {
    const { root } = await seeded();
    const before = await snapshot(historyDir(root, key));
    const again = await recordTarget({
      root,
      outDir: join(root, "out2"),
      plan: plan({}),
      gates: GATES,
      database: "1.0.0-beta.20261017",
      outputs: { rows: [], gates: [] },
      curated: new Map(),
      tags: [SEED_TAG],
      ships: true,
      repo: "openwatersio/chs-current-validation",
    });
    expect(again.releases).toEqual([]);
    expect(again.issues).toEqual([]);
    expect(again.dispatch).toBe(false);
    expect(await snapshot(historyDir(root, key))).toEqual(before);
  });

  test("changes nothing when the same plan is recorded twice", async () => {
    const { root } = await seeded();
    const before = await snapshot(historyDir(root, key));
    const again = await recordTarget({
      ...seedInput(root),
      outDir: join(root, "out2"),
      tags: [SEED_TAG],
    });
    expect(again.releases).toEqual([]);
    expect(again.issues).toEqual([]);
    expect(again.dispatch).toBe(false);
    expect(again.summary.some((line) => line.endsWith("nothing changed"))).toBe(true);
    expect(await snapshot(historyDir(root, key))).toEqual(before);
  });

  test("flags a CHS revision, carries the gate's disposition and asks for a backfill", async () => {
    const { root } = await seeded();
    const announcement = await recordTarget({
      root,
      outDir: join(root, "out2"),
      plan: plan({ candidates: [1] }),
      gates: GATES,
      database: "1.0.0-beta.20261017",
      outputs: scored([1], [60, 210], undefined, undefined, (gate) =>
        gate === "chs-b" ? { canary: "000000000000" } : {},
      ),
      curated: new Map(),
      tags: [SEED_TAG],
      ships: true,
      repo: "openwatersio/chs-current-validation",
    });
    expect((await readState(root, key)).needs_backfill).toEqual(["chs-b"]);
    expect(announcement.dispatch).toBe(true);
    expect(announcement.issues.map((i) => i.title)).toEqual(["CHS revised predictions at chs-b"]);
    const doc = await readDispositions(root, key);
    expect(doc?.gates["chs-b"]).toMatchObject({
      status: "pending_backfill",
      chs_fit: { tier: "final", days: 60 },
    });
    expect(announcement.releases.map((r) => r.tag)).toEqual([`fit-${testFitEnd(1)}-8f85912-r1`]);
  });

  test("opens an issue for a gate with no rows at a new grid point", async () => {
    const { root } = await seeded();
    const outputs = scored([1], [60, 210], ["chs-a"]);
    outputs.gates.push(record({ gate: "chs-b", reason: "no IWLS station within 3 km" }));
    const announcement = await recordTarget({
      root,
      outDir: join(root, "out2"),
      plan: plan({ candidates: [1] }),
      gates: GATES,
      database: "1.0.0-beta.20261017",
      outputs,
      curated: new Map(),
      tags: [],
      ships: true,
      repo: "openwatersio/chs-current-validation",
    });
    expect(announcement.issues.map((i) => i.title)).toContain("No rows for chs-b");
    expect((await readHistory(root, key)).at(-1)?.grid).toBe(1);
  });

  test("asks slackwater-database to update a gate whose claim got weaker, for the target the apps ship", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-"));
    const curated = new Map<string, CuratedGate>([
      ["chs-a", { chs_fit: { tier: "final", days: 60, evidence: "fit-2026-01-01-0000000-r1" } }],
    ]);
    const bad = (gate: string) => (gate === "chs-a" ? { slack_errors: [5, 50] } : {});
    const input = {
      root,
      outDir: join(root, "out"),
      plan: plan({ mode: "seed", candidates: range(-13, 0) }),
      gates: GATES,
      database: "1.0.0-beta.20261017",
      outputs: scored(range(-13, 0), [60, 210, 365], undefined, bad),
      curated,
      tags: [],
      repo: "openwatersio/chs-current-validation",
    };
    const ships = await recordTarget({ ...input, ships: true });
    expect(ships.issues).toEqual([
      expect.objectContaining({
        repo: "openwatersio/slackwater-database",
        title: "Update chs_fit for chs-a",
      }),
    ]);
    const other = await mkdtemp(join(tmpdir(), "run-"));
    const upcoming = await recordTarget({
      ...input,
      root: other,
      outDir: join(other, "out"),
      ships: false,
    });
    expect(upcoming.issues).toEqual([]);
  });

  test("replaces a backfilled gate's rows and clears its flag", async () => {
    const { root } = await seeded();
    await writeState(root, key, { needs_backfill: ["chs-b"] });
    const outputs = scored(
      range(-13, 0),
      [60, 210, 365],
      ["chs-b"],
      () => ({ iwls: "00003" }),
      () => ({ iwls: "00003" }),
    );
    await recordTarget({
      root,
      outDir: join(root, "out2"),
      plan: plan({ backfill: ["chs-b"], backfillGrid: range(-13, 0) }),
      gates: GATES,
      database: "1.0.0-beta.20261017",
      outputs,
      curated: new Map(),
      tags: [SEED_TAG],
      ships: true,
      repo: "openwatersio/chs-current-validation",
    });
    const history = await readHistory(root, key);
    expect(
      history.every((p) =>
        p.rows.filter((r) => r.gate === "chs-b").every((r) => r.iwls === "00003"),
      ),
    ).toBe(true);
    expect(history.every((p) => p.rows.some((r) => r.gate === "chs-a" && r.iwls === "00001"))).toBe(
      true,
    );
    expect((await readState(root, key)).needs_backfill).toEqual([]);
  });

  test("changes nothing when the same backfill is recorded twice", async () => {
    const { root } = await seeded();
    await writeState(root, key, { needs_backfill: ["chs-b"] });
    const backfill = {
      root,
      outDir: join(root, "out2"),
      plan: plan({ backfill: ["chs-b"], backfillGrid: range(-13, 0) }),
      gates: GATES,
      database: "1.0.0-beta.20261017",
      outputs: scored(
        range(-13, 0),
        [60, 210, 365],
        ["chs-b"],
        () => ({ iwls: "00003" }),
        () => ({ iwls: "00003" }),
      ),
      curated: new Map<string, CuratedGate>(),
      tags: [SEED_TAG],
      ships: true,
      repo: "openwatersio/chs-current-validation",
    };
    const first = await recordTarget(backfill);
    const before = await snapshot(historyDir(root, key));
    const again = await recordTarget({
      ...backfill,
      outDir: join(root, "out3"),
      tags: [SEED_TAG, ...first.releases.map((r) => r.tag)],
    });
    expect(again.releases).toEqual([]);
    expect(again.issues).toEqual([]);
    expect(again.summary.some((line) => line.endsWith("nothing changed"))).toBe(true);
    expect(await snapshot(historyDir(root, key))).toEqual(before);
  });

  test("records a backfilled gate that has only a reason, and opens an issue for it", async () => {
    const { root } = await seeded();
    const reason = "no IWLS station within 3 km";
    const announcement = await recordTarget({
      root,
      outDir: join(root, "out2"),
      plan: plan({ backfill: ["chs-c"], backfillGrid: range(-13, 0) }),
      gates: [...GATES, { id: "chs-c", latitude: 48, longitude: -125 }],
      database: "1.0.0-beta.20261017",
      outputs: { rows: [], gates: [record({ gate: "chs-c", reason })] },
      curated: new Map(),
      tags: [SEED_TAG],
      ships: true,
      repo: "openwatersio/chs-current-validation",
    });
    const history = await readHistory(root, key);
    expect(history.map((p) => p.grid)).toEqual(range(-13, 0));
    expect(
      history.every((p) => p.gates.some((g) => g.gate === "chs-c" && g.reason === reason)),
    ).toBe(true);
    expect(announcement.issues.filter((i) => i.title === "No rows for chs-c")).toHaveLength(1);
    expect((await readState(root, key)).needs_backfill).toEqual([]);
  });

  test("refuses rows from another stamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-"));
    const outputs = scored([0], [60, 210]);
    outputs.rows[0] = { ...outputs.rows[0], stamp: "000000000000" };
    await expect(
      recordTarget({
        root,
        outDir: join(root, "out"),
        plan: plan({ mode: "seed", candidates: [0] }),
        gates: GATES,
        database: "d",
        outputs,
        curated: new Map(),
        tags: [],
        ships: true,
        repo: "r",
      }),
    ).rejects.toThrow(/stamp 000000000000/);
  });
});
