// The GitHub side of a run, through the gh CLI the runner provides: releases,
// issues and the follow-up dispatch. Each token writes only where it may.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DATABASE_REPO = "openwatersio/slackwater-database";

export interface Gh {
  openIssues(repo: string): Promise<{ number: number; title: string }[]>;
  createIssue(repo: string, title: string, body: string): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  releaseExists(repo: string, tag: string): Promise<boolean>;
  createRelease(
    repo: string,
    tag: string,
    target: string,
    title: string,
    notesFile: string,
    files: readonly string[],
  ): Promise<void>;
  dispatch(repo: string, workflow: string): Promise<void>;
}

export interface IssueRequest {
  repo: string;
  title: string;
  body: string;
}

/** The HTTP status in the first line of `gh api --include` output, or undefined when there is none. */
export function httpStatus(output: string | undefined): number | undefined {
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(output ?? "");
  return status ? Number(status[1]) : undefined;
}

export function ghCli(token: string): Gh {
  const gh = async (args: string[]) =>
    (
      await run("gh", args, {
        env: { ...process.env, GH_TOKEN: token },
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
  return {
    async openIssues(repo) {
      const out = await gh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number,title",
      ]);
      return JSON.parse(out) as { number: number; title: string }[];
    },
    async createIssue(repo, title, body) {
      await gh(["issue", "create", "--repo", repo, "--title", title, "--body", body]);
    },
    async comment(repo, number, body) {
      await gh(["issue", "comment", String(number), "--repo", repo, "--body", body]);
    },
    async releaseExists(repo, tag) {
      try {
        await gh(["api", "--include", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
        return true;
      } catch (error) {
        // gh exits 1 on any HTTP error, so only the status line tells a missing release from a failure.
        if (httpStatus((error as { stdout?: string }).stdout) === 404) return false;
        throw error;
      }
    },
    async createRelease(repo, tag, target, title, notesFile, files) {
      await gh([
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--target",
        target,
        "--title",
        title,
        "--notes-file",
        notesFile,
        ...files,
      ]);
    },
    async dispatch(repo, workflow) {
      await gh(["workflow", "run", workflow, "--repo", repo]);
    },
  };
}

/** Opens each issue, or comments on the open issue with the same title, so each subject has one open issue. Requests with the same title merge. */
export async function fileIssues(gh: Gh, requests: readonly IssueRequest[]): Promise<void> {
  const merged = new Map<string, IssueRequest>();
  for (const r of requests) {
    const key = `${r.repo}\n${r.title}`;
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, body: `${prior.body}\n\n${r.body}` } : r);
  }
  const open = new Map<string, Map<string, number>>();
  for (const r of merged.values()) {
    if (!open.has(r.repo)) {
      open.set(r.repo, new Map((await gh.openIssues(r.repo)).map((i) => [i.title, i.number])));
    }
    const existing = open.get(r.repo)!.get(r.title);
    if (existing !== undefined) await gh.comment(r.repo, existing, r.body);
    else await gh.createIssue(r.repo, r.title, r.body);
  }
}
