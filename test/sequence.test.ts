import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readHistory, readState } from "../src/history.ts";
import { planTarget, range, type GateInput, type TargetPlan } from "../src/plan.ts";
import { readDispositions } from "../src/release.ts";
import { recordTarget, type Outputs } from "../src/run.ts";
import { STAMP, record, row, testFitEnd } from "./builders.ts";

const DAY = 86_400_000;
const OFFSETS = [0, 28, 90, 180, 270];
/** A held-out week, and the pairing context past it that the engine also needs CHS to have published. */
const WEEK_MS = 7 * DAY;
const CONTEXT_MS = 6 * 3_600_000;
const HORIZON = "2028-01-01T00:00:00Z";
// The plain 28-day grid of testFitEnd.
const grid = {
  gridIndexOnOrBefore: (date: string) =>
    Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse("2026-10-29T00:00:00Z")) / (28 * DAY)),
};
const GATES: GateInput[] = ["chs-a", "chs-b", "chs-c"].map((id, k) => ({
  id,
  latitude: 49 + k,
  longitude: -123,
}));
const STATIONS: Record<string, string> = { "chs-a": "00001", "chs-b": "00002", "chs-c": "00003" };
const MOVED = { ...STATIONS, "chs-b": "00009" };
const key = { stamp: STAMP, scorer: 2 };
const BEYOND_HORIZON = {
  status: "beyond_horizon" as const,
  slack_errors: undefined,
  invented: undefined,
  extremum_errors: undefined,
  speed_errors: undefined,
  extrema: undefined,
  wrong_sign: undefined,
};
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const tag = (grid: number, run = 1) => `fit-${testFitEnd(grid)}-8f85912-r${run}`;

/** Scores a plan as the engine would: each shard's gates at its grid points and windows, with weeks past CHS's horizon beyond it. */
function engine(plan: TargetPlan, stations: Record<string, string>): Outputs {
  const out: Outputs = { rows: [], gates: [] };
  for (const shard of plan.shards) {
    const [a, b] = shard.grid.split("..").map(Number);
    for (const gate of shard.gates) {
      for (const i of range(a, b)) {
        const fitEnd = Date.parse(`${testFitEnd(i)}T07:00:00Z`);
        for (const fit_days of shard.windows.split(",").map(Number)) {
          for (const offset_days of OFFSETS) {
            const weekStart = fitEnd + offset_days * DAY;
            const beyond = weekStart + WEEK_MS + CONTEXT_MS > Date.parse(HORIZON);
            out.rows.push(
              row({
                gate: gate.id,
                iwls: stations[gate.id],
                grid: i,
                fit_days,
                offset_days,
                fit_end: iso(fitEnd),
                week_start: iso(weekStart),
                ...(beyond ? BEYOND_HORIZON : {}),
              }),
            );
          }
        }
      }
      out.gates.push(record({ gate: gate.id, iwls: stations[gate.id], horizon: HORIZON }));
    }
  }
  return out;
}

/** Plans, scores and records one run on `today`, as the workflow does, and adds its releases to `tags`. */
async function run(root: string, today: string, tags: string[], stations = STATIONS) {
  const history = await readHistory(root, key);
  const plan = planTarget({
    target: { stamp: STAMP, engine: "f".repeat(40) },
    scorer: 2,
    offsets: OFFSETS,
    committed: history.map((p) => p.grid),
    known: new Set(history.at(-1)?.gates.map((g) => g.gate) ?? []),
    gates: GATES,
    backfill: (await readState(root, key)).needs_backfill,
    today,
    grid,
  });
  const announcement = await recordTarget({
    root,
    outDir: join(root, "out"),
    plan,
    gates: GATES,
    database: "1.0.0-beta.20261017",
    outputs: engine(plan, stations),
    curated: new Map(),
    tags: [...tags],
    ships: true,
    repo: "openwatersio/chs-current-validation",
  });
  tags.push(...announcement.releases.map((r) => r.tag));
  return { plan, announcement, releases: announcement.releases.map((r) => r.tag) };
}

test("a seed, monthly runs, a station change and its follow-up, then CHS's horizon wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "sequence-"));
  const tags: string[] = [];
  const grids = async () => (await readHistory(root, key)).map((p) => p.grid);

  // The seed scores the 14 grid points ending at the newest one.
  const seed = await run(root, "2026-11-03", tags);
  expect(seed.plan.mode).toBe("seed");
  expect(await grids()).toEqual(range(-13, 0));
  expect(seed.releases).toEqual([tag(0)]);
  expect(seed.announcement.issues).toEqual([]);

  // Each monthly run adds the next grid point.
  for (const [today, newest] of [
    ["2026-12-03", 1],
    ["2027-01-03", 2],
  ] as const) {
    const monthly = await run(root, today, tags);
    expect(monthly.plan.candidates).toEqual([newest]);
    expect(monthly.releases).toEqual([tag(newest)]);
    expect(monthly.announcement.issues).toEqual([]);
    expect(monthly.announcement.dispatch).toBe(false);
  }

  // chs-b moves to another IWLS station: grid point 3 commits, and chs-b waits for a follow-up backfill.
  const moved = await run(root, "2027-02-03", tags, MOVED);
  expect(moved.plan.candidates).toEqual([3]);
  expect(moved.releases).toEqual([tag(3)]);
  expect(moved.announcement.issues.map((i) => i.title)).toEqual([
    "chs-b moved to another IWLS station or flood axis",
  ]);
  expect(moved.announcement.dispatch).toBe(true);
  expect((await readState(root, key)).needs_backfill).toEqual(["chs-b"]);
  expect((await readDispositions(root, key))?.gates["chs-b"]).toMatchObject({
    status: "pending_backfill",
    chs_fit: { tier: "final", days: 60 },
  });

  // The follow-up re-scores chs-b over the 14 newest grid points, clears its flag and releases again.
  const followUp = await run(root, "2027-02-03", tags, MOVED);
  expect(followUp.plan.candidates).toEqual([]);
  expect(followUp.plan.backfill).toEqual(["chs-b"]);
  expect(followUp.plan.backfillGrid).toEqual(range(-10, 3));
  expect(followUp.releases).toEqual([tag(3, 2)]);
  expect(followUp.announcement.issues).toEqual([]);
  expect(followUp.announcement.dispatch).toBe(false);
  expect((await readState(root, key)).needs_backfill).toEqual([]);
  expect((await readDispositions(root, key))?.gates["chs-b"]).toMatchObject({
    status: "fresh",
    chs_fit: { tier: "final", days: 60 },
  });
  const stationsOfB = (await readHistory(root, key)).map((p) => [
    p.grid,
    [...new Set(p.rows.filter((r) => r.gate === "chs-b").map((r) => r.iwls))],
  ]);
  expect(stationsOfB).toEqual(
    range(-13, 3).map((g) => [g, [g < -10 ? STATIONS["chs-b"] : MOVED["chs-b"]]]),
  );

  const march = await run(root, "2027-03-03", tags, MOVED);
  expect(march.plan.candidates).toEqual([4]);
  expect(march.plan.backfill).toEqual([]);
  expect(march.releases).toEqual([tag(4)]);
  expect(march.announcement.issues).toEqual([]);

  // Grid point 5 commits, but grid point 6's +270 d week runs past CHS's horizon, so it waits, with no issue.
  const may = await run(root, "2027-05-03", tags, MOVED);
  expect(may.plan.candidates).toEqual([5, 6]);
  expect(may.releases).toEqual([tag(5)]);
  expect(may.announcement.issues).toEqual([]);
  expect(may.announcement.summary).toContain(
    `${STAMP}: grid point 6 waits: CHS has not published events through chs-a's +270 d week`,
  );

  // A month later it still waits, and nothing changes.
  const june = await run(root, "2027-06-03", tags, MOVED);
  expect(june.plan.candidates).toEqual([6, 7]);
  expect(june.announcement).toMatchObject({ releases: [], issues: [], dispatch: false });
  expect(june.announcement.summary).toContain(`${STAMP}: nothing changed`);

  expect(await grids()).toEqual(range(-13, 5));
  expect(tags).toEqual([tag(0), tag(1), tag(2), tag(3), tag(3, 2), tag(4), tag(5)]);
});
