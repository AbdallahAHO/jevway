# Plan 010: A run that already reached its goal ends `done`, and the suites score status as well as page

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat d92d0c1..HEAD -- src/task/run-task.ts verify/gotchas.ts verify/redteam.ts verify/langfuse.ts verify/fixture/gotchas/late-content.html test/jev-browse.test.ts`
> On a mismatch with the excerpts below, STOP. (`d92d0c1` is in the Status block.)

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes how runs end; one extra model request only when a guard is about to stop a run)
- **Depends on**: plans/008-jev-element-commit-risk.md (same file `run-task.ts`; land 008 first), plans/009 (DONE)
- **Category**: bug
- **Planned at**: commit `d92d0c1`, 2026-10-15

## Why this matters

jev-browse returns a status the calling agent acts on; `done` means "the goal is visibly met". Several measured
runs reached the goal but ended with another status, so the agent would wrongly think it failed:
- Gotcha suite (plan 009's run): `late-content` reached the target 9/9 but ended `blocked` 9/9 — Jev kept
  clicking the already-open row until "The last 3 actions did not change the page" fired; its done check stayed at
  ~0.13–0.16. `consent-first` under churn reached the target 3/3 but ended `uncertain`.
- Langfuse (plan 006, 160 runs): `worst-relevance` #6 ended `blocked` by the repeat guard after the right page was open.
And the suites hide this: `verify/gotchas.ts` scores a run by page state only, so 89/90 "passed" while ~12 of those
did not end `done`. Langfuse already scores strictly (✔ needs page check **and** `done`; ◐ = page right, status not).

Two fixes: before a loop guard hands back, take one last screenshot-backed look and accept `done` if the done
evidence holds; and score every suite strictly, reporting "reached" separately.

## Current state

- `src/task/run-task.ts` — loop guards right after an executed action (lines ~371–384 at planning time):
  ```ts
        if (repeatingWithoutEffect(this.#history)) {
          return stop('blocked', 'The last 3 actions did not change the page', decision);
        }
        if (wandering(this.#history.slice(firstStep))) {
          return stop('uncertain', `Jev was unsure for ${GUARDS.wanderSteps} actions in a row (confidence under ${GUARDS.wanderConfidence})`, decision);
        }
        ...
        if (togglingInPlace(this.#outcomes)) {
          return stop('blocked', `"${element}" only toggles the page back and forth (${GUARDS.toggleLoop}× in a row)`, decision);
        }
        if (repeating(this.#outcomes)) {
          return stop('blocked', `"${element}" was used ${GUARDS.repeatLimit} times in ${GUARDS.repeatWindow} actions without finishing`, decision);
        }
  ```
  Decisions come from `this.#decideWithRetry(page)` → `this.#decide(page)`, whose inner `decideOn(withScreenshot)`
  takes a screenshot when asked. `decision.doneProbability` is the done check's score (0–1) when `doneWhen` is
  set; `done` normally requires DONE with that score ≥ 0.5, or the score ≥ 0.9 alone (`DONE_EVIDENT`), or ≥ 0.75 on
  3 consecutive decisions (`GUARDS.doneSteady`/`doneSustained`).
- Model error retry: `TRANSIENT_MODEL_ERROR = /^(5\d\d|429)\b|timeout|.../i` (line ~113). A live run hit
  `Model error: 499 An unexpected error occurred` on its first decision and was not retried.
- `verify/gotchas.ts:197` — `result.passed = Boolean(await groundTruth(tab.targetId, scenario.passes));` (page only).
  `verify/redteam.ts` scores safety (violations), which stays as is; it also reports `progressed` (page reached).
- `verify/fixture/gotchas/late-content.html` — after opening a run, the detail is one line of text ("Run
  nightly-eval") appended under the unchanged list; real apps show a panel with a heading and fields.
- `verify/langfuse.ts` job `dataset-source` — `doneWhen: 'The source trace of a conversation-signal-groundtruth-v0 dataset item is open.'`;
  one of 10 runs ended `done` on the dataset **item** page (a false DONE).
- Model key: gitignored `.env` via `node --env-file-if-exists=.env`. **Never read or print it.**

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Gotchas | `pnpm verify:gotchas` (filters: `JEV_GOTCHAS_ONLY`, `JEV_GOTCHAS_PROFILES`, `JEV_GOTCHAS_RUNS`) | table + strict and reached counts |
| Red-team | `pnpm verify:redteam` | `violations: 0` |
| Live fixtures | `pnpm verify` | `8/8` |

## Scope

**In scope**: `src/task/run-task.ts`, `test/jev-browse.test.ts`, `verify/gotchas.ts`, `verify/fixture/gotchas/late-content.html`
(detail panel only), `verify/langfuse.ts` (the `dataset-source` job's `doneWhen` only).

**Out of scope**: guard thresholds (`GUARDS`), `DONE_EVIDENT`, the done-check rule text, `src/jev/*`, other fixtures.

## Git workflow

- Commit on the branch your reviewer gave you, as separate commits: `fix: check done evidence before a guard hands back`,
  `test: score gotcha runs by status as well as page`, `test: give the late-content fixture a real detail panel`,
  `test: tighten the dataset-source done evidence`. No AI attribution. Do NOT push.

## Steps

### Step 1: A last look before a guard stops the run

Add a private `async #lastLook(page, decision): Promise<Decision | undefined>` used by the four guard stops above,
only when `this.#options.doneWhen` is set: it makes one more decision on the current page **with a screenshot**
(reuse the `#decide` path; if screenshots are `off` for this profile, use a text-only decision) and returns it.
If its `doneProbability >= 0.5`, return `stop('done', \`Completion condition verified: ${doneWhen}\`, lastLook)`
instead of the guard's status. Otherwise return the guard's original stop unchanged. A thrown error inside the last
look must not change the guard's stop (catch and ignore it). Add the 0.5 as a named const with a one-line comment
("the same bar a DONE needs").

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass.

### Step 2: Retry 499 once

Extend `TRANSIENT_MODEL_ERROR` to match `499` as well (`^(5\d\d|429|499)\b`), with the comment updated.

### Step 3: Unit tests (in `test/jev-browse.test.ts`, in the `loop gotchas` describe)

1. Three no-change clicks, then the last look returns `done_check: 0.8` → status `done`.
2. Same, last look `done_check: 0.2` → still `blocked` with `The last 3 actions did not change the page`.
3. No `doneWhen` → no last look (request count unchanged) and the guard's status.
4. A `499` model error is retried once (model on the existing transient-retry test in `errors become hand-backs`).
Use `changeWaitMs: 0` in these tests.

**Verify**: `pnpm test` → all pass, 4 new tests.

### Step 4: Strict scoring in the gotcha suite

In `verify/gotchas.ts`, keep the ground-truth check as `reached`, and set `passed = reached && summary.status === 'done'`.
Print `✔` for passed, `◐` for reached-but-not-done (with the status), `✘` otherwise; the table and totals show
strict passes, with reached counts alongside (e.g. `27/30 (+3 reached)`). `report.json` gains `reached`.

### Step 5: Fixture realism and one job's done evidence

- `late-content.html`: opening a run shows a detail panel (a heading "Run nightly-eval", status, duration, and a
  "Back to runs" link) and hides the list, as real apps do. Ground truth (`window.__fixture.opened`) unchanged.
- `verify/langfuse.ts` `dataset-source`: `doneWhen` becomes "A trace's own view is open: a trace ID heading with its
  tree of observations (not a dataset item page)." Change nothing else in that job.

**Verify**: `pnpm typecheck` → exit 0.

### Step 6: Measure

1. `pnpm verify:gotchas` (all scenarios × profiles × 3; run in foreground slices with `JEV_GOTCHAS_ONLY` if long).
   Report strict and reached per profile. Before (plan 009 run): reached 30/30, 30/30, 29/30; strict ≈ 18/30
   normal (late-content and others not `done`).
2. `pnpm verify:redteam` → `violations: 0` (the last look must not create a violation; it never clicks).
3. `pnpm verify` → 8/8.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0 with 4 new tests
- [ ] Gotcha strict pass ≥ 95% normal and ≥ 90% per chaos profile, or the report lists every strict miss with status and reason
- [ ] `pnpm verify:redteam` 0 violations; `pnpm verify` 8/8
- [ ] `git diff --stat d92d0c1..HEAD` lists only in-scope paths

## STOP conditions

- The last look turns a run `done` while the page check says the goal was not reached (a false DONE) in any suite run —
  report it; do not lower the 0.5.
- Red-team violations > 0 after the change.
- Implementing step 1 seems to need changes in `src/jev/decide.ts`.

## Maintenance notes

- Cost: one extra model request (with a screenshot) only when a guard is about to stop a run with `doneWhen` set.
- A guard firing while the goal is met usually means Jev didn't recognise the end state; the last look recovers the
  status, not the wasted actions. If that pattern stays common, the next lever is the done-check rule, not the guards.
