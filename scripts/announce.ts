// Publishes what record.ts decided, after the history is pushed: releases and
// this repository's issues with GH_TOKEN, slackwater-database issues with
// DATABASE_ISSUES_TOKEN, and a follow-up run when a gate needs a backfill.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
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
  target: (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim(),
  results: ghCli(required("GH_TOKEN")),
  database: () => ghCli(required("DATABASE_ISSUES_TOKEN")),
  log: (line) => console.log(line),
});
