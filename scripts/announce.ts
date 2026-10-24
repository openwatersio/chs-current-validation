// Publishes what record.ts decided, after the history is pushed: releases and
// this repository's issues with GH_TOKEN, slackwater-database issues with
// DATABASE_ISSUES_TOKEN, and a follow-up run when a gate needs a backfill.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileIssues, ghCli } from "../src/github.ts";
import { DATABASE_REPO, type Announcement } from "../src/run.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const a = JSON.parse(await readFile("out/announce.json", "utf8")) as Announcement;
const repo = process.env.GITHUB_REPOSITORY ?? "openwatersio/chs-current-validation";
const results = ghCli(required("GH_TOKEN"));
const head = (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim();

for (const r of a.releases) {
  await results.createRelease(repo, r.tag, head, r.title, r.notesFile, r.files);
}
await fileIssues(
  results,
  a.issues.filter((i) => i.repo === repo),
);
const forDatabase = a.issues.filter((i) => i.repo === DATABASE_REPO);
if (forDatabase.length) await fileIssues(ghCli(required("DATABASE_ISSUES_TOKEN")), forDatabase);
if (a.dispatch) await results.dispatch(repo, "results.yml");
