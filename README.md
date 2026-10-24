# CHS current validation

This repository measures how well Slackwater's fitted CHS current gates predict slack, all year round, for each fit recipe the apps ship. It publishes each gate's tier and bounds as releases, which [slackwater-database](https://github.com/openwatersio/slackwater-database) cites when it curates a gate.

A gate's model is fitted on the device from Canadian Hydrographic Service (CHS) speed and direction predictions. The [engine benchmark](https://github.com/openwatersio/slackwater/blob/main/docs/validation/chs-currents.md) fits each gate the way the apps do, on a staggered year-round grid of fit ends, and scores held-out weeks against CHS's own published slacks and peaks. Both sides are predictions, so the results say how far a fitted model's slacks fall from CHS's, not how real water behaves.

## Results

Each release is tagged `fit-<newest fit end>-<first 7 characters of the recipe stamp>-r<run>` and carries:

- `dispositions.json`: each gate's `chs_fit` (tier, window, slack bound and provisional bound), what the newest year alone measures, and that year's evidence per window and quarter;
- `history.csv`: one line per committed row in the history, including weeks with no events or beyond the horizon;
- `audit.csv`: each gate's five largest slack errors per window over the pooled year, with the grid point, held-out age and slack index that reproduce each one with the engine's `FIT_END`.

## How a run works

`.github/workflows/results.yml` runs on `main` only, monthly and on demand with an optional list of gates to re-score:

1. **Plan** reads `targets.json`, the history and the newest `@slackwater/database` release. It decides which grid points to score and which gates to backfill, and splits the gates into shards.
2. **Score** runs the engine benchmark in `ROWS_ONLY` mode at each target's engine commit, one shard at a time and from a cold cache. Only rows and gate records leave the job.
3. **Record** commits each new grid point once every gate has rows or a recorded reason. It derives each gate's disposition by the disposition and stability rules, writes the history, and decides what to publish.
4. **Announce** publishes the release and opens issues. Here, for a gate with no rows, a CHS revision, or a gate that moved to another IWLS station or flood axis. In slackwater-database, for a gate whose shipped claim no longer holds, and only for the first target in `targets.json`.

The rules follow the gate confidence design in [openwatersio/slackwater-ios#752](https://github.com/openwatersio/slackwater-ios/issues/752).

## Layout

- `targets.json` lists the recipe stamps to score, each with an `openwatersio/slackwater` commit whose engine produces it. The first is the stamp the apps ship. Adding a target seeds a history for it.
- `history/<stamp>/scorer-<version>/` holds one rows file and one gate-record file per grid point, `state.json` with the gates waiting for a backfill, `dispositions.json` from the newest release, and `releases.json` listing the releases made from it.
- `src/` holds the planning, commit, derivation and release logic, tested in `test/`. `scripts/` holds the workflow's steps.

## Secrets

`DATABASE_ISSUES_TOKEN` is a fine-grained token with read and write access to issues in openwatersio/slackwater-database. A run fails at its start when the token is missing or can't read that repository. That check doesn't prove the token can write issues: a token without Issues: write fails at announce, after the history is pushed. Fix the token, then re-run announce as below.

## Recovering a failed announce

The record job uploads `out/` as the `announce` artifact before it pushes. If publishing fails after the push, download that artifact into `out/` in a checkout of `main`, then run `npm ci && npm run announce` with `GH_TOKEN` and `DATABASE_ISSUES_TOKEN` set. Re-running announce from the artifact is safe: it skips a release that already exists and files the rest, so an issue it already opened gets a comment. Re-running the job or the workflow is not the recovery: the history is already on `main`, so record finds nothing new and announces nothing.

## Licence and data

The code is MIT licensed. The repository and its releases hold error statistics only: errors in minutes and knots, counts, grid dates, event horizons and hashes. It holds no CHS predictions, samples, event times or fitted constants. Predictions are not for navigation.
