// Publishes what a recorded run decided: its releases, its issues here, a
// follow-up run when a gate needs a backfill, and then its issues in
// slackwater-database, last because only they need a second token, so a
// failing one loses nothing else. Safe to run again from the same
// announcement, because a release that already exists is skipped and the rest
// is filed again.
// This module and its imports load no package code: announce runs holding both write tokens.
import { DATABASE_REPO, fileIssues, type Gh } from "./github.ts";
import type { Announcement } from "./run.ts";

/** `a` with the commit its releases tag. */
export function withTarget(a: Announcement, target: string): Announcement {
  if (!/^[0-9a-f]{40}$/.test(target)) {
    throw new Error(`release target "${target}" is not a full commit hash`);
  }
  return { ...a, target };
}

export async function announce(
  a: Announcement,
  input: {
    repo: string;
    results: Gh;
    /** Called only when an issue is for slackwater-database, whose token a run may lack. */
    database: () => Gh;
    log: (line: string) => void;
  },
): Promise<void> {
  const { repo, results } = input;
  // Releases tag the history commit they were built from, not whatever checkout announces them.
  const { target } = a;
  if (a.releases.length && !target) throw new Error("out/announce.json names no release target");
  for (const r of a.releases) {
    if (await results.releaseExists(repo, r.tag)) {
      input.log(`${r.tag} already exists, so it is skipped`);
      continue;
    }
    await results.createRelease(repo, r.tag, target!, r.title, r.notesFile, r.files);
    input.log(`released ${r.tag}`);
  }
  await fileIssues(
    results,
    a.issues.filter((i) => i.repo === repo),
  );
  if (a.dispatch) await results.dispatch(repo, "results.yml");
  const forDatabase = a.issues.filter((i) => i.repo === DATABASE_REPO);
  if (forDatabase.length) await fileIssues(input.database(), forDatabase);
}
