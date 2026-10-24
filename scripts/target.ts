// Records the commit the publish job pushed as the target of the run's
// releases, in out/announce.json, so announce, or a later announce from the
// announce artifact, tags the history commit the releases were built from.
// Usage: node scripts/target.ts <commit>
import { readFile, writeFile } from "node:fs/promises";
import { withTarget } from "../src/announce.ts";
import type { Announcement } from "../src/run.ts";

const path = "out/announce.json";
const a = JSON.parse(await readFile(path, "utf8")) as Announcement;
await writeFile(path, JSON.stringify(withTarget(a, process.argv[2] ?? ""), null, 2) + "\n");
