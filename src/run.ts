// Records one target's run into its history and decides what to announce: the
// grid points that commit, the gates a backfill re-scored, each gate's
// disposition, the release and the issues.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareClaims } from "./claims.ts";
import {
  byGridPoint,
  checkComplete,
  committable,
  latestRecords,
  replaceGates,
  sharedStations,
  stationChanges,
} from "./commit.ts";
import { baselineClaim, claimOf, shippedClaim, type CuratedGate } from "./curated.ts";
import { POOLED_GRID_POINTS } from "./derive.ts";
import { disposeGate, type GateDisposition } from "./dispositions.ts";
import type { IssueRequest } from "./github.ts";
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

export const DATABASE_REPO = "openwatersio/slackwater-database";

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

const noRowsReason = (g: GateRecord) =>
  g.reason ?? (g.failures ?? []).map((f) => f.reason).join("; ");

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
  const { commit, stopped } = committable(byGridPoint(outputs.rows, outputs.gates, candidates), {
    gates: new Map(input.gates.map((g) => [g.id, windowsFor(g.id)])),
    offsets: plan.offsets,
  });
  const added: GridPoint[] = commit.map((p) => ({ ...p, fitEnd: p.rows[0].fit_end.slice(0, 10) }));

  // Backfilled gates over grid points already committed.
  const backfillGrid = new Set(backfill.size ? plan.backfillGrid : []);
  const owedBackfill = {
    gates: new Map([...backfill].map((id) => [id, FULL_WINDOWS])),
    offsets: plan.offsets,
  };
  const rescoredGrids = new Set<number>();
  const updated = history.map((point) => {
    if (!backfillGrid.has(point.grid)) return point;
    const [fresh] = byGridPoint(
      outputs.rows.filter((r) => backfill.has(r.gate)),
      outputs.gates.filter((g) => backfill.has(g.gate)),
      [point.grid],
    );
    checkComplete(fresh, owedBackfill);
    const next = replaceGates(point, fresh, backfill);
    // Count only changed points, so the same backfill recorded twice changes nothing.
    if (!sameFiles(next, point)) rescoredGrids.add(point.grid);
    return next;
  });

  // What changed under the gates scored as usual since their last record.
  const changes = stationChanges(
    latestRecords(history),
    outputs.gates.filter((g) => !backfill.has(g.gate)),
  );
  const flagged = [
    ...new Set([
      ...state.needs_backfill.filter((id) => !backfill.has(id)),
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
    say(`re-scored ${[...backfill].join(", ")} over ${rescoredGrids.size} grid points`);
  if (stopped) say(`grid point ${stopped.grid} waits: ${stopped.reason}`);

  for (const p of added) {
    for (const g of p.gates) {
      if (p.rows.some((r) => r.gate === g.gate)) continue;
      out.issues.push({
        repo: input.repo,
        title: `No rows for ${g.gate}`,
        body: `Grid point ${p.grid}, the fit ending ${p.fitEnd}, has no rows for \`${g.gate}\`: ${noRowsReason(g)}.`,
      });
    }
  }
  // A backfilled gate with no rows, such as a new gate with no IWLS station nearby, gets an issue too.
  const backfilled = updated.filter((p) => backfillGrid.has(p.grid));
  const newestBackfilled = backfilled.at(-1);
  if (rescoredGrids.size && newestBackfilled) {
    for (const g of newestBackfilled.gates) {
      if (!backfill.has(g.gate)) continue;
      if (backfilled.some((p) => p.rows.some((r) => r.gate === g.gate))) continue;
      out.issues.push({
        repo: input.repo,
        title: `No rows for ${g.gate}`,
        body: `A backfill re-scored \`${g.gate}\` over the fits ending ${backfilled[0].fitEnd} to ${newestBackfilled.fitEnd}, and it has no rows at any of them: ${noRowsReason(g)}.`,
      });
    }
  }
  for (const c of changes) {
    out.issues.push({
      repo: input.repo,
      title:
        c.kind === "revision"
          ? `CHS revised predictions at ${c.gate}`
          : `${c.gate} moved to another IWLS station or flood axis`,
      body: `The ${c.kind === "revision" ? "canary hash" : c.kind === "station" ? "IWLS station" : "flood axis"} for \`${c.gate}\` changed from \`${c.from}\` to \`${c.to}\`. Its rows no longer pool with its history, so a follow-up run re-scores it over the newest grid points, and its disposition carries over until then.`,
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
  const tag = releaseTag(newest.fitEnd, plan.stamp, input.tags);
  const released = await readReleased(root, key);
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
      backfilled: rescoredGrids.size ? [...backfill] : [],
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
    for (const [id, d] of Object.entries(gates)) {
      if (!d.chs_fit) continue;
      const shipped = input.curated.get(id)?.chs_fit;
      if (compareClaims(claimOf(d.chs_fit), shippedClaim(input.curated.get(id))) <= 0) continue;
      out.issues.push({
        repo: DATABASE_REPO,
        title: `Update chs_fit for ${id}`,
        body: [
          `The CHS current validation release [${tag}](https://github.com/${input.repo}/releases/tag/${tag}) gives \`${id}\` a weaker claim than the one it ships.`,
          "",
          `- Ships: ${shipped ? describeFit(shipped) : "online, unmeasured"}`,
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
