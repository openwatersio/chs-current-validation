// The curated values in slackwater-database: each CHS gate's `chs_fit`, read
// from the station files on its main branch, where curation lands.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Claim, Tier } from "./claims.ts";
import type { Miss } from "./derive.ts";

export interface ChsFitRecord {
  tier: Tier;
  days?: number;
  slack_bound_minutes?: number;
  provisional_slack_minutes?: number;
  miss?: Miss;
  miss_context?: string;
  /** The results release the values came from. */
  evidence?: string;
}

export interface CuratedGate {
  chs_fit?: ChsFitRecord;
}

interface StationFile {
  provider?: string;
  sources?: string[];
  chs_fit?: ChsFitRecord;
}

/** Reads every CHS station file in `dir`, keyed by each source id it lists, which is the gate's id in the published database. */
export async function readCurated(dir: string): Promise<Map<string, CuratedGate>> {
  const out = new Map<string, CuratedGate>();
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort()) {
    const path = join(dir, name);
    const text = await readFile(path, "utf8");
    let doc: StationFile | null;
    try {
      doc = parse(text) as StationFile | null;
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
    }
    if (doc?.provider !== "chs") continue;
    for (const id of doc.sources ?? []) {
      out.set(id, doc.chs_fit ? { chs_fit: doc.chs_fit } : {});
    }
  }
  return out;
}

/**
 * The fitted gates no station file in `dir` lists, which ship nothing and get
 * no slackwater-database issue. Throws when `dir` holds no CHS station file at
 * all: a layout change in slackwater-database would otherwise make every gate
 * look like it ships online and silently stop every issue there.
 */
export function checkCurated(
  curated: ReadonlyMap<string, CuratedGate>,
  gates: readonly string[],
  dir: string,
): string[] {
  if (!curated.size) throw new Error(`${dir} holds no CHS station file`);
  return gates.filter((id) => !curated.has(id));
}

export function claimOf(fit: ChsFitRecord): Claim {
  return {
    tier: fit.tier,
    ...(fit.days !== undefined ? { days: fit.days } : {}),
    ...(fit.slack_bound_minutes !== undefined ? { bound: fit.slack_bound_minutes } : {}),
    ...(fit.provisional_slack_minutes !== undefined
      ? { provisional: fit.provisional_slack_minutes }
      : {}),
  };
}

/** The claim the stability rule holds a gate to: the curated one when this history released its evidence, otherwise none, so the gate is curated afresh. */
export function baselineClaim(
  gate: CuratedGate | undefined,
  released: ReadonlySet<string>,
): Claim | undefined {
  const fit = gate?.chs_fit;
  return fit?.evidence && released.has(fit.evidence) ? claimOf(fit) : undefined;
}

/** What the database ships for a gate today, whatever it was measured on; a gate with no `chs_fit` ships online. */
export function shippedClaim(gate: CuratedGate | undefined): Claim {
  return gate?.chs_fit ? claimOf(gate.chs_fit) : { tier: "online" };
}
