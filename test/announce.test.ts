import { describe, expect, test } from "vitest";
import { announce } from "../src/announce.ts";
import type { Gh } from "../src/github.ts";
import { DATABASE_REPO, type Announcement } from "../src/run.ts";

const REPO = "openwatersio/chs-current-validation";
const PUBLISHED = "fit-2026-10-29-8f85912-r1";
const NEW = "fit-2026-10-29-3f9c2a1-r1";

/** A Gh that logs each call under `name`; `existing` lists the releases already published. */
function fakeGh(name: string, calls: string[], existing: readonly string[] = []): Gh {
  return {
    openIssues: async (repo) => {
      calls.push(`${name} list ${repo}`);
      return [];
    },
    createIssue: async (repo, title) => {
      calls.push(`${name} create ${repo} ${title}`);
    },
    comment: async (repo, number) => {
      calls.push(`${name} comment ${repo} #${number}`);
    },
    releaseExists: async (_repo, tag) => existing.includes(tag),
    createRelease: async (repo, tag, target) => {
      calls.push(`${name} release ${repo} ${tag} at ${target}`);
    },
    dispatch: async (repo, workflow) => {
      calls.push(`${name} dispatch ${repo} ${workflow}`);
    },
  };
}

const release = (tag: string) => ({
  tag,
  title: `CHS current results ${tag}`,
  notesFile: `out/releases/${tag}/notes.md`,
  files: [],
});

const announcement: Announcement = {
  releases: [release(PUBLISHED), release(NEW)],
  issues: [
    { repo: REPO, title: "CHS revised predictions at chs-b", body: "b" },
    { repo: DATABASE_REPO, title: "Update chs_fit for chs-a", body: "a" },
  ],
  dispatch: true,
  summary: [],
};

describe("announce", () => {
  test("skips a release that already exists, and still files the issues and dispatches", async () => {
    const calls: string[] = [];
    const log: string[] = [];
    await announce(announcement, {
      repo: REPO,
      target: "abc123",
      results: fakeGh("results", calls, [PUBLISHED]),
      database: () => fakeGh("database", calls),
      log: (line) => log.push(line),
    });
    expect(calls).toEqual([
      `results release ${REPO} ${NEW} at abc123`,
      `results list ${REPO}`,
      `results create ${REPO} CHS revised predictions at chs-b`,
      `results dispatch ${REPO} results.yml`,
      `database list ${DATABASE_REPO}`,
      `database create ${DATABASE_REPO} Update chs_fit for chs-a`,
    ]);
    expect(log).toContain(`${PUBLISHED} already exists, so it is skipped`);
  });

  test("dispatches the follow-up before a slackwater-database token failure", async () => {
    const calls: string[] = [];
    await expect(
      announce(announcement, {
        repo: REPO,
        target: "abc123",
        results: fakeGh("results", calls),
        database: () => {
          throw new Error("DATABASE_ISSUES_TOKEN is not set");
        },
        log: () => {},
      }),
    ).rejects.toThrow("DATABASE_ISSUES_TOKEN is not set");
    expect(calls).toContain(`results dispatch ${REPO} results.yml`);
  });

  test("needs no slackwater-database client when no issue is for it", async () => {
    const calls: string[] = [];
    await announce(
      { ...announcement, issues: [], dispatch: false },
      {
        repo: REPO,
        target: "abc123",
        results: fakeGh("results", calls),
        database: () => {
          throw new Error("DATABASE_ISSUES_TOKEN is not set");
        },
        log: () => {},
      },
    );
    expect(calls).toEqual([
      `results release ${REPO} ${PUBLISHED} at abc123`,
      `results release ${REPO} ${NEW} at abc123`,
    ]);
  });
});
