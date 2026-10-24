// Publishes what record.ts decided, after the history is pushed: releases, at
// the commit out/announce.json names, this repository's issues and a
// follow-up run when a gate needs a backfill with GH_TOKEN, then
// slackwater-database issues with DATABASE_ISSUES_TOKEN. Runs with plain node
// and no npm ci: it loads only this repository's code and node: built-ins.
import { readFile } from "node:fs/promises";
import { announce } from "../src/announce.ts";
import { ghCli } from "../src/github.ts";
import type { Announcement } from "../src/run.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const a = JSON.parse(await readFile("out/announce.json", "utf8")) as Announcement;
await announce(a, {
  repo: process.env.GITHUB_REPOSITORY ?? "openwatersio/chs-current-validation",
  results: ghCli(required("GH_TOKEN")),
  database: () => ghCli(required("DATABASE_ISSUES_TOKEN")),
  log: (line) => console.log(line),
});
