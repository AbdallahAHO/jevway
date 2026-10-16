# Plan 078: A click refused because the page changed doesn't spend the decision budget; it has its own cap

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `src/task/run-task.ts` must have `if (++decisions > maxSteps * 2) return stop('step_budget', …)` at the top of the
> loop, and the `StalePage` catch around `this.#tab.act(...)` with 056's `#pageLevelStale` counter. Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW–MED (more requests on pages that keep changing, bounded) · **Category**: bug (gates G3/G4)
- **Planned at**: commit `2b43357`, 2026-10-16

## Why this matters

The gotchas wizard on the churn profile ends `step_budget` about once in 30 runs. That is 1 of 31 in a 2026-10-16
diagnosis, and it showed up in the 058, 067 and 072 branches.

**It is not lost text.** The typed value stays in the field the whole time.

**What happens.** The run typed the name, then made 18 "Finish" decisions in a row. Every one was refused by
`Tab.act` with `StalePage: Page changed since this decision`, because the fixture replaces the whole subtree every
900 ms. Then the run hit the 30-decision cap after only 6 executed steps.

**Why so many refusals:**

| Decision kind | Observe to act | Clicks refused |
|---|---|---|
| Text-only | about 450 ms | 33% |
| Screenshot-backed (the `fallback` second look adds a screenshot and a second request) | about 1 s, longer than the churn period | 90% |

**Why it stops the run.** Each refusal counts against `maxSteps * 2`. A real page that re-renders faster than the
screenshot look can stall the same way.

**The fix.** Refused decisions get their own cap and stop spending the steps' budget. Pages that settle see no change.

## Current state

- `src/task/run-task.ts`:
  - `let decisions = 0;`, and at the top of the loop `if (++decisions > maxSteps * 2) return stop('step_budget', \`Made ${maxSteps * 2} decisions without finishing\`);`.
  - The `catch` around `this.#tab.act(action, page, text)` handles `StalePage`, but not `TargetUnreachable`: record
    false, discard the recording step, re-observe, `continue`.
  - 056's `#pageLevelStale` counts page-level refusals.
- Tests: `test/jev-browse.test.ts`. 056's busy-page tests show a `fakeTab` whose `act` throws `StalePage`.

## Scope

**In scope:**
- `src/task/run-task.ts`: the decision count and a refusal cap.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: the loop-guards line.

**Out of scope:**
- `fresh()`.
- The `fallback` second-look rule.
- The gotchas fixture: don't soften the churn.

Never read `.env`.

## Git workflow

Commits:
1. `test: clicks refused on a changing page do not use up the decision budget`
2. `fix: give clicks refused on a changing page their own budget`

No AI attribution. Do NOT push.

## Steps

1. **Tests first:**
   - **Refusals aren't charged.** `maxSteps` is 5, so the budget is 10 decisions. The fake tab refuses the "Finish"
     click (`StalePage`) 8 times, then accepts it, then DONE. The run ends `done`. Today it ends `step_budget`, because 8
     refusals plus the other steps exceed 10.
   - **The cap.** A target that is refused forever ends `blocked` after `2 * maxSteps` refusals in the run, with
     `The page kept changing under the click: "<label>" was refused N times as stale`.
   - **Charged decisions unchanged.** Executed actions and other re-decisions still count as today. Write a test that a
     run with no refusals hits `step_budget` at the same point as before.

   Run them red. Commit 1.
2. **The rule.**
   - Count a decision whose action was refused with a plain `StalePage` (not `TargetUnreachable`) in a separate
     `#staleRefusals` counter, and give its `++decisions` back.
   - When the refusals exceed `2 * maxSteps`, stop `blocked` with the reason above. Use a local counter per `run()`, like
     the decision budget.

     **Decision, 2026-10-16:** the cap is 2×maxSteps, not maxSteps. Today a run already tolerates about
     `2*maxSteps − steps` refusals, so a cap of maxSteps would make the flake worse: 21% against 9% in streak mode. A cap
     of 2×maxSteps gives about 4%. The gray-zone screenshot look stays, because it is a safety check.
   - One comment: a page that re-renders faster than a decision takes would otherwise spend the steps' budget on clicks
     it never let run.
   - AGENTS.md loop-guards: add the clause.

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.
3. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`.
   - `pnpm verify:gotchas` → strict per profile.
   - The wizard on churn about 30 times through the gotchas runner's narrowing (report passes, against about 97%).
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → 8/8.
   - Report the requests per run on churn before and after.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations; gotchas strict
- [ ] wizard churn ×30 and Grafana reported, with requests per run; `git diff --stat` lists only in-scope paths

## STOP conditions

- gotchas strict drops on any profile, or the median requests per run on churn rise by more than 50%.
