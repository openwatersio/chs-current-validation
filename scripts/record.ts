// Records a results run: reads out/plan.json, the score jobs' outputs under
// shards/, the curated station files under database/, and this checkout's
// release tags; writes the history, out/announce.json and out/commit.txt.
import { execFile } from "node:child_process";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkCurated, readCurated } from "../src/curated.ts";
import type { GateInput, TargetPlan } from "../src/plan.ts";
import { declaredOnly, parseJsonl, suspectFields } from "../src/rows.ts";
import { recordTarget, type Announcement, type Outputs } from "../src/run.ts";

const plan = JSON.parse(await readFile("out/plan.json", "utf8")) as {
  database: string;
  gates: GateInput[];
  plans: TargetPlan[];
};
const stationsDir = process.env.DATABASE_STATIONS ?? "database/stations/current/ca";
const curated = await readCurated(stationsDir);
const unlisted = checkCurated(
  curated,
  plan.gates.map((g) => g.id),
  stationsDir,
);
const { stdout } = await promisify(execFile)("git", ["tag", "--list", "fit-*"]);
const tags = stdout.split("\n").filter(Boolean);
const repo = process.env.GITHUB_REPOSITORY ?? "openwatersio/chs-current-validation";

async function readShards(
  dir: string,
  target: TargetPlan,
): Promise<Outputs & { dropped: string[] }> {
  const expected = target.shards.map((s) => `shard-${target.stamp}-${s.id}`);
  const arrived = (await readdir(dir)).filter((n) => n.startsWith(`shard-${target.stamp}-`));
  const missing = expected.filter((n) => !arrived.includes(n));
  const unplanned = arrived.filter((n) => !expected.includes(n));
  if (missing.length || unplanned.length) {
    throw new Error(
      `${target.stamp}: missing shard outputs ${missing.join(", ") || "none"}, unplanned ${unplanned.join(", ") || "none"}`,
    );
  }
  const rows: object[] = [];
  const gates: object[] = [];
  for (const name of expected) {
    rows.push(
      ...parseJsonl<object>(await readFile(join(dir, name, "chs-current-fit.jsonl"), "utf8")),
    );
    gates.push(
      ...parseJsonl<object>(await readFile(join(dir, name, "chs-current-gates.jsonl"), "utf8")),
    );
  }
  return declaredOnly(rows, gates);
}

const all: Announcement = { releases: [], issues: [], dispatch: false, summary: [] };
// A gate published before its station file reaches main is scored as usual, and ships nothing until it does.
for (const id of unlisted) all.summary.push(`${id}: no station file on slackwater-database main`);
for (const [k, target] of plan.plans.entries()) {
  if (!target.shards.length) {
    all.summary.push(`${target.stamp}: nothing to score`);
    continue;
  }
  const { dropped, ...outputs } = await readShards("shards", target);
  const suspect = suspectFields(dropped);
  if (suspect.length) {
    all.summary.push(
      `${target.stamp}: dropped fields the history doesn't declare, which may hold CHS times or samples: ${suspect.join(", ")}`,
    );
  }
  const a = await recordTarget({
    root: process.cwd(),
    outDir: "out/releases",
    plan: target,
    gates: plan.gates,
    database: plan.database,
    outputs,
    curated,
    tags,
    ships: k === 0,
    repo,
  });
  all.releases.push(...a.releases);
  all.issues.push(...a.issues);
  all.dispatch ||= a.dispatch;
  all.summary.push(...a.summary);
}

await writeFile("out/announce.json", JSON.stringify(all, null, 2) + "\n");
await writeFile(
  "out/commit.txt",
  ["Record CHS current results", "", ...all.summary].join("\n") + "\n",
);
console.log(all.summary.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    all.summary.map((l) => `- ${l}`).join("\n") + "\n",
  );
}
