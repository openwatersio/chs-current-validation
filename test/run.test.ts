import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ChsFitRecord, CuratedGate } from "../src/curated.ts";
import { historyDir, readHistory, readState, writeState } from "../src/history.ts";
import { range, type GateInput, type TargetPlan } from "../src/plan.ts";
import { readDispositions } from "../src/release.ts";
import type { GateRecord, ResultRow } from "../src/rows.ts";
import { DATABASE_REPO, recordTarget, type Outputs } from "../src/run.ts";
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
  tweak: (gate: string, grid: number, days: number) => Partial<ResultRow> = () => ({}),
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
            ...tweak(gate, grid, fit_days),
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

/** Records a monthly run of grid point 1 after the seed. */
const monthlyAfterSeed = (root: string, outputs: Outputs, overrides: Partial<TargetPlan> = {}) =>
  recordTarget({
    ...seedInput(root),
    outDir: join(root, "out2"),
    plan: plan({ candidates: [1], ...overrides }),
    outputs,
    tags: [SEED_TAG],
  });

const UNSCORED = {
  slack_errors: undefined,
  invented: undefined,
  extremum_errors: undefined,
  speed_errors: undefined,
  extrema: undefined,
  wrong_sign: undefined,
};
const NO_EVENTS = { status: "no_events" as const, ...UNSCORED };
const BEYOND_HORIZON = { status: "beyond_horizon" as const, ...UNSCORED };

/**
 * Seeds chs-a alone with the given slack errors per window, shipping `fit`
 * from another history's release, so the gate is curated afresh. Returns the
 * slackwater-database issues.
 */
async function freshlyCurated(fit: ChsFitRecord, errors: Record<number, (number | null)[]>) {
  const root = await mkdtemp(join(tmpdir(), "run-"));
  const announcement = await recordTarget({
    ...seedInput(root),
    gates: [GATES[0]],
    outputs: scored(range(-13, 0), [60, 210, 365], ["chs-a"], (_gate, _grid, days) =>
      errors[days] ? { slack_errors: errors[days] } : {},
    ),
    curated: new Map([["chs-a", { chs_fit: { ...fit, evidence: "fit-2026-01-01-0000000-r1" } }]]),
  });
  const doc = await readDispositions(root, key);
  return {
    issues: announcement.issues.filter((i) => i.repo === DATABASE_REPO),
    disposition: doc?.gates["chs-a"],
  };
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

  test("opens an issue for a gate with rows but no scored week at a new grid point", async () => {
    const { root } = await seeded();
    const outputs = scored([1], [60, 210], undefined, (gate) =>
      gate === "chs-b" ? NO_EVENTS : {},
    );
    const announcement = await monthlyAfterSeed(root, outputs);
    expect(announcement.issues).toEqual([
      {
        repo: "openwatersio/chs-current-validation",
        title: "No rows for chs-b",
        body: `Grid point 1, the fit ending ${testFitEnd(1)}, has no scored rows for \`chs-b\`: its 10 rows are 10 \`no_events\`.`,
      },
    ]);
    expect((await readHistory(root, key)).at(-1)?.grid).toBe(1);
  });

  test("names a gate's failures and row statuses when it has no scored week at a new grid point", async () => {
    const { root } = await seeded();
    const outputs = scored(
      [1],
      [60],
      undefined,
      (gate) => (gate === "chs-b" ? NO_EVENTS : {}),
      (gate) =>
        gate === "chs-b" ? { failures: [{ grid: 1, fit_days: 210, reason: "refused" }] } : {},
    );
    outputs.rows.push(...scored([1], [210], ["chs-a"]).rows);
    const announcement = await monthlyAfterSeed(root, outputs);
    expect(announcement.issues.map((i) => i.body)).toEqual([
      `Grid point 1, the fit ending ${testFitEnd(1)}, has no scored rows for \`chs-b\`: refused; its 5 rows are 5 \`no_events\`.`,
    ]);
  });

  test("opens no issue for a gate whose own horizon lags at a new grid point, unless some row has no events", async () => {
    const lagging = (tweak: (days: number) => Partial<ResultRow>) =>
      scored(
        [1],
        [60, 210],
        undefined,
        (gate, _grid, days) => (gate === "chs-b" ? tweak(days) : {}),
        (gate) => (gate === "chs-b" ? { horizon: "2027-06-01T00:00:00Z" } : {}),
      );
    const quiet = await seeded();
    const waiting = await monthlyAfterSeed(
      quiet.root,
      lagging(() => BEYOND_HORIZON),
    );
    expect(waiting.issues).toEqual([]);
    expect((await readHistory(quiet.root, key)).at(-1)?.grid).toBe(1);

    const mixed = await seeded();
    const announcement = await monthlyAfterSeed(
      mixed.root,
      lagging((days) => (days === 60 ? NO_EVENTS : BEYOND_HORIZON)),
    );
    expect(announcement.issues.map((i) => i.body)).toEqual([
      `Grid point 1, the fit ending ${testFitEnd(1)}, has no scored rows for \`chs-b\`: its 10 rows are 5 \`no_events\` and 5 \`beyond_horizon\`.`,
    ]);
  });

  test("opens an issue here when a grid point can't commit for a reason other than CHS's horizon", async () => {
    const { root } = await seeded();
    // IWLS refused the 210-day window at grid point 1 for every gate.
    const reason = "IWLS served 0 samples for the 210-day fit";
    const outputs = scored([1], [60], undefined, undefined, () => ({
      failures: [{ grid: 1, fit_days: 210, reason }],
    }));
    const announcement = await monthlyAfterSeed(root, outputs);
    expect(announcement.releases).toEqual([]);
    expect(announcement.issues).toEqual([
      {
        repo: "openwatersio/chs-current-validation",
        // Grid indices are shared across histories, so the title names which one stopped.
        title: `Grid point 1 can't commit for ${STAMP.slice(0, 7)} scorer 2`,
        body: expect.stringContaining(
          `Grid point 1, the fit ending ${testFitEnd(1)}, can't commit for recipe stamp \`${STAMP}\`, scorer 2: no gate scored the 210-day +0 d week.`,
        ),
      },
    ]);
    expect(announcement.issues[0].body).toContain("No later grid point in that history commits");
    expect(announcement.issues[0].body).toContain(reason);
    expect((await readHistory(root, key)).at(-1)?.grid).toBe(0);
  });

  test("waits on CHS's horizon with no issue", async () => {
    const { root } = await seeded();
    const outputs = scored([1], [60, 210]);
    outputs.rows = outputs.rows.map((r) =>
      r.offset_days === 270 ? { ...r, ...BEYOND_HORIZON } : r,
    );
    const announcement = await monthlyAfterSeed(root, outputs);
    expect(announcement.issues).toEqual([]);
    expect(announcement.releases).toEqual([]);
    expect(announcement.summary).toEqual([
      `${STAMP}: grid point 1 waits: CHS has not published events through chs-a's +270 d week`,
      `${STAMP}: nothing changed`,
    ]);
    expect((await readHistory(root, key)).at(-1)?.grid).toBe(0);
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

  test("asks slackwater-database to update a freshly curated gate whose shipped window no longer holds, though the release's claim ranks stronger", async () => {
    // The 210-day worst is now 50 minutes; the 60-day fit passes at 33.
    const { issues, disposition } = await freshlyCurated(
      { tier: "bounded", days: 210, slack_bound_minutes: 40 },
      { 60: [5, 5, 5, 33], 210: [5, 5, 5, 50] },
    );
    expect(disposition).toMatchObject({
      status: "fresh",
      chs_fit: { tier: "bounded", days: 60, slack_bound_minutes: 35 },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("Update chs_fit for chs-a");
    expect(issues[0].body).toContain("the claim `chs-a` ships no longer holds");
    expect(issues[0].body).not.toContain("weaker");
    expect(issues[0].body).toContain("- Ships: bounded 40 min, 210 d");
    expect(issues[0].body).toContain("- Release: bounded 35 min, 60 d (fresh)");
  });

  test("asks slackwater-database to update a freshly curated gate whose shipped provisional answer no longer qualifies", async () => {
    // The 210-day worst is 33 minutes; the 60-day fit misses a slack.
    const { issues, disposition } = await freshlyCurated(
      { tier: "bounded", days: 210, slack_bound_minutes: 40, provisional_slack_minutes: 45 },
      { 60: [5, 5, 5, null], 210: [5, 5, 5, 33] },
    );
    expect(disposition?.chs_fit).toEqual({ tier: "bounded", days: 210, slack_bound_minutes: 35 });
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("Update chs_fit for chs-a");
    expect(issues[0].body).toContain("the claim `chs-a` ships no longer holds");
    expect(issues[0].body).not.toContain("weaker");
  });

  test("still asks slackwater-database to update a gate whose shipped claim holds but whose release claim is weaker", async () => {
    // The 60-day worst of 29 minutes holds the shipped final claim, but a fresh claim needs the promotion margin.
    const { issues, disposition } = await freshlyCurated(
      { tier: "final", days: 60 },
      { 60: [5, 5, 5, 29.5], 210: [5, 5, 5, 29.5] },
    );
    expect(disposition?.chs_fit).toEqual({ tier: "bounded", days: 60, slack_bound_minutes: 35 });
    expect(issues).toHaveLength(1);
    expect(issues[0].body).toContain("gives `chs-a` a weaker claim than the one it ships");
    expect(issues[0].body).not.toContain("no longer holds");
  });

  test("files no slackwater-database issue when the shipped claim holds and the release's is no weaker", async () => {
    const { issues } = await freshlyCurated(
      { tier: "bounded", days: 60, slack_bound_minutes: 40 },
      {},
    );
    expect(issues).toEqual([]);
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
    expect(history.every((p) => p.rows.some((r) => r.gate === "chs-b"))).toBe(true);
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

  test("numbers a release after the history's own, when an earlier one never reached git", async () => {
    const { root } = await seeded();
    const announcement = await recordTarget({
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
      curated: new Map(),
      tags: [],
      ships: true,
      repo: "openwatersio/chs-current-validation",
    });
    const tag = `fit-${testFitEnd(0)}-8f85912-r2`;
    expect(announcement.releases.map((r) => r.tag)).toEqual([tag]);
    expect(
      JSON.parse(await readFile(join(historyDir(root, key), "releases.json"), "utf8")),
    ).toEqual([SEED_TAG, tag]);
  });

  test("opens an issue for a new gate whose backfill has only a reason, and leaves the history as it was", async () => {
    const { root } = await seeded();
    const before = await snapshot(historyDir(root, key));
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
    expect(await snapshot(historyDir(root, key))).toEqual(before);
    expect(announcement.issues.map((i) => i.title)).toEqual(["Backfill of chs-c failed"]);
    expect(announcement.issues[0].body).toContain(reason);
  });

  test("keeps a flagged gate's committed rows and flag when its backfill scores nothing, and opens an issue", async () => {
    const { root } = await seeded();
    await writeState(root, key, { needs_backfill: ["chs-b"] });
    const before = await readHistory(root, key);
    // chs-b moved to a station whose metadata fails; chs-a scores grid point 1 as usual.
    const reason = "IWLS has no flood axis for 00003";
    const outputs = scored([1], [60, 210], ["chs-a"]);
    outputs.gates.push(record({ gate: "chs-b", iwls: "00003", reason }));
    const announcement = await monthlyAfterSeed(root, outputs, {
      backfill: ["chs-b"],
      backfillGrid: range(-13, 1),
    });
    const history = await readHistory(root, key);
    expect(history.map((p) => p.grid)).toEqual(range(-13, 1));
    expect(history.slice(0, -1)).toEqual(before);
    expect((await readState(root, key)).needs_backfill).toEqual(["chs-b"]);
    const issue = announcement.issues.find((i) => i.title === "Backfill of chs-b failed");
    expect(issue?.body).toContain(reason);
    expect(issue?.body).toContain("stays flagged");
    expect((await readDispositions(root, key))?.gates["chs-b"]).toMatchObject({
      status: "pending_backfill",
      chs_fit: { tier: "final", days: 60 },
    });
  });

  test("replaces a flagged gate only where its backfill scored, and keeps its flag", async () => {
    const { root } = await seeded();
    await writeState(root, key, { needs_backfill: ["chs-b"] });
    const outputs = scored(
      range(-12, 0),
      [60, 210, 365],
      ["chs-b"],
      () => ({ iwls: "00003" }),
      () => ({ iwls: "00003", failures: [{ grid: -13, reason: "IWLS served 0 samples" }] }),
    );
    const announcement = await recordTarget({
      ...seedInput(root),
      outDir: join(root, "out2"),
      plan: plan({ backfill: ["chs-b"], backfillGrid: range(-13, 0) }),
      outputs,
      tags: [SEED_TAG],
    });
    const stationsOfB = (await readHistory(root, key)).map(
      (p) => p.rows.find((r) => r.gate === "chs-b")?.iwls,
    );
    expect(stationsOfB).toEqual(["00002", ...range(-12, 0).map(() => "00003")]);
    expect((await readState(root, key)).needs_backfill).toEqual(["chs-b"]);
    expect(announcement.issues.map((i) => i.title)).toEqual(["Backfill of chs-b failed"]);
    expect(announcement.issues[0].body).toContain(testFitEnd(-13));
    expect(announcement.issues[0].body).toContain("IWLS served 0 samples");
  });

  test("leaves the history byte-identical and readable when a backfill of every gate scores nothing", async () => {
    const { root } = await seeded();
    const before = await snapshot(historyDir(root, key));
    const announcement = await recordTarget({
      ...seedInput(root),
      outDir: join(root, "out2"),
      plan: plan({ backfill: ["chs-a", "chs-b"], backfillGrid: range(-13, 0) }),
      outputs: {
        rows: [],
        gates: [
          record({ gate: "chs-a", iwls: "00001", reason: "IWLS refused the station's metadata" }),
          record({
            gate: "chs-b",
            iwls: "00002",
            failures: range(-13, 0).map((grid) => ({ grid, reason: "IWLS served 0 samples" })),
          }),
        ],
      },
      tags: [SEED_TAG],
    });
    expect(await snapshot(historyDir(root, key))).toEqual(before);
    expect((await readHistory(root, key)).map((p) => p.grid)).toEqual(range(-13, 0));
    expect(announcement.releases).toEqual([]);
    expect(announcement.issues.map((i) => i.title)).toEqual([
      "Backfill of chs-a failed",
      "Backfill of chs-b failed",
    ]);
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

  test("refuses a plan whose new grid points would leave a gap in the history", async () => {
    const { root } = await seeded();
    const before = await snapshot(historyDir(root, key));
    await expect(
      recordTarget({
        root,
        outDir: join(root, "out2"),
        plan: plan({ candidates: [2] }),
        gates: GATES,
        database: "1.0.0-beta.20261017",
        outputs: scored([2], [60, 210]),
        curated: new Map(),
        tags: [SEED_TAG],
        ships: true,
        repo: "openwatersio/chs-current-validation",
      }),
    ).rejects.toThrow(/first new grid point is 2, but the history ends at grid point 0/);
    expect(await snapshot(historyDir(root, key))).toEqual(before);
  });
});
