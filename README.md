# CHS current validation

This repository measures how well Slackwater's fitted CHS current gates predict slack, all year round, for each fit recipe the apps ship. It publishes each gate's tier and bounds as releases, which [slackwater-database](https://github.com/openwatersio/slackwater-database) cites when it curates a gate.

A gate's model is fitted on the device from Canadian Hydrographic Service (CHS) speed and direction predictions. The [engine benchmark](https://github.com/openwatersio/slackwater/blob/main/docs/validation/chs-currents.md) fits each gate the way the apps do, on a staggered year-round grid of fit ends, and scores held-out weeks against CHS's own published slacks and peaks. Both sides are predictions, so the results say how far a fitted model's slacks fall from CHS's, not how real water behaves.

## Results

Each release is tagged `fit-<newest fit end>-<first 7 characters of the recipe stamp>-r<run>` and carries:

- `dispositions.json`: each gate's `chs_fit` (tier, window, slack bound and provisional bound), what the newest year alone measures, and that year's evidence per window and quarter;
- `history.csv`: one line per committed row in the history, including weeks with no events or beyond the horizon;
- `audit.csv`: each gate's five largest slack errors per window over the pooled year, with the grid point, held-out age and slack index that reproduce each one with the engine's `FIT_END`.

The 365-day window is report-only, and only seeds and backfills score it, so its evidence can cover fewer grid points than the recipe windows', or none.

An online gate's `miss` carries `near_bar: true` when the gate passes the bar in its newest and previous years but not yet by the promotion margin (1 minute on a timing clause, 0.05 kn on peak speed), so its value passes the bar.

## How a run works

`.github/workflows/results.yml` runs on `main` only, monthly and on demand with an optional list of gates to re-score. No job that holds a write token installs or runs package code:

1. **Token** checks that `DATABASE_ISSUES_TOKEN` can create issues in slackwater-database, before anything else runs.
2. **Plan** reads `targets.json`, the history and the newest published `@slackwater/database`. It decides which grid points to score and which gates to backfill, and splits the gates into shards. It takes the newest published version, prereleases included, not npm's `latest` tag: the package publishes its releases under the `beta` tag, so `latest` still points at `1.0.0-beta.0`.
3. **Score** runs the engine benchmark in `ROWS_ONLY` mode at each target's engine commit, one shard at a time and from a cold cache. Only rows and gate records leave the job.
4. **Record** commits each new grid point, in its working copy, once every gate has rows or a recorded reason. It derives each gate's disposition by the disposition and stability rules and decides what to publish. It runs package code, so it holds no write token, and hands the history and its decisions to publish as artifacts.
5. **Publish** runs only git, gh and this repository's own scripts. It commits the history onto the `main` that record read, rebasing it onto any push since, and makes that commit the target of the run's releases. It publishes the release, then opens issues here: for a gate with no scored rows at a new grid point, a grid point that can't commit for a reason other than CHS's horizon, a CHS revision, a gate that moved to another IWLS station or flood axis, or a backfill that didn't score both recipe windows for a gate at some grid point it covers (`Backfill of <gate> failed`). Each of these per-gate issues names its history in the body, so reports from two targets can be told apart. Next it dispatches a follow-up run when this run flagged a gate for a backfill; a gate whose backfill failed stays flagged for the next scheduled run. Last, for the first target in `targets.json` only, it opens issues in slackwater-database for each gate whose shipped claim no longer holds in the newest year, whose release gives it a weaker claim, that ships a fitted claim with no scored week left to support it (an `insufficient` disposition), or that ships a fitted claim while its backfill after a station, axis or CHS change keeps failing.

A backfill re-scores a gate over the newest 14 committed grid points and any new ones, which are all its dispositions read. Older committed grid points keep the gate's earlier rows, such as those from its previous IWLS station, and every release's `history.csv` still publishes them. Within the backfill, the gate's rows at a grid point are replaced only where it scored a week in both recipe windows, 60 and 210 days. Elsewhere the history keeps its committed rows, so a backfill that fails, say during an IWLS outage, loses none of the evidence its dispositions use, though a grid point it does replace can lose its report-only 365-day rows. A flagged gate stays flagged until a backfill scores both recipe windows at every grid point it covers, and until then its disposition carries over and each run tries again.

GitHub keeps at most one pending run behind the one in progress, and a newer run replaces it. A `backfill` dispatched while a run is in progress can therefore be replaced by that run's follow-up or by the schedule, which backfill only the gates `state.json` flags. Dispatch it again once nothing is running or queued.

The rules follow the gate confidence design in [openwatersio/slackwater-ios#752](https://github.com/openwatersio/slackwater-ios/issues/752).

## When releases pause

A grid point commits only once CHS has published events through its last held-out week, which starts 270 days after its fit end. When that week falls in a year CHS hasn't published yet, the grid point waits until CHS publishes that year, and so does every grid point after it, because the history never skips one. Until then runs add no grid points, so releases pause unless a backfill re-scores a gate or a gate is flagged for one. The run's summary names the week it waits on, and the wait opens no issue. A grid point that stops for any other reason, such as IWLS refusing one window for every gate, opens a `Grid point <n> can't commit for <stamp> scorer <version>` issue here, naming the history that stopped because grid indices repeat across histories, and each run that still can't commit it comments there.

## When record fails

Some problems stop the record step and fail the run, after the scoring, with nothing committed, released or filed for any target. The failed run is the signal:

- Two gates resolve to the same IWLS station, so one of them sits at the wrong position. Every run fails until slackwater-database moves one of them.
- slackwater-database's station files list no CHS gate, or none for more than half the planned gates, which means their layout or id format changed. Below that threshold, a gate with no station file on `main` is scored and released as usual, ships nothing, and gets a warning line in the run summary.

## New histories

Rows from different recipe stamps or scorer versions never pool, so each pair has its own history. Adding a target to `targets.json`, or moving a target to an engine commit whose benchmark has a new `SCORER_VERSION`, starts a new history. Its first run seeds 14 grid points, a year plus one, with the 365-day window, at about 7,500 IWLS requests. Every gate in a new history is curated afresh: its curated `evidence` names a release from another history, so the stability rule doesn't hold it to its curated claim. For the target the apps ship, the first release then asks slackwater-database to update each gate whose shipped claim no longer holds, or whose fresh claim is weaker.

## Layout

- `targets.json` lists the recipe stamps to score, each with an `openwatersio/slackwater` commit whose engine produces it. The first is the stamp the apps ship. Adding a target starts a new history for it.
- `history/<stamp>/scorer-<version>/` holds one rows file and one gate-record file per grid point, `state.json` with the gates waiting for a backfill, `dispositions.json` from the newest release, and `releases.json` listing the releases made from it.
- `src/` holds the planning, commit, derivation and release logic, tested in `test/`. `scripts/` holds the workflow's steps.
- `scripts/plan.ts` also reads two knobs for trying a plan locally, which the workflow never sets: `ONLY_GATES`, a comma-separated list of the gate ids to plan alone, and `TODAY`, the `YYYY-MM-DD` date to plan as of. `BACKFILL` ids are checked against every fitted gate whatever `ONLY_GATES` lists.

## Repository settings

`main` must accept pushes from `github-actions[bot]`. The publish job pushes the history there with the workflow's `GITHUB_TOKEN`, so branch protection or a ruleset on `main` has to let that token push. Otherwise the publish job fails at its push, after the scoring, and nothing is announced; fix the setting, then re-run it as below.

`DATABASE_ISSUES_TOKEN` is a fine-grained token with read and write access to issues in openwatersio/slackwater-database. A run fails at its start when the token is missing or can't create issues there. The check asks to create an issue with an empty title, which GitHub refuses as invalid (HTTP 422) when the token may create issues and as unauthorized, forbidden or not found when it may not, so it never creates one. A token that stops working during the hours of scoring still fails at announce, after the history is pushed and after the release, this repository's issues and any follow-up run. Fix the token, then re-run the publish job as below.

## Recovering a failed publish

The publish job works only from the record job's artifacts, so the recovery is to re-run the failed jobs of that run, before a later results run records. Publish starts again from the commit record read: a history it already pushed rebases away to nothing, and a change to `main` that conflicts with it fails the push rather than being overwritten. Announcing again is safe too. It skips a release that already exists, comments on an issue it already opened, and dispatches the follow-up again, which plans only what is still due. Re-running the whole workflow is not the recovery: it scores everything again, and once the history is on `main`, record finds nothing new and announces nothing.

Once it has pushed, publish uploads `out/` as the `announce` artifact, naming the history commit as the releases' target. If the run can no longer be re-run, download that artifact into `out/` in a checkout of this repository and run `node scripts/announce.ts` with `GH_TOKEN` and `DATABASE_ISSUES_TOKEN` set. It needs no `npm ci`, since announce loads only this repository's code and Node's built-ins, and its releases tag the commit the artifact names, not the checkout's.

## Licence and data

The code is MIT licensed. The repository and its releases hold error statistics only: errors in minutes and knots, counts, grid dates, event horizons and hashes. It holds no CHS predictions, samples, event times or fitted constants. Record keeps only the row and gate-record fields it declares, so a field a newer engine adds never reaches the history, and the run summary names any dropped field whose name suggests a time or a sample. Predictions are not for navigation.
