# Plan 064: DONE right after an unsaved edit needs stronger evidence

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: in `src/task/run-task.ts`, the DONE acceptance (search `rejectedDone` and `DONE_EVIDENT`) must be as
> quoted below. Plans 056, 057, 059, 061, 062 or 063 may have changed other parts of the file; that's fine. If the DONE paths differ, STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (when a run may say done) · **Category**: bug (gate R1)
- **Planned at**: commit `65202a4`, 2026-10-16

## Why this matters

On Forgejo (gate R1), two runs ended `done` on a settings page with the change typed or ticked but never saved:
- **description #2:** TYPE_TEXT Description, then DONE. The done check was 0.61 for "The repository page shows the new
  description", because the field itself shows the text.
- **wiki-off #3:** clicked "Enable repository wiki" 3×, then DONE. The done check was 0.52 for "The repository settings were
  saved with the wiki off".

A person types, then clicks Save. An analysis of 98 reports (162 runs ending `done`, 84 of them after an edit) found that
"the last executed step was an edit (TYPE_TEXT, or a checkbox click) with no click after it, and done check below 0.75"
flagged exactly these 2 false DONEs and **0** of the passing runs:
- 67 runs passed with a save or submit click after the last edit.
- 4 passing runs had a done check below 0.75, all of them with a save after the edit.
- One boundary case: wiki-off #2 passed with trailing toggles at exactly 0.75. So the bar is `< 0.75`, never `<=`.

The sample of edit-then-DONE runs is thin (4 runs), and it covers only the write suites. Langfuse and Grafana
(filters, toggles) aren't in it, so step 1 checks them before any code changes.

## Current state

`src/task/run-task.ts`, in the loop:
- **Auto-done:** `doneProbability >= DONE_EVIDENT` (0.9) once, or `>= GUARDS.doneSteady` (0.75) on `doneSustained` decisions
  in a row, ends `done`. These are already ≥ 0.75, so this plan doesn't touch them.
- **Rejected DONE:** `rejectedDone = decision.operation === 'DONE' && !!doneWhen && doneProbability < 0.5`. A rejected
  DONE goes into history as "not visible yet" (read how) and the loop continues.
- **BLOCKED with done ≥ 0.5:** it is `done` (AGENTS.md: "A BLOCKED whose `done_when` Noul is ≥ 0.5 is `done` too").
- The history `StepRecord`s (`operation`, `element`, `value_key`, …) show what executed. TYPE_TEXT carries the field's
  label. A checkbox click is a CLICK on an action whose `checked` is defined, or whose role is `checkbox`, `radio` or
  `switch`. Read `PageAction` in `src/browser/tab.ts` to confirm the fields.
- `isSearchLike(field)` already exists. Typing into a search or filter field is not an edit to save.

## Scope

**In scope:**
- `src/task/run-task.ts`: the DONE acceptance for operation DONE and for BLOCKED-as-done only.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause in the `done` invariant.

**Out of scope:**
- The auto-done paths at ≥ 0.75 and 0.9.
- The done-check prompts.
- The suites' `doneWhen`.

Use the Forgejo stack only when your reviewer says it's free, and never touch 9333 or 9444 without their go. Never read `.env`.

## Git workflow

Commits:
1. `test: done right after an unsaved edit needs a stronger check`
2. `fix: ask for stronger done evidence right after an unsaved edit`

No AI attribution. Do NOT push.

## Steps

1. **Data check first (no code).** Over every `results.json` / `trace.json` under the worktrees' `verify/out/` for
   **Langfuse, Grafana, gotchas and checkout**, list each run that ended `done` with:
   - its last executed step an edit (TYPE_TEXT into a field that isn't search-like, or a click on a checkbox, radio or
     switch);
   - no click after that edit;
   - a done check in [0.5, 0.75).

   Give the job, the step, the done check and whether it passed. If **any passing run** shows up, STOP and report:
   the rule would cost a pass. The analysis scripts in
   `/private/tmp/claude-501/-Users-abdallah-Developer-playground-jev-browse/250e679b-29ea-4317-9eda-728b627ef14c/scratchpad/ana/`
   (`collect.py`, `a.py`) did this for the write suites; reuse them.

2. **Tests first** (scripted, offline):
   - TYPE_TEXT into "Description", then DONE with a done check of 0.61. The run does **not** end; history gets the
     note, and the next scripted CLICK "Save settings" then DONE at 0.61 ends `done`.
   - A checkbox click, then BLOCKED with a done check of 0.6: not `done`, the note is added, and the loop continues.
   - TYPE_TEXT, then DONE at 0.8: `done` (above the bar).
   - TYPE_TEXT into a search-like field, then DONE at 0.6: `done` (not an edit to save).
   - The note is given only once per edit: the same DONE at 0.61 again with no new action ends `done`, so it can't loop.

   Run them red. Commit 1.

3. **The rule.**
   - When the last executed step is an edit and no click came after it, an operation DONE or a BLOCKED-as-done needs a
     done check of ≥ 0.75. Under that (and ≥ 0.5), don't stop. Push a history entry:
     `{ operation: 'DONE', element: 'not accepted: the last step changed a field and nothing was saved or submitted since', page_changed: false }`,
     then continue the loop.
   - Mark that edit as noted, so a second DONE on the same edit is accepted under today's rules.
   - One comment: a typed or ticked change isn't done until it's saved; a person clicks Save.
   - `pnpm test` and `pnpm typecheck` → pass. AGENTS.md, appended to the `done` invariant: `right after an unsaved edit
     (typed or ticked, no click since) a DONE or BLOCKED needs the done check ≥ 0.75 once.` Commit 2.

4. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:gotchas` strict; `pnpm verify:redteam` → `violations: 0`.
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → 8/8; `CI=1 JEV_CHECKOUT_RUNS=2 pnpm verify:checkout` → report.
   - When your reviewer says the stack is free: `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=description,wiki-off,comment,milestone pnpm verify:forgejo`.
     Also run `CI=1 JEV_SIGNUP_RUNS=2 JEV_SIGNUP_ONLY=onboard pnpm verify:signup`. Report every run where the note fired.

## Done criteria

- [ ] Step 1's data check reported, with 0 passing runs flagged
- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations; gotchas strict
- [ ] the Forgejo and signup runs reported, with every note listed; `git diff --stat` lists only in-scope paths

## STOP conditions

- Step 1 flags a passing run.
- A job that passed before now ends `step_budget` or `uncertain` after the note.

## Maintenance notes

- The 0.75 bar sits on a boundary run (wiki-off #2 passed at exactly 0.75). Keep `< 0.75`.
- A dropdown option that applies on close (Forgejo's label picker) is a different gap: the menu is still open when DONE
  is said. This plan doesn't cover it.
