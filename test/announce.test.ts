import { describe, expect, test } from "vitest";
import { announce, withTarget } from "../src/announce.ts";
import { DATABASE_REPO, type Gh } from "../src/github.ts";
import type { Announcement } from "../src/run.ts";

const REPO = "openwatersio/chs-current-validation";
const PUBLISHED = "fit-2026-10-29-8f85912-r1";
const NEW = "fit-2026-10-29-3f9c2a1-r1";
/** The history commit the publish job pushed. */
const TARGET = "0123456789abcdef0123456789abcdef01234567";

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
  target: TARGET,
};

describe("announce", () => {
  test("tags each new release at the history commit the announcement records", async () => {
    const calls: string[] = [];
    await announce(
      { ...announcement, issues: [], dispatch: false },
      {
        repo: REPO,
        results: fakeGh("results", calls),
        database: () => fakeGh("database", calls),
        log: () => {},
      },
    );
    expect(calls).toEqual([
      `results release ${REPO} ${PUBLISHED} at ${TARGET}`,
      `results release ${REPO} ${NEW} at ${TARGET}`,
    ]);
  });

  test("refuses to release when the announcement records no target, before anything is published", async () => {
    const calls: string[] = [];
    const { target: _, ...untargeted } = announcement;
    await expect(
      announce(untargeted, {
        repo: REPO,
        results: fakeGh("results", calls),
        database: () => fakeGh("database", calls),
        log: () => {},
      }),
    ).rejects.toThrow("out/announce.json names no release target");
    expect(calls).toEqual([]);
  });

  test("skips a release that already exists, and still files the issues and dispatches", async () => {
    const calls: string[] = [];
    const log: string[] = [];
    await announce(announcement, {
      repo: REPO,
      results: fakeGh("results", calls, [PUBLISHED]),
      database: () => fakeGh("database", calls),
      log: (line) => log.push(line),
    });
    expect(calls).toEqual([
      `results release ${REPO} ${NEW} at ${TARGET}`,
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
        results: fakeGh("results", calls),
        database: () => {
          throw new Error("DATABASE_ISSUES_TOKEN is not set");
        },
        log: () => {},
      },
    );
    expect(calls).toEqual([
      `results release ${REPO} ${PUBLISHED} at ${TARGET}`,
      `results release ${REPO} ${NEW} at ${TARGET}`,
    ]);
  });

  test("files issues with no target when there is nothing to release", async () => {
    const calls: string[] = [];
    const { target: _, ...untargeted } = announcement;
    await announce(
      { ...untargeted, releases: [] },
      {
        repo: REPO,
        results: fakeGh("results", calls),
        database: () => fakeGh("database", calls),
        log: () => {},
      },
    );
    expect(calls).toContain(`results create ${REPO} CHS revised predictions at chs-b`);
  });
});

describe("withTarget", () => {
  test("records the commit the releases tag", () => {
    expect(withTarget({ ...announcement, target: undefined }, TARGET).target).toBe(TARGET);
  });

  test("refuses anything but a full commit hash", () => {
    expect(() => withTarget(announcement, "abc123")).toThrow(
      'release target "abc123" is not a full commit hash',
    );
    expect(() => withTarget(announcement, "")).toThrow("is not a full commit hash");
  });
});
