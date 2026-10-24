import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  auditCsv,
  describeFit,
  historyCsv,
  readDispositions,
  readReleased,
  releaseNotes,
  releaseTag,
  writeDispositions,
  writeReleased,
  type DispositionsDocument,
} from "../src/release.ts";
import { STAMP, row } from "./builders.ts";

const point = (rows = [row()]) => ({ grid: 0, fitEnd: "2026-10-29", rows, gates: [] });

describe("releaseTag", () => {
  test("numbers runs per fit end and stamp", () => {
    expect(releaseTag("2026-10-29", STAMP, [])).toBe("fit-2026-10-29-8f85912-r1");
    expect(
      releaseTag("2026-10-29", STAMP, [
        "fit-2026-10-29-8f85912-r1",
        "fit-2026-10-29-8f85912-r2",
        "fit-2026-10-29-0000000-r7",
        "fit-2026-10-22-8f85912-r9",
      ]),
    ).toBe("fit-2026-10-29-8f85912-r3");
  });
});

describe("historyCsv", () => {
  test("summarizes each committed week on one line", () => {
    const csv = historyCsv([
      point([
        row({
          slack_errors: [2, null, 6],
          invented: 1,
          extremum_errors: [10],
          speed_errors: [0.1],
          extrema: 4,
          wrong_sign: 1,
        }),
      ]),
    ]);
    expect(csv.split("\n")[0]).toBe(
      "gate,iwls,flood,grid,fit_end,fit_days,offset_days,week_start,status,slacks,missed,invented,slack_median_min,slack_worst_min,extrema,extrema_scored,extremum_median_min,speed_median_kn,wrong_sign",
    );
    expect(csv.split("\n")[1]).toBe(
      "chs-active-pass,07527,45,0,2026-10-29T07:00:00Z,210,0,2026-10-29T07:00:00Z,scored,3,1,1,4,6,4,1,10,0.1,1",
    );
  });
});

describe("auditCsv", () => {
  test("lists each gate's five largest slack errors with what reproduces them", () => {
    const csv = auditCsv(
      [
        point([
          row({ offset_days: 0, slack_errors: [1, 9, 3] }),
          row({ offset_days: 28, slack_errors: [8, null, 7, 2, 10] }),
        ]),
      ],
      ["chs-active-pass"],
    );
    expect(csv.trim().split("\n")).toEqual([
      "gate,fit_days,rank,slack_error_min,grid,fit_end,offset_days,slack_index",
      "chs-active-pass,210,1,10,0,2026-10-29,28,4",
      "chs-active-pass,210,2,9,0,2026-10-29,0,1",
      "chs-active-pass,210,3,8,0,2026-10-29,28,0",
      "chs-active-pass,210,4,7,0,2026-10-29,28,2",
      "chs-active-pass,210,5,3,0,2026-10-29,0,2",
    ]);
  });
});

describe("describeFit and releaseNotes", () => {
  test("says what a gate ships as in a few words", () => {
    expect(describeFit({ tier: "final", days: 60 })).toBe("final, 60 d");
    expect(
      describeFit({
        tier: "bounded",
        days: 210,
        slack_bound_minutes: 35,
        provisional_slack_minutes: 40,
      }),
    ).toBe("bounded 35 min, 210 d, provisional 40 min");
    expect(describeFit({ tier: "online", miss: { clause: "slack_median", value: 18.4 } })).toBe(
      "online (slack_median 18.4)",
    );
    expect(describeFit(undefined)).toBe("none");
  });

  test("says when an online gate passes the bar but not by the promotion margin", () => {
    expect(
      describeFit({
        tier: "online",
        miss: { clause: "slack_worst", value: 44.5, near_bar: true },
      }),
    ).toBe("online (slack_worst 44.5, near the bar)");
    expect(
      describeFit({ tier: "online", miss: { clause: "peak_speed", value: null, near_bar: true } }),
    ).toBe("online (peak_speed unmeasured, near the bar)");
  });

  test("names the recipe and lists every gate", () => {
    const doc: DispositionsDocument = {
      release: "fit-2026-10-29-8f85912-r1",
      stamp: STAMP,
      engine: "abcdef0123456789",
      scorer: 2,
      database: "1.0.0-beta.20261017",
      newest: { grid: 0, fit_end: "2026-10-29" },
      pooled: ["2025-11-13", "2026-10-29"],
      gates: {
        "chs-active-pass": {
          status: "fresh",
          chs_fit: { tier: "final", days: 60 },
          measured: { tier: "final", days: 60 },
        },
      },
    };
    const notes = releaseNotes({ doc, added: ["2026-10-29"], backfilled: [] });
    expect(notes).toContain("`8f85912ce223`");
    expect(notes).toContain("openwatersio/slackwater@abcdef0");
    expect(notes).toContain("| chs-active-pass | final, 60 d | fresh | final, 60 d |");
  });
});

describe("dispositions and releases on disk", () => {
  test("round-trips the newest dispositions and the released tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-"));
    const key = { stamp: STAMP, scorer: 2 };
    expect(await readDispositions(root, key)).toBeUndefined();
    expect(await readReleased(root, key)).toEqual([]);
    const doc = {
      release: "r",
      stamp: STAMP,
      engine: "e",
      scorer: 2,
      database: "d",
      newest: { grid: 0, fit_end: "2026-10-29" },
      pooled: [],
      gates: {},
    };
    await writeDispositions(root, key, doc);
    await writeReleased(root, key, ["fit-2026-10-29-8f85912-r1"]);
    expect(await readDispositions(root, key)).toEqual(doc);
    expect(await readReleased(root, key)).toEqual(["fit-2026-10-29-8f85912-r1"]);
  });
});
