# Plan 073: Before a risky submit, a value the goal names but the run never used is fed back once

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: step 1 (the data check) can run at once. The code steps start only once plan 070 is on main
> (`git log --oneline -15 | rg "check confirm_target against the page"`), because both add to the `needs_confirmation`
> branch of `#handBack` in `src/task/run-task.ts`. Read that branch as 063, 069 and 070 left it. If its structure differs
> from what those plans describe, STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (adds a feedback step before risky clicks) · **Category**: bug (gate R1 margin)
- **Planned at**: commit `ea9282f`, 2026-10-16

## Why this matters

new-issue (gate R1) still fails 0/3, and one of its misses is the model submitting early:
- "Create issue" was chosen at 0.60, over the listed "bug" option at 0.40;
- the caller confirmed "Create issue", and the issue was created without its label.

The goal says "titled with the text in title, **labelled with the text in label**", and `label` was never used.

An earlier analysis (2026-10-16) found the rule unclean when **every** value counts:
- 14 passing runs tripped it, through onboard's `full_name`, which is meant for a later call, and delete-repo's
  `repository`, which is matched by the page rather than typed;
- the fix is to scope it to values **the goal names** (`with the text in <key>`, or the key word in the goal), and to make
  it a one-time **feedback**, not a hand-back.

## Current state

- `src/task/run-task.ts`:
  - A TYPE_TEXT step carries `decision.valueKey`.
  - Clicks carry `action.label`.
  - `this.#options.goal` and `this.#options.values` are known.
  - The history entry pattern for a not-executed note is the rejected-DONE note or 064's `UNSAVED_EDIT_NOTE`:
    `{ operation, element: '', not_executed: '<text>', confidence }`.
- Reports for step 1: `verify/out/worktrees/*/` and `verify/out/gates-r6/`. The analysis scripts in the scratchpad's
  `ana/` folder (`/private/tmp/claude-501/-Users-abdallah-Developer-playground-jev-browse/250e679b-29ea-4317-9eda-728b627ef14c/scratchpad/ana/b.py`)
  did the unscoped version. Reuse them.

## Scope

**In scope:**
- `src/task/run-task.ts`: tracking used values and the feedback.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause.

**Out of scope:**
- The suites' goals and values.
- The commit-risk gate.
- Hand-back statuses.

Never read `.env`. Forgejo, signup and checkout runs need your reviewer's go.

## Git workflow

Commits:
1. `test: a value the goal names is used before a risky submit`
2. `fix: feed back an unused named value once before a risky submit`

No AI attribution. Do NOT push.

## Steps

1. **Data check first (no code).** Redo the unused-value analysis, scoped. Count a value as **named** only when the goal
   mentions its key (`with the text in <key>`, `in <key>`, or the key as a word). Count it as **used** when it was typed
   (`valueKey`), selected, or clicked on a control whose label contains it. Then:
   - over every risky click (hand-back or confirmed) in the reports, list the cases with a named value unused;
   - give the job, the key, and whether the run passed.

   Target: new-issue's misses are caught and 0 passing runs are. If a passing run is caught, STOP and report it.

2. **Tests first:**
   - goal "…titled with the text in title, labelled with the text in label", `title` typed, `label` unused, model picks
     a risky "Create issue": no hand-back yet. History gets
     `not accepted: the goal names label ("bug") and it hasn't been used yet; use it before submitting, or answer BLOCKED if it can't be`,
     and the next scripted CLICK "bug" then "Create issue" proceeds as usual;
   - the same with every named value used: no note;
   - a value the goal doesn't name (onboard's `full_name`): no note;
   - the note is given once per key: the model picks the risky click again and the run proceeds as usual.

   Run them red. Commit 1.

3. **The rule.**
   - Track used values: keys typed, plus values found in the labels of executed clicks or selects.
   - In the risky-click path, before the hand-back or the execution of a confirmed click, find the first goal-named key
     that is unused and not yet noted. If there is one, push the note, mark it noted, re-observe and `continue`.
   - One comment: a submit before the goal's own values are used is the early submit a person avoids.
   - AGENTS.md: one clause in the loop-guards line.

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.

4. **Measure:**
   - `pnpm verify` → 8/8; red-team → `violations: 0`; checkout ×1.
   - When Forgejo is free: `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=new-issue,comment,milestone,delete-repo pnpm verify:forgejo`
     and `CI=1 JEV_SIGNUP_RUNS=1 pnpm verify:signup`. Report every note that fired.

## Done criteria

- [ ] Step 1 reported, with 0 passing runs caught
- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations
- [ ] Forgejo and signup reported with every note listed; `git diff --stat` lists only in-scope paths

## STOP conditions

- Step 1 catches a passing run.
- A job that passed at `5961f99` fails after a note.
