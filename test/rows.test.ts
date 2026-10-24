import { describe, expect, test } from "vitest";
import { declaredOnly, suspectFields } from "../src/rows.ts";
import { record, row } from "./builders.ts";

describe("declaredOnly", () => {
  test("passes declared rows and gate records through unchanged", () => {
    const rows = [row()];
    const gates = [record({ failures: [{ grid: 0, fit_days: 60, reason: "refused" }] })];
    expect(declaredOnly(rows, gates)).toEqual({ rows, gates, dropped: [] });
  });

  test("drops every field a row, gate record or failure doesn't declare, and names it", () => {
    const failure = { grid: 0, reason: "refused" };
    const out = declaredOnly(
      [{ ...row(), event_times: ["2026-10-29T07:00:00Z"], note: "x" }],
      [{ ...record({ failures: [failure] }), samples: [1.2, 1.3] }],
    );
    expect(out.rows).toEqual([row()]);
    expect(Object.keys(out.rows[0])).toEqual(Object.keys(row()));
    expect(out.gates).toEqual([record({ failures: [failure] })]);
    expect(out.dropped).toEqual(["gates.samples", "rows.event_times", "rows.note"]);
    const nested = declaredOnly(
      [],
      [
        record({
          failures: [{ ...failure, slack_time: "2026-10-29T09:12:00Z" } as typeof failure],
        }),
      ],
    );
    expect(nested.gates[0].failures).toEqual([failure]);
    expect(nested.dropped).toEqual(["gates.failures.slack_time"]);
  });
});

describe("suspectFields", () => {
  test("names the dropped fields that suggest CHS times or samples", () => {
    expect(
      suspectFields([
        "gates.failures.slack_time",
        "gates.samples",
        "rows.event_count",
        "rows.fit_date",
        "rows.note",
      ]),
    ).toEqual(["gates.failures.slack_time", "gates.samples", "rows.event_count", "rows.fit_date"]);
  });
});
