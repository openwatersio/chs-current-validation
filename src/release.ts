// What a results release carries: each gate's disposition, the history CSV and
// the audit rows, with its tag and notes.
import { join } from "node:path";
import type { ChsFit } from "./claims.ts";
import { median } from "./derive.ts";
import { pooledRows, type GateDisposition } from "./dispositions.ts";
import { historyDir, readJson, writeJson, type GridPoint, type HistoryKey } from "./history.ts";

export interface DispositionsDocument {
  release: string;
  stamp: string;
  /** The openwatersio/slackwater commit that scored the newest grid point. */
  engine: string;
  scorer: number;
  /** The @slackwater/database version whose gates were scored. */
  database: string;
  newest: { grid: number; fit_end: string };
  /** The fit ends of the pooled year, oldest first. */
  pooled: string[];
  gates: Record<string, GateDisposition>;
}

export function releaseTag(fitEnd: string, stamp: string, existing: readonly string[]): string {
  const prefix = `fit-${fitEnd}-${stamp.slice(0, 7)}-r`;
  const runs = existing
    .filter((t) => t.startsWith(prefix))
    .map((t) => Number(t.slice(prefix.length)))
    .filter(Number.isInteger);
  return `${prefix}${Math.max(0, ...runs) + 1}`;
}

export const readDispositions = (root: string, key: HistoryKey) =>
  readJson<DispositionsDocument>(join(historyDir(root, key), "dispositions.json"));
export const writeDispositions = (root: string, key: HistoryKey, doc: DispositionsDocument) =>
  writeJson(join(historyDir(root, key), "dispositions.json"), doc);
export const readReleased = async (root: string, key: HistoryKey) =>
  (await readJson<string[]>(join(historyDir(root, key), "releases.json"))) ?? [];
export const writeReleased = (root: string, key: HistoryKey, tags: string[]) =>
  writeJson(join(historyDir(root, key), "releases.json"), tags);

const COLUMNS = [
  "gate",
  "iwls",
  "flood",
  "grid",
  "fit_end",
  "fit_days",
  "offset_days",
  "week_start",
  "status",
  "slacks",
  "missed",
  "invented",
  "slack_median_min",
  "slack_worst_min",
  "extrema",
  "extrema_scored",
  "extremum_median_min",
  "speed_median_kn",
  "wrong_sign",
];
// Medians of 0.1-minute errors can carry float noise in the last digits.
const tidy = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
const cell = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "" : String(v);

/** One line per committed week. */
export function historyCsv(points: readonly GridPoint[]): string {
  const lines = [COLUMNS.join(",")];
  for (const p of points) {
    for (const r of p.rows) {
      const scored = r.status === "scored";
      const errors = r.slack_errors ?? [];
      const matched = errors.filter((e): e is number => e !== null);
      lines.push(
        [
          r.gate,
          r.iwls,
          r.flood,
          r.grid,
          r.fit_end,
          r.fit_days,
          r.offset_days,
          r.week_start,
          r.status,
          scored ? errors.length : null,
          scored ? errors.length - matched.length : null,
          r.invented,
          tidy(median(matched)),
          matched.length ? Math.max(...matched) : null,
          r.extrema,
          r.extremum_errors?.length,
          tidy(median(r.extremum_errors ?? [])),
          tidy(median(r.speed_errors ?? [])),
          r.wrong_sign,
        ]
          .map(cell)
          .join(","),
      );
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Each gate's five largest slack errors per window over the pooled year, with
 * the grid point, held-out age and 0-based position among the week's CHS
 * slacks that reproduce each one with the engine's FIT_END.
 */
export function auditCsv(points: readonly GridPoint[], gates: readonly string[]): string {
  const lines = ["gate,fit_days,rank,slack_error_min,grid,fit_end,offset_days,slack_index"];
  for (const gate of gates) {
    const rows = pooledRows(points, points.length - 1, gate).filter((r) => r.status === "scored");
    for (const days of [...new Set(rows.map((r) => r.fit_days))].sort((a, b) => a - b)) {
      const errors = rows
        .filter((r) => r.fit_days === days)
        .flatMap((r) =>
          (r.slack_errors ?? []).flatMap((error, index) =>
            error === null ? [] : [{ error, index, r }],
          ),
        )
        .sort(
          (a, b) =>
            b.error - a.error ||
            a.r.grid - b.r.grid ||
            a.r.offset_days - b.r.offset_days ||
            a.index - b.index,
        );
      errors
        .slice(0, 5)
        .forEach((e, k) =>
          lines.push(
            [
              gate,
              days,
              k + 1,
              e.error,
              e.r.grid,
              e.r.fit_end.slice(0, 10),
              e.r.offset_days,
              e.index,
            ].join(","),
          ),
        );
    }
  }
  return lines.join("\n") + "\n";
}

export function describeFit(fit: ChsFit | undefined): string {
  if (!fit) return "none";
  if (fit.tier === "online") {
    return fit.miss ? `online (${fit.miss.clause} ${fit.miss.value ?? "unmeasured"})` : "online";
  }
  const parts = [
    fit.tier === "bounded" ? `bounded ${fit.slack_bound_minutes} min` : "final",
    `${fit.days} d`,
  ];
  if (fit.provisional_slack_minutes !== undefined) {
    parts.push(`provisional ${fit.provisional_slack_minutes} min`);
  }
  return parts.join(", ");
}

export function releaseNotes(input: {
  doc: DispositionsDocument;
  added: readonly string[];
  backfilled: readonly string[];
  waiting?: string;
}): string {
  const { doc } = input;
  const lines = [
    `Recipe stamp \`${doc.stamp}\`, measured with openwatersio/slackwater@${doc.engine.slice(0, 7)} and scorer version ${doc.scorer} on the CHS current gates in @slackwater/database ${doc.database}. Each disposition pools the year of fit ends from ${doc.pooled[0]} to ${doc.pooled.at(-1)}.`,
    "",
  ];
  if (input.added.length) lines.push(`This run added fit ends ${input.added.join(", ")}.`);
  if (input.backfilled.length) lines.push(`It re-scored ${input.backfilled.join(", ")}.`);
  if (input.waiting) lines.push(`The next grid point waits: ${input.waiting}.`);
  lines.push("", "| Gate | Ships as | Change | Newest year alone |", "| --- | --- | --- | --- |");
  for (const [gate, d] of Object.entries(doc.gates).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `| ${gate} | ${describeFit(d.chs_fit)} | ${d.status} | ${describeFit(d.measured)} |`,
    );
  }
  return lines.join("\n") + "\n";
}
