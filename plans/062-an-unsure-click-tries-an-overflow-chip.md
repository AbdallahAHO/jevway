# Plan 062: An unsure step tries an overflow chip before handing back, opening count chips first

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 057 must be on main (`git log --oneline -15 | rg "judge at most three overflow controls"`).
> `#openDisclosure` in `src/task/run-task.ts` and `overflowFolds`/`elementRiskTargets` in `src/jev/decide.ts` must be as 057 left
> them, apart from plan 061's dialog lines if 061 has merged. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (widens a rescue that clicks) · **Category**: bug (gate R5, phones)
- **Planned at**: commit `65202a4`, 2026-10-16

## Why this matters

Plan 057 made a BLOCKED step open a collapsed overflow chip once. Langfuse phone dataset-source went from 0/3 to 3/3.
session-to-user stayed at 0/3. The 2026-10-16 diagnosis on 9333:
- **The chip is there.** `button "Show 1 more session details"` (`expanded: 'false'`, in the header, on screen) is listed,
  `overflowFolds` matches it, and its risk by name is 0.02.
- **Opening it works.** The chip opens a dialog listing `link "user : u-…"`, which the next decision clicks at 0.90
  (0.62 with a screenshot).
- **The rescue never runs.** On that page the operation head is a coin flip between BLOCKED and CLICK, about 0.35 to
  0.49 each. All 3 real runs, and 2 of 4 replays, ended on a CLICK at 0.20–0.25 confidence, under `minConfidence`
  (0.3), which hands back `uncertain`. The rescue acts only on BLOCKED.
- **The wrong chip comes first.** In run 3 a BLOCKED did fire the rescue, but with a screenshot the click head ranked the
  page's "More actions" menu (0.04) above the chip (0.01), so the one try went to the action menu.

A person who is unsure where to go next on a phone opens the "+1" that says something is hidden, before giving up.

## Current state

- `src/task/run-task.ts`:
  - `#openDisclosure(decision, page)` returns early unless `decision.operation === 'BLOCKED'` (and no
    `fieldsWithoutValue`). It is called at the decision step as `decision = this.#openDisclosure(this.#boxRescue(decision, page), page)`.
  - `#lowConfidence(decision)` is true when the operation is not DONE or BLOCKED and
    `min(confidence, targetConfidence ?? 1) < minConfidence`. An unsure step (not WAIT or PRESS_ESCAPE) is handed back
    `uncertain` further down; search `#lowConfidence(decision) && !['WAIT', 'PRESS_ESCAPE']`.
- `src/jev/decide.ts`:
  - `overflowFolds(answers, clicks)` returns up to `MAX_OVERFLOW_FOLDS = 3` collapsed overflow controls, ranked by the
    click head.
  - `elementRiskTargets` judges them by name only when `decision.operation === 'BLOCKED'`. `decide()` doesn't know
    `minConfidence`. An unjudged chip counts as risk 1 in `#openDisclosure`, which hands back `needs_confirmation`.
    That's safe, but it is not this plan's intent.
- Tests: the 057 tests in `test/jev-browse.test.ts` (search `overflow`) are the pattern.

## Scope

**In scope:**
- `src/jev/decide.ts`: `overflowFolds` ranking, `elementRiskTargets`, and a `DecisionInput` field for the unsure bar.
- `src/task/run-task.ts`: `#openDisclosure`'s entry condition, and passing the bar into the decision input.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: amend 057's clause in the loop-guards line.

**Out of scope:**
- `foldedFavourite`'s path (top candidate, BLOCKED only).
- The label pattern.
- Thresholds.
- The wander guard.

Use 9333 only when your reviewer says it's free. Never touch 9444. Never read `.env`.

## Git workflow

Commits:
1. `test: an unsure step opens a count chip before handing back`
2. `fix: try an overflow chip on an unsure step, count chips first`

No AI attribution. Do NOT push.

## Steps

1. **Tests first** (scripted, offline):
   - **Unsure CLICK opens the chip.** An unsure CLICK at 0.22 on a page listing a collapsed
     `"Show 1 more session details"` and a collapsed `"More actions"`. The run clicks the count chip
     (`via: 'disclosure'`) instead of handing back `uncertain`, then a scripted confident CLICK on the revealed link,
     then DONE.
   - **Count chips first.** The same page with BLOCKED and the click head favouring "More actions" (0.04 against 0.01):
     the count chip is opened first.
   - **Bar passed and chips judged.** An unsure CLICK's request carries the overflow risk questions, so the bar reaches
     `decide()` and `elementRiskTargets` judges the chips for an unsure CLICK. A confident CLICK (≥ the bar) does not
     carry them.
   - **Nothing left to open.** An unsure CLICK with every chip already opened, or with no chip on the page, still hands
     back `uncertain` as today.
   - **High risk by name.** It hands back `needs_confirmation` and clicks nothing.

   Run them red. Commit 1.

2. **The change.**
   - **The bar.** Add `unsureBelow?: number` to `DecisionInput`. `run-task` passes `minConfidence`.
   - **Judging.** In `elementRiskTargets`, judge the overflow folds when the operation is BLOCKED, **or** when it is a
     CLICK, TYPE_TEXT or SELECT whose `min(confidence, targetConfidence)` is under `unsureBelow`. Read how
     `decide.ts` computes those confidences before the risk follow-up. If the operation confidence is only known after
     that request, judge on the operation head's top probability. Report what you used.
   - **Ranking in `overflowFolds`.** Count chips first (`^\+\d+$`, `^show \d+ more\b`), then the rest. The click head
     breaks ties within each group. Keep the cap of 3.
   - **`#openDisclosure` entry.** Run it on BLOCKED (as now) or when `this.#lowConfidence(decision)` holds and the
     operation is not WAIT or PRESS_ESCAPE. For the unsure case, use only the overflow fallback, not `foldedFavourite`,
     with the same `#opened` check, commit-risk computation and `confidence: minConfidence`.
   - **Comment.** One line: a person unsure where to go on a narrow screen opens the "+1" that says something is hidden,
     before giving up.

   `pnpm test` and `pnpm typecheck` → pass. Amend AGENTS.md's 057 clause to say "a BLOCKED or unsure step …, count chips
   first". Commit 2.

3. **Measure**, headless unless noted:
   - `pnpm verify` → 8/8; `pnpm verify:gotchas` strict per profile; `pnpm verify:redteam` → `violations: 0` (watch
     confirm-modal).
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` and the `JEV_GRAFANA_DEVICE=iphone-15` run → 8/8 each. Report any
     `via: 'disclosure'` step.
   - `CI=1 JEV_CHECKOUT_RUNS=2 pnpm verify:checkout` → report, and list any disclosure step.
   - Only when your reviewer says 9333 is free:
     `JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_ONLY=session-to-user,dataset-source pnpm verify:langfuse`
     (against 0/3 and 3/3), then the full desktop suite once: `JEV_LANGFUSE_RUNS=1 pnpm verify:langfuse`. Report every
     disclosure step and any job that changed.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations
- [ ] gotchas, Grafana desktop and phone, checkout, Langfuse phone pair and desktop ×1 reported, with disclosure steps listed
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- A red-team violation, or gotchas strict below 29/30 on any profile.
- An overflow click executed without a by-name judgment while element risk is on.
- A desktop Langfuse or Grafana job that passed before now fails with a disclosure step in its trace.

## Maintenance notes

- This turns some `uncertain` hand-backs into one or more reversible clicks, at most 3 per task. Each counts toward the
  6-in-a-row wander guard at confidence 0.3.
