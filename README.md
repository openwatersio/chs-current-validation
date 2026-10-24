# CHS current validation

This repository measures how well Slackwater's fitted CHS current gates predict slack, all year round, for each fit recipe the apps ship. It publishes each gate's tier and bounds as releases, which [slackwater-database](https://github.com/openwatersio/slackwater-database) cites when it curates a gate.

A gate's model is fitted on the device from Canadian Hydrographic Service (CHS) speed and direction predictions. The [engine benchmark](https://github.com/openwatersio/slackwater/blob/main/docs/validation/chs-currents.md) fits each gate the way the apps do, on a staggered year-round grid of fit ends, and scores held-out weeks against CHS's own published slacks and peaks. Both sides are predictions, so the results say how far a fitted model's slacks fall from CHS's, not how real water behaves.

## Results

Each release is tagged `fit-<newest fit end>-<first 7 characters of the recipe stamp>-r<run>` and carries:

- `dispositions.json`: each gate's `chs_fit` (tier, window, slack bound and provisional bound), what the newest year alone measures, and that year's evidence per window and quarter;
- `history.csv`: one line per committed row in the history, including weeks with no events or beyond the horizon;
- `audit.csv`: each gate's five largest slack errors per window over the pooled year, with the grid point, held-out age and slack index that reproduce each one with the engine's `FIT_END`.

An online gate's `miss` carries `near_bar: true` when the gate passes the bar in its newest and previous years but not yet by the promotion margin (1 minute on a timing clause, 0.05 kn on peak speed), so its value passes the bar.

## How a run works

`.github/workflows/results.yml` runs on `main` only, monthly and on demand with an optional list of gates to re-score:

1. **Plan** reads `targets.json`, the history and the newest `@slackwater/database` release. It decides which grid points to score and which gates to backfill, and splits the gates into shards.
2. **Score** runs the engine benchmark in `ROWS_ONLY` mode at each target's engine commit, one shard at a time and from a cold cache. Only rows and gate records leave the job.
3. **Record** commits each new grid point once every gate has rows or a recorded reason. It derives each gate's disposition by the disposition and stability rules, pushes the history to `main`, and decides what to publish.
4. **Announce** publishes the release, then opens issues here: for a gate with no scored rows at a new grid point, a grid point that can't commit for a reason other than CHS's horizon, a CHS revision, a gate that moved to another IWLS station or flood axis, or a backfill that scored no week for a gate at some committed grid point (`Backfill of <gate> failed`). Next it dispatches a follow-up run when a gate needs a backfill. Last, for the first target in `targets.json` only, it opens issues in slackwater-database for each gate whose shipped claim no longer holds in the newest year, whose release gives it a weaker claim, or that ships a fitted claim with no scored week left to support it, an `insufficient` disposition.

A backfill replaces a gate's rows only at the grid points where it scored a week. Elsewhere the history keeps what it had, so a backfill that fails, say during an IWLS outage, loses nothing. A gate flagged for a backfill stays flagged until one scores it at every grid point, and until then its disposition carries over and each run tries again.

GitHub keeps at most one pending run behind the one in progress, and a newer run replaces it. A `backfill` dispatched while a run is in progress can therefore be replaced by that run's follow-up or by the schedule, which backfill only the gates `state.json` flags. Dispatch it again once nothing is running or queued.

The rules follow the gate confidence design in [openwatersio/slackwater-ios#752](https://github.com/openwatersio/slackwater-ios/issues/752).

## When releases pause

A grid point commits only once CHS has published events through its last held-out week, which starts 270 days after its fit end. When that week falls in a year CHS hasn't published yet, the grid point waits until CHS publishes that year, and so does every grid point after it, because the history never skips one. Until then runs add no grid points, so releases pause unless a backfill re-scores a gate or a gate is flagged for one. The run's summary names the week it waits on, and the wait opens no issue. A grid point that stops for any other reason, such as IWLS refusing one window for every gate, opens a `Grid point <n> can't commit for <stamp> scorer <version>` issue here, naming the history that stopped because grid indices repeat across histories, and each run that still can't commit it comments there.

## New histories

Rows from different recipe stamps or scorer versions never pool, so each pair has its own history. Adding a target to `targets.json`, or moving a target to an engine commit whose benchmark has a new `SCORER_VERSION`, starts a new history. Its first run seeds 14 grid points, a year plus one, with the 365-day window, at about 7,500 IWLS requests. Every gate in a new history is curated afresh: its curated `evidence` names a release from another history, so the stability rule doesn't hold it to its curated claim. For the target the apps ship, the first release then asks slackwater-database to update each gate whose shipped claim no longer holds, or whose fresh claim is weaker.

## Layout

- `targets.json` lists the recipe stamps to score, each with an `openwatersio/slackwater` commit whose engine produces it. The first is the stamp the apps ship. Adding a target starts a new history for it.
- `history/<stamp>/scorer-<version>/` holds one rows file and one gate-record file per grid point, `state.json` with the gates waiting for a backfill, `dispositions.json` from the newest release, and `releases.json` listing the releases made from it.
- `src/` holds the planning, commit, derivation and release logic, tested in `test/`. `scripts/` holds the workflow's steps.

## Repository settings

`main` must accept pushes from `github-actions[bot]`. The record job pushes the history there with the workflow's `GITHUB_TOKEN`, so branch protection or a ruleset on `main` has to let that token push. Otherwise the record job fails at its push, after the scoring, and nothing is announced.

`DATABASE_ISSUES_TOKEN` is a fine-grained token with read and write access to issues in openwatersio/slackwater-database. A run fails at its start when the token is missing or can't create issues there. The check asks to create an issue with an empty title, which GitHub refuses as invalid (HTTP 422) when the token may create issues and as unauthorized, forbidden or not found when it may not, so it never creates one. A token that stops working during the hours of scoring still fails at announce, after the history is pushed and after the release, this repository's issues and any follow-up run. Fix the token, then re-run announce as below.

## Recovering a failed announce

The record job uploads `out/` as the `announce` artifact before it pushes. If publishing fails after the push, download that artifact into `out/` in a checkout of `main`, then run `npm ci && npm run announce` with `GH_TOKEN` and `DATABASE_ISSUES_TOKEN` set. Re-running announce from the artifact is safe: it skips a release that already exists and files the rest, so an issue it already opened gets a comment. It also dispatches the follow-up run again, which is harmless because the follow-up plans only what is still due. Re-running the job or the workflow is not the recovery: the history is already on `main`, so record finds nothing new and announces nothing.

## Licence and data

The code is MIT licensed. The repository and its releases hold error statistics only: errors in minutes and knots, counts, grid dates, event horizons and hashes. It holds no CHS predictions, samples, event times or fitted constants. Record keeps only the row and gate-record fields it declares, so a field a newer engine adds never reaches the history, and the run summary names any dropped field whose name suggests a time or a sample. Predictions are not for navigation.
