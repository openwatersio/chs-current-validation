// Publishes what a recorded run decided: its releases, its issues here, a
// follow-up run when a gate needs a backfill, and then its issues in
// slackwater-database, last because only they need a second token, so a
// failing one loses nothing else. Safe to run again from the same
// announcement, because a release that already exists is skipped and the rest
// is filed again.
import { fileIssues, type Gh } from "./github.ts";
import { DATABASE_REPO, type Announcement } from "./run.ts";

export async function announce(
  a: Announcement,
  input: {
    repo: string;
    /** The commit each new release tags. */
    target: string;
    results: Gh;
    /** Called only when an issue is for slackwater-database, whose token a run may lack. */
    database: () => Gh;
    log: (line: string) => void;
  },
): Promise<void> {
  const { repo, results } = input;
  for (const r of a.releases) {
    if (await results.releaseExists(repo, r.tag)) {
      input.log(`${r.tag} already exists, so it is skipped`);
      continue;
    }
    await results.createRelease(repo, r.tag, input.target, r.title, r.notesFile, r.files);
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
