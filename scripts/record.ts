// Records a results run: reads out/plan.json, the score jobs' outputs under
// shards/, the curated station files under database/, and this checkout's
// release tags; writes the history, out/announce.json and out/commit.txt.
import { execFile } from "node:child_process";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readCurated } from "../src/curated.ts";
import type { GateInput, TargetPlan } from "../src/plan.ts";
import { parseJsonl, type GateRecord, type ResultRow } from "../src/rows.ts";
import { recordTarget, type Announcement, type Outputs } from "../src/run.ts";

const plan = JSON.parse(await readFile("out/plan.json", "utf8")) as {
  database: string;
  gates: GateInput[];
  plans: TargetPlan[];
};
const curated = await readCurated(process.env.DATABASE_STATIONS ?? "database/stations/current/ca");
const { stdout } = await promisify(execFile)("git", ["tag", "--list", "fit-*"]);
const tags = stdout.split("\n").filter(Boolean);
const repo = process.env.GITHUB_REPOSITORY ?? "openwatersio/chs-current-validation";

async function readShards(dir: string, target: TargetPlan): Promise<Outputs> {
  const names = (await readdir(dir)).filter((n) => n.startsWith(`shard-${target.stamp}-`)).sort();
  if (names.length !== target.shards.length) {
    throw new Error(
      `${target.stamp}: ${names.length} shard outputs for ${target.shards.length} shards`,
    );
  }
  const outputs: Outputs = { rows: [], gates: [] };
  for (const name of names) {
    outputs.rows.push(
      ...parseJsonl<ResultRow>(await readFile(join(dir, name, "chs-current-fit.jsonl"), "utf8")),
    );
    outputs.gates.push(
      ...parseJsonl<GateRecord>(await readFile(join(dir, name, "chs-current-gates.jsonl"), "utf8")),
    );
  }
  return outputs;
}

const all: Announcement = { releases: [], issues: [], dispatch: false, summary: [] };
for (const [k, target] of plan.plans.entries()) {
  if (!target.shards.length) {
    all.summary.push(`${target.stamp}: nothing to score`);
    continue;
  }
  const a = await recordTarget({
    root: process.cwd(),
    outDir: "out/releases",
    plan: target,
    gates: plan.gates,
    database: plan.database,
    outputs: await readShards("shards", target),
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
