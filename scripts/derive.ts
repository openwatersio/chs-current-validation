// Re-derives each history's newest measured claims from the committed rows,
// and reports any that differ from its committed dispositions.json. Pull
// requests run it, so a change to the derivation shows what it moves. It never
// touches IWLS or the CHS cache.
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { disposeGate } from "../src/dispositions.ts";
import { readHistory } from "../src/history.ts";
import { describeFit, readDispositions } from "../src/release.ts";

const root = process.cwd();
const lines: string[] = [];
const stamps = await readdir(join(root, "history")).catch(() => [] as string[]);
for (const stamp of stamps) {
  for (const dir of await readdir(join(root, "history", stamp))) {
    const scorer = Number(dir.replace(/^scorer-/, ""));
    const key = { stamp, scorer };
    const doc = await readDispositions(root, key);
    if (!doc) continue;
    const points = (await readHistory(root, key)).filter((p) => p.grid <= doc.newest.grid);
    for (const [gate, d] of Object.entries(doc.gates)) {
      if (d.status === "pending_backfill") continue;
      const again = disposeGate({ points, gate, baseline: undefined, pending: false });
      if (
        JSON.stringify([d.measured, d.windows]) !== JSON.stringify([again.measured, again.windows])
      ) {
        lines.push(
          `${stamp} scorer ${scorer} ${gate}: ${describeFit(d.measured)} → ${describeFit(again.measured)}`,
        );
      }
    }
  }
}
const text = lines.length ? lines.join("\n") : "The committed dispositions re-derive unchanged.";
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text + "\n");
