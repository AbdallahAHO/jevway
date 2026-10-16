# Plan 042: An unsure step on a page whose screenshot-backed done check is high ends done

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat fdea27a..HEAD -- src/task/run-task.ts test/jev-browse.test.ts AGENTS.md` —
> on any output for `src/task/run-task.ts`, STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (a new way a run ends `done`; bar and evidence chosen from data) ·
  **Category**: bug
- **Planned at**: commit `0e9523e`, 2026-10-16

## Why this matters

jev-browse hands back `uncertain` when the model's next step is under the confidence bar (Jev: 0.3). On Langfuse's
`failed-experiment` (desktop) it did so on the **right page** in 3 of 10 runs, twice in a row (7/10 at `8d0d3c1`, 7/10
again at `fdea27a`): after opening the right results page, the model said DONE (done check 0.81) but that hand-back was
dropped because the page was still loading, and the next look picked an unsure click (0.2) while the done check still
read 0.79–0.85 — on a screenshot-backed decision.

Across every saved suite run that ended `uncertain`: done check ≥ 0.75 → 6 runs, **6 on the right page**; done check
< 0.5 → 39 runs, 37 on the wrong page; none in between. An unsure next step on a page the completion check confidently
accepts means there is nothing left to do — the same reasoning as a BLOCKED whose done check passes (already `done`).
The bar is the existing steady-evidence bar `GUARDS.doneSteady` (0.75), and the decision must have seen a screenshot
(in Jev's `fallback` mode an unsure step always gets a screenshot second look first).

## Current state

- `src/task/run-task.ts`: `#handBack(decision)` returns `['uncertain', 'Next step "<op> <label>" had confidence N']`
  for a low-confidence step (not WAIT/PRESS_ESCAPE); the hand-back block then checks freshness/loading and
  `return stop(handBack[0], handBack[1], decision)`. `GUARDS.doneSteady = 0.75`. `decision.sawScreenshot` is `true` when
  the decision's request carried a screenshot. The BLOCKED rule to mirror:
  ```ts
        // Blocked on a page that already meets the completion condition means there is nothing left to do.
        const blockedOnMetGoal = decision.operation === 'BLOCKED' && !decision.fieldsWithoutValue.length && doneProbability >= LAST_LOOK_DONE;
        if (doneWhen && blockedOnMetGoal) { record(false); return stop('done', `Completion condition verified: ${doneWhen}`, decision); }
  ```
- `AGENTS.md` invariants list how a run ends `done`.
- Tests: `test/jev-browse.test.ts`, `describe('loop gotchas')`; `scriptedJev` keys `operation`, `click_target`,
  `confidence`, `done_check`; `screenshots: 'fallback'` makes an unsure step re-decide with a screenshot.

## Scope

**In scope**: `src/task/run-task.ts`, `test/jev-browse.test.ts` (`loop gotchas`), `AGENTS.md` (one invariant sentence).
**Out of scope**: thresholds' values, the BLOCKED rule, `src/jev/*`. Do not run `verify:langfuse` or touch the Chrome on
port 9333.

## Git workflow

Commit: `fix: end an unsure step as done when the screenshot shows the goal met`. No AI attribution. Do NOT push.

## Steps

1. Tests (red first), options `{ goal: 'x', doneWhen: 'It is done', changeWaitMs: 0, screenshots: 'fallback' }`:
   - an unsure CLICK (confidence 0.2) whose screenshot second look has `done_check: 0.8` → `done`, nothing clicked;
   - the same with `done_check: 0.6` → `uncertain`;
   - `screenshots: 'off'` (no screenshot) with `done_check: 0.9`: the existing spike rule may already end it `done` — pick
     0.8 instead → `uncertain` (no screenshot, no new rule);
   - no `doneWhen` → `uncertain`.
2. Rule: when the hand-back would be `uncertain` because of a low-confidence step, `doneWhen` is set,
   `decision.sawScreenshot` is true and `doneProbability >= GUARDS.doneSteady`, end `done` instead (record the decision
   as not executed; reason `Completion condition verified: …`). One-line comment with the measured basis (6 of 6
   uncertain endings at ≥ 0.75 were on the right page). Place it with the hand-back handling so the freshness and
   loading checks still run first.
3. AGENTS.md: after the BLOCKED sentence, add "An unsure next step on a screenshot-backed decision whose `done_when` Noul
   is ≥ 0.75 is `done` too."
4. `pnpm install`, `pnpm typecheck`, `pnpm test` → all pass (tests red before step 2). Then `pnpm verify` → 8/8,
   `pnpm verify:gotchas` → strict per profile, `pnpm verify:redteam` → `violations: 0` (headless; the model key is in the
   gitignored `.env`, loaded by the npm scripts — never read or print it).

## Done criteria

- [ ] typecheck/test exit 0 (new tests red first); `pnpm verify` 8/8; gotchas strict reported; red-team 0 violations
- [ ] `git diff --stat` lists only the three in-scope paths

## STOP conditions

- A red-team or gotchas run ends `done` while its page check says the goal was not reached.

## Maintenance notes

- Evidence so far comes from one job; the reviewer re-measures Langfuse (desktop and phone) and the other suites, and
  the rule is reverted if any false DONE traces back to it.
