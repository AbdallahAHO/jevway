# Plan 077: With a menu the run opened still showing a supplied value, a risky submit elsewhere is fed back once: pick it first

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 072 must be on main (`git log --oneline -10 | rg "judge a collapsed control by name"`), and plan 067's
> `#openedByRun` must exist in `src/task/run-task.ts`. The code steps also need plan 070 merged (`rg "check confirm_target"` in the log),
> because both touch the risky-click path of `#handBack`. Step 1 can run at once. Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (a feedback step before risky clicks) · **Category**: bug (gate R1 margin)
- **Planned at**: commit `2b43357`, 2026-10-16

## Why this matters

After plan 072, new-issue (gate R1) no longer hands back on its "Labels" dropdown, but it still fails 3/3:
1. CLICK Labels opens the menu, with "bug" listed as an option.
2. The model then picks "Create issue" (0.71–0.77) over "bug".
3. The caller confirms, and the issue is created without its label.

The goal names `label: "bug"`.

Plan 073 tried a broad version ("a value the goal names is unused at a risky click") and was dropped at its data check.
It caught 18 passing runs: delete-repo's correct wrong-repo hand-backs, and agents splitting a chore across calls. This
plan is much narrower. It fires only when all of these hold:
- a menu the run itself opened (plan 067's `#openedByRun`) is **still open**;
- that menu lists an option whose label contains a supplied value that **hasn't been used**;
- the model picks a risky click on something **else**.

A person who opened the label menu picks the label before pressing Create.

## Current state

- `src/task/run-task.ts`:
  - `#openedByRun` holds the nodes the run's own click flipped to `expanded: 'true'` (plan 067).
  - `#handBack(decision, page)` holds the risky-click branch: 063's rejected-submit check, then 070's target check if
    confirmed, then `needs_confirmation`.
  - The not-executed history pattern is `{ operation, element: '', not_executed, confidence }`, as in 064's note.
- `page.actions` lists the open menu's options with their labels (role `option` or `menuitem`, plus checkboxes in pickers).
- Reports for step 1: `verify/out/worktrees/*/`, `verify/out/gates-r6/`, and the 072 run at
  `/Users/abdallah/Developer/worktrees/AbdallahAHO/jev-browse/exec-072-collapsed-risk/verify/out/forgejo-2026-10-16T19-39-51-817Z/`.
  Plan 073's scripts are in the scratchpad's `ana73/`.

## Scope

**In scope:**
- `src/task/run-task.ts`: the narrow feedback in the risky-click path.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause.

**Out of scope:**
- The broad unused-value idea (073, rejected).
- The commit-risk gate.

Never read `.env`. Forgejo only on your reviewer's go.

## Git workflow

Commits:
1. `test: a risky submit waits while the menu the run opened still lists a supplied value`
2. `fix: pick the supplied value from the menu you opened before submitting`

No AI attribution. Do NOT push.

## Steps

1. **Data check first (no code).** In the reports, find every risky click (hand-back or confirmed) chosen right after a
   click that opened a menu, while that menu's options included one containing an unused supplied value. Approximate
   from the traces: the previous step clicked a known trigger, and the risky decision's candidates or the step's page
   list an option with the value. Give the job and the outcome. Target: new-issue's misses are caught, and 0 passing runs
   are (delete-repo has no open menu; the agent triage calls don't open a menu right before Comment). If a passing run is
   caught, STOP and report.
2. **Tests first:**
   - **Fires.** Labels opened by the run (in `#openedByRun`, still expanded), option "bug" listed, value
     `label: 'bug'` unused, model picks risky "Create issue": no hand-back. History gets
     `not accepted: the menu you opened lists "bug" (label) and it isn't picked yet; pick it first, or answer BLOCKED`.
     The next scripted CLICK "bug", then "Create issue", proceeds as usual.
   - **Value already used.** No note.
   - **No menu open,** or a menu the page opened itself: no note.
   - **Once per node and value.** The second time, the run proceeds as usual.

   Run them red. Commit 1.
3. **The rule.** Implement exactly those conditions, ahead of the hand-back and confirmed-click checks in the risky
   path. Push the note, re-observe and `continue`. Add one comment. AGENTS.md: one clause in the loop-guards line.
   `pnpm test` and `pnpm typecheck` → pass. Commit 2.
4. **Measure:**
   - `pnpm verify` → 8/8; red-team → `violations: 0`.
   - When Forgejo is free: `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=new-issue,add-label,delete-repo,comment pnpm verify:forgejo`.
     Report every note.

## Done criteria

- [ ] Step 1 reported, with 0 passing runs caught
- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations
- [ ] Forgejo reported with every note; `git diff --stat` lists only in-scope paths

## STOP conditions

- Step 1 catches a passing run.
- A job that passed before fails after a note.
