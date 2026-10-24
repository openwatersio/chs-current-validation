import { describe, expect, test } from "vitest";
import { fileIssues, httpStatus, type Gh } from "../src/github.ts";

function fakeGh(open: { number: number; title: string }[]) {
  const calls: string[] = [];
  const gh: Gh = {
    openIssues: async (repo) => {
      calls.push(`list ${repo}`);
      return open;
    },
    createIssue: async (repo, title) => {
      calls.push(`create ${repo} ${title}`);
    },
    comment: async (repo, number) => {
      calls.push(`comment ${repo} #${number}`);
    },
    releaseExists: async () => false,
    createRelease: async () => {},
    dispatch: async () => {},
  };
  return { gh, calls };
}

describe("httpStatus", () => {
  test("reads the status from gh api --include output", () => {
    expect(
      httpStatus(
        'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}',
      ),
    ).toBe(404);
    expect(httpStatus("HTTP/1.1 200 OK\r\n")).toBe(200);
  });

  test("is undefined when gh never reached the API", () => {
    expect(httpStatus("")).toBeUndefined();
    expect(httpStatus(undefined)).toBeUndefined();
  });
});

describe("fileIssues", () => {
  test("opens an issue, or comments on the open one with the same title", async () => {
    const { gh, calls } = fakeGh([{ number: 7, title: "No rows for chs-a" }]);
    await fileIssues(gh, [
      { repo: "o/r", title: "No rows for chs-a", body: "x" },
      { repo: "o/r", title: "No rows for chs-b", body: "y" },
    ]);
    expect(calls).toEqual(["list o/r", "comment o/r #7", "create o/r No rows for chs-b"]);
  });

  test("merges requests with the same title into one issue", async () => {
    const { gh, calls } = fakeGh([]);
    await fileIssues(gh, [
      { repo: "o/r", title: "No rows for chs-a", body: "x" },
      { repo: "o/r", title: "No rows for chs-a", body: "y" },
    ]);
    expect(calls).toEqual(["list o/r", "create o/r No rows for chs-a"]);
  });
});
