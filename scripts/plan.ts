// Plans a results run. Reads targets.json, each target's history, the newest
// @slackwater/database (installed by the workflow without saving it), and each
// target's engine benchmarks checked out under engines/<stamp>/. Writes
// out/plan.json and, under GitHub Actions, the score job's matrix.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readHistory, readState } from "../src/history.ts";
import { fittedGates, planTarget, requestedBackfill, type Target } from "../src/plan.ts";

const root = process.cwd();
const targets = JSON.parse(await readFile("targets.json", "utf8")) as Target[];
// Installed at run time, never pinned, so the specifier is not a literal.
const databaseModule = "@slackwater/database";
const { stations } = await import(databaseModule);
const database = (
  JSON.parse(await readFile("node_modules/@slackwater/database/package.json", "utf8")) as {
    version: string;
  }
).version;
const fitted = fittedGates(stations);
// An empty list, as after a rename of the source name or kind, would plan a run that looks up to date.
if (!fitted.length) {
  throw new Error(`@slackwater/database ${database} has no fitted CHS current gates`);
}
const requested = requestedBackfill(process.env.BACKFILL ?? "", fitted);
let gates = fitted;
if (process.env.ONLY_GATES) {
  const only = new Set(process.env.ONLY_GATES.split(","));
  gates = gates.filter((g) => only.has(g.id));
}
const today = process.env.TODAY ?? new Date().toISOString().slice(0, 10);

const plans = [];
for (const target of targets) {
  const dir = join(root, "engines", target.stamp, "benchmarks");
  const grid = await import(pathToFileURL(join(dir, "chs-current-grid.ts")).href);
  const { SCORER_VERSION } = await import(pathToFileURL(join(dir, "chs-current-score.ts")).href);
  const key = { stamp: target.stamp, scorer: SCORER_VERSION as number };
  const history = await readHistory(root, key);
  const state = await readState(root, key);
  plans.push(
    planTarget({
      target,
      scorer: key.scorer,
      offsets: [...(grid.OFFSET_DAYS as readonly number[])],
      committed: history.map((p) => p.grid),
      known: new Set(history.at(-1)?.gates.map((g) => g.gate) ?? []),
      gates,
      backfill: requested === "all" ? "all" : [...state.needs_backfill, ...requested],
      today,
      grid,
    }),
  );
}

await mkdir("out", { recursive: true });
await writeFile("out/plan.json", JSON.stringify({ database, today, gates, plans }, null, 2) + "\n");
const matrix = plans.flatMap((p) =>
  p.shards.map((s) => ({
    stamp: p.stamp,
    engine: p.engine,
    shard: s.id,
    grid: s.grid,
    windows: s.windows,
    gates: JSON.stringify(s.gates),
  })),
);
for (const p of plans) {
  console.log(
    `${p.stamp} scorer ${p.scorer}: ${p.mode}, grid points ${p.candidates.join(", ") || "none"}, backfill ${p.backfill.join(", ") || "none"}, ${p.shards.length} shards`,
  );
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify(matrix)}\nhas_work=${matrix.length > 0}\n`,
  );
}
