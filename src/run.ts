// Records one target's run into its history and decides what to announce: the
// grid points that commit, the gates a backfill re-scored, each gate's
// disposition, the release and the issues.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareClaims, supports, type Claim } from "./claims.ts";
import {
  byGridPoint,
  checkComplete,
  committable,
  latestRecords,
  newestHorizon,
  replaceGates,
  sharedStations,
  stationChanges,
  waitsForHorizon,
} from "./commit.ts";
import { baselineClaim, claimOf, shippedClaim, type CuratedGate } from "./curated.ts";
import { NO_MARGIN, POOLED_GRID_POINTS, RECIPE_WINDOWS } from "./derive.ts";
import { disposeGate, type GateDisposition } from "./dispositions.ts";
import { DATABASE_REPO, type IssueRequest } from "./github.ts";
import {
  gridPointFiles,
  readHistory,
  readState,
  writeGridPoint,
  writeState,
  type GridPoint,
} from "./history.ts";
import {
  FULL_WINDOWS,
  MONTHLY_WINDOWS,
  SEED_GRID_POINTS,
  type GateInput,
  type TargetPlan,
} from "./plan.ts";
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
} from "./release.ts";
import type { GateRecord, ResultRow } from "./rows.ts";

export interface Outputs {
  rows: ResultRow[];
  gates: GateRecord[];
}

export interface ReleaseRequest {
  tag: string;
  title: string;
  notesFile: string;
  files: string[];
}

export interface Announcement {
  releases: ReleaseRequest[];
  issues: IssueRequest[];
  dispatch: boolean;
  summary: string[];
}

function sameFiles(a: GridPoint, b: GridPoint): boolean {
  const x = gridPointFiles(a);
  const y = gridPointFiles(b);
  return x.rows === y.rows && x.gates === y.gates;
}

/** A backfilled gate at a committed grid point where some recipe window scored no week. */
interface Unscored {
  fitEnd: string;
  /** The recipe windows with no scored week. */
  windows: number[];
  record: GateRecord;
  /** The gate's rows in those windows. */
  rows: ResultRow[];
}

const noRowsReason = (g: GateRecord) =>
  g.reason ?? (g.failures ?? []).map((f) => f.reason).join("; ");

/** A gate's rows at one grid point, none of them scored, counted by status. */
function statusReason(rows: readonly ResultRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const parts = [...counts].map(([status, n]) => `${n} \`${status}\``);
  return `its ${rows.length} rows are ${parts.join(" and ")}`;
}

/** Whether a gate has no scored week at a grid point only because its own horizon lags the newest, which is its recorded reason and which a later year fixes. */
function lagsHorizon(
  g: GateRecord,
  rows: readonly ResultRow[],
  newest: string | undefined,
): boolean {
  return (
    rows.length > 0 &&
    rows.every((r) => r.status === "beyond_horizon") &&
    !g.reason &&
    !g.failures?.length &&
    g.horizon !== undefined &&
    newest !== undefined &&
    g.horizon < newest
  );
}

/** Why slackwater-database should update what a gate ships, or undefined when the shipped claim stands. */
function updateReason(
  id: string,
  d: GateDisposition,
  shipped: Claim,
  release: string,
): string | undefined {
  if (!d.chs_fit) {
    // A gate waiting on a backfill carries its claim until the backfill lands.
    if (d.status !== "insufficient" || shipped.tier === "online") return undefined;
    return `In the CHS current validation release ${release}, \`${id}\` has no scored week to support the claim it ships: ${d.note}.`;
  }
  // A gate curated afresh can rank stronger than what it ships while the shipped claim is false.
  const holds = !d.windows || supports(d.windows, shipped, NO_MARGIN);
  const weaker = compareClaims(claimOf(d.chs_fit), shipped) > 0;
  if (holds && !weaker) return undefined;
  return holds
    ? `The CHS current validation release ${release} gives \`${id}\` a weaker claim than the one it ships.`
    : `In the newest year of the CHS current validation release ${release}, the claim \`${id}\` ships no longer holds.${weaker ? " The release's own claim is weaker too." : ""}`;
}

export async function recordTarget(input: {
  root: string;
  outDir: string;
  plan: TargetPlan;
  gates: GateInput[];
  database: string;
  outputs: Outputs;
  curated: ReadonlyMap<string, CuratedGate>;
  tags: readonly string[];
  /** Whether this is the target the apps ship, whose demotions go to slackwater-database. */
  ships: boolean;
  repo: string;
}): Promise<Announcement> {
  const { root, plan, outputs } = input;
  const key = { stamp: plan.stamp, scorer: plan.scorer };
  const out: Announcement = { releases: [], issues: [], dispatch: false, summary: [] };
  const say = (line: string) => out.summary.push(`${plan.stamp}: ${line}`);
  // Per-gate issue titles are shared by every target, so each body names its history.
  const inHistory = `in the history for recipe stamp \`${plan.stamp.slice(0, 7)}\`, scorer ${plan.scorer}`;

  const stray = outputs.rows.find((r) => r.stamp !== plan.stamp || r.scorer !== plan.scorer);
  if (stray) {
    throw new Error(
      `a row for ${stray.gate} carries stamp ${stray.stamp}, scorer ${stray.scorer}, not ${plan.stamp}, scorer ${plan.scorer}`,
    );
  }
  const shared = sharedStations(outputs.gates);
  if (shared.length)
    throw new Error(`gates resolved to the same IWLS station: ${shared.join(", ")}`);

  const history = await readHistory(root, key);
  const state = await readState(root, key);
  const backfill = new Set(plan.backfill);
  const windowsFor = (id: string) =>
    plan.mode === "seed" || backfill.has(id) ? FULL_WINDOWS : MONTHLY_WINDOWS;

  // Only grid points past the newest committed, so recording the same plan twice commits nothing.
  const last = history.at(-1)?.grid;
  const candidates = plan.candidates.filter((g) => last === undefined || g > last);
  if (last !== undefined && candidates.length && candidates[0] !== last + 1) {
    throw new Error(
      `the plan's first new grid point is ${candidates[0]}, but the history ends at grid point ${last}`,
    );
  }
  const { commit, stopped } = committable(byGridPoint(outputs.rows, outputs.gates, candidates), {
    gates: new Map(input.gates.map((g) => [g.id, windowsFor(g.id)])),
    offsets: plan.offsets,
  });
  const added: GridPoint[] = commit.map((p) => ({ ...p, fitEnd: p.rows[0].fit_end.slice(0, 10) }));

  // Backfilled gates over grid points already committed. A gate's committed
  // rows give way only where its backfill scored a week in each recipe window,
  // so a backfill that fails never loses the evidence its dispositions use.
  const backfillGrid = new Set(backfill.size ? plan.backfillGrid : []);
  const owedBackfill = {
    gates: new Map([...backfill].map((id) => [id, FULL_WINDOWS])),
    offsets: plan.offsets,
  };
  const rescoredGrids = new Set<number>();
  const replaced = new Set<string>();
  const unscored = new Map<string, Unscored[]>();
  const updated = history.map((point) => {
    if (!backfillGrid.has(point.grid)) return point;
    const [fresh] = byGridPoint(
      outputs.rows.filter((r) => backfill.has(r.gate)),
      outputs.gates.filter((g) => backfill.has(g.gate)),
      [point.grid],
    );
    checkComplete(fresh, owedBackfill);
    const scoredHere = new Set<string>();
    for (const id of backfill) {
      // The 365-day window is report-only, so its failure never holds back a replace.
      const windows: number[] = RECIPE_WINDOWS.filter(
        (days) =>
          !fresh.rows.some((r) => r.gate === id && r.fit_days === days && r.status === "scored"),
      );
      if (!windows.length) {
        scoredHere.add(id);
        replaced.add(id);
        continue;
      }
      unscored.set(id, [
        ...(unscored.get(id) ?? []),
        {
          fitEnd: point.fitEnd,
          windows,
          // checkComplete has made sure every backfilled gate has a record here.
          record: fresh.gates.find((g) => g.gate === id)!,
          rows: fresh.rows.filter((r) => r.gate === id && windows.includes(r.fit_days)),
        },
      ]);
    }
    const next = replaceGates(point, fresh, scoredHere);
    // The run's own records can't show a clash with a gate it didn't score.
    const sharedHere = sharedStations(next.gates);
    if (sharedHere.length) {
      throw new Error(
        `grid point ${point.grid}: gates resolved to the same IWLS station: ${sharedHere.join(", ")}`,
      );
    }
    // Count only changed points, so the same backfill recorded twice changes nothing.
    if (!sameFiles(next, point)) rescoredGrids.add(point.grid);
    return next;
  });

  // What changed under the gates scored as usual since their last record.
  const changes = stationChanges(
    latestRecords(history),
    outputs.gates.filter((g) => !backfill.has(g.gate)),
  );
  // A gate gone from the database is never planned again, so its flag would otherwise stay forever.
  const planned = new Set(input.gates.map((g) => g.id));
  const stale = state.needs_backfill.filter((id) => !planned.has(id));
  // A flagged gate stays flagged until a backfill scores both recipe windows at every grid point it covers, so its disposition never pools two stations.
  const flagged = [
    ...new Set([
      ...state.needs_backfill.filter(
        (id) => planned.has(id) && (!backfill.has(id) || unscored.has(id)),
      ),
      ...changes.map((c) => c.gate),
    ]),
  ].sort();
  const stateChanged = flagged.join() !== [...state.needs_backfill].sort().join();
  const points = [...updated, ...added];

  for (const p of updated) if (rescoredGrids.has(p.grid)) await writeGridPoint(root, key, p);
  for (const p of added) await writeGridPoint(root, key, p);
  if (stateChanged) await writeState(root, key, { needs_backfill: flagged });

  if (added.length) say(`committed fit ends ${added.map((p) => p.fitEnd).join(", ")}`);
  if (rescoredGrids.size)
    say(`re-scored ${[...replaced].join(", ")} over ${rescoredGrids.size} grid points`);
  if (stopped) say(`grid point ${stopped.grid} waits: ${stopped.reason}`);
  if (stale.length) {
    say(`dropped ${stale.join(", ")} from needs_backfill: no longer among the fitted gates`);
  }

  // CHS's horizon moves on by itself; any other stop would hold the history back every month, unseen.
  if (stopped && !waitsForHorizon(stopped.reason)) {
    const fitEnd = outputs.rows.find((r) => r.grid === stopped.grid)?.fit_end.slice(0, 10);
    const failures = [
      ...new Set(
        outputs.gates.flatMap((g) =>
          (g.failures ?? []).filter((f) => f.grid === stopped.grid).map((f) => f.reason),
        ),
      ),
    ];
    out.issues.push({
      repo: input.repo,
      // Grid indices are shared across histories, so the issue names the one that stopped.
      title: `Grid point ${stopped.grid} can't commit for ${plan.stamp.slice(0, 7)} scorer ${plan.scorer}`,
      body: [
        `Grid point ${stopped.grid}${fitEnd ? `, the fit ending ${fitEnd},` : ""} can't commit for recipe stamp \`${plan.stamp}\`, scorer ${plan.scorer}: ${stopped.reason}. No later grid point in that history commits until it does. Each run scores it again and comments here while it still can't.`,
        ...(failures.length ? ["", `Gate failures recorded there: ${failures.join("; ")}.`] : []),
      ].join("\n"),
    });
  }

  for (const p of added) {
    const newest = newestHorizon(p.gates);
    for (const g of p.gates) {
      const rows = p.rows.filter((r) => r.gate === g.gate);
      if (rows.some((r) => r.status === "scored")) continue;
      if (lagsHorizon(g, rows, newest)) continue;
      const reason = [noRowsReason(g), rows.length ? statusReason(rows) : ""]
        .filter(Boolean)
        .join("; ");
      out.issues.push({
        repo: input.repo,
        title: `No rows for ${g.gate}`,
        body: `Grid point ${p.grid} ${inHistory}, the fit ending ${p.fitEnd}, has no scored rows for \`${g.gate}\`: ${reason}.`,
      });
    }
  }
  // A backfilled gate missing a recipe window at a committed grid point, such as a new gate with no IWLS station nearby.
  for (const [id, missed] of unscored) {
    const newest = missed[missed.length - 1];
    const { record } = newest;
    const failures = (record.failures ?? []).filter(
      (f) => f.fit_days === undefined || newest.windows.includes(f.fit_days),
    );
    const reason = [
      record.reason ?? failures.map((f) => f.reason).join("; "),
      newest.rows.length ? statusReason(newest.rows) : "",
    ]
      .filter(Boolean)
      .join("; ");
    const flagNote = flagged.includes(id)
      ? " It stays flagged for a backfill, so its disposition carries over and the next run tries again."
      : "";
    const windows = newest.windows.map((days) => `${days}-day`).join(" or ");
    out.issues.push({
      repo: input.repo,
      title: `Backfill of ${id} failed`,
      body: `A backfill ${inHistory} re-scored \`${id}\` but didn't score a week in every recipe window at the fits ending ${missed.map((m) => m.fitEnd).join(", ")}, so the history keeps what it had for it there.${flagNote} At the fit ending ${newest.fitEnd}, it scored no ${windows} week: ${reason}.`,
    });
  }
  for (const c of changes) {
    out.issues.push({
      repo: input.repo,
      title:
        c.kind === "revision"
          ? `CHS revised predictions at ${c.gate}`
          : `${c.gate} moved to another IWLS station or flood axis`,
      body: `The ${c.kind === "revision" ? "canary hash" : c.kind === "station" ? "IWLS station" : "flood axis"} for \`${c.gate}\` changed from \`${c.from}\` to \`${c.to}\` ${inHistory}. Its new rows no longer pool with its earlier ones, so a follow-up run re-scores it over the newest grid points, and its disposition carries over until then.`,
    });
  }
  if (changes.length) out.dispatch = true;

  const changed = added.length > 0 || rescoredGrids.size > 0 || stateChanged;
  if (!changed) {
    say("nothing changed");
    return out;
  }
  if (points.length < SEED_GRID_POINTS) {
    say(`${points.length} of ${SEED_GRID_POINTS} grid points committed, so no release yet`);
    return out;
  }

  const newest = points[points.length - 1];
  const released = await readReleased(root, key);
  // A release whose announce failed is in releases.json but not yet a git tag.
  const tag = releaseTag(newest.fitEnd, plan.stamp, [...input.tags, ...released]);
  const previousDoc = await readDispositions(root, key);
  const pending = new Set(flagged);
  const gates: Record<string, GateDisposition> = {};
  for (const g of input.gates) {
    gates[g.id] = disposeGate({
      points,
      gate: g.id,
      baseline: baselineClaim(input.curated.get(g.id), new Set(released)),
      pending: pending.has(g.id),
      carried: previousDoc?.gates[g.id],
    });
  }
  const doc: DispositionsDocument = {
    release: tag,
    stamp: plan.stamp,
    engine: plan.engine,
    scorer: plan.scorer,
    database: input.database,
    newest: { grid: newest.grid, fit_end: newest.fitEnd },
    pooled: points.slice(-POOLED_GRID_POINTS).map((p) => p.fitEnd),
    gates,
  };
  await writeDispositions(root, key, doc);
  await writeReleased(root, key, [...released, tag]);

  const dir = join(input.outDir, tag);
  await mkdir(dir, { recursive: true });
  const files = {
    dispositions: join(dir, "dispositions.json"),
    history: join(dir, "history.csv"),
    audit: join(dir, "audit.csv"),
    notes: join(dir, "notes.md"),
  };
  await writeFile(files.dispositions, JSON.stringify(doc, null, 2) + "\n");
  await writeFile(files.history, historyCsv(points));
  await writeFile(
    files.audit,
    auditCsv(
      points,
      input.gates.map((g) => g.id),
    ),
  );
  await writeFile(
    files.notes,
    releaseNotes({
      doc,
      added: added.map((p) => p.fitEnd),
      backfilled: rescoredGrids.size ? [...replaced] : [],
      ...(stopped ? { waiting: stopped.reason } : {}),
    }),
  );
  out.releases.push({
    tag,
    title: `CHS current results ${tag}`,
    notesFile: files.notes,
    files: [files.dispositions, files.history, files.audit],
  });
  say(`release ${tag}`);

  if (input.ships) {
    const release = `[${tag}](https://github.com/${input.repo}/releases/tag/${tag})`;
    for (const [id, d] of Object.entries(gates)) {
      const curatedFit = input.curated.get(id)?.chs_fit;
      const why = updateReason(id, d, shippedClaim(input.curated.get(id)), release);
      if (!why) continue;
      out.issues.push({
        repo: DATABASE_REPO,
        title: `Update chs_fit for ${id}`,
        body: [
          why,
          "",
          `- Ships: ${curatedFit ? describeFit(curatedFit) : "online, unmeasured"}`,
          `- Release: ${describeFit(d.chs_fit)} (${d.status})`,
          `- Newest year alone: ${describeFit(d.measured)}`,
          "",
          `Curate it from the release's \`dispositions.json\`, with \`evidence: ${tag}\`.`,
        ].join("\n"),
      });
    }
  }
  return out;
}
