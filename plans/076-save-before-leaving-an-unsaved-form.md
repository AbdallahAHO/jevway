# Plan 076: A click that would leave an unsaved form is fed back as "save first", not repeated or handed to the user

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 071 must be on main (`git log --oneline -20 | rg "answer OK to the confirm dialog a confirmed click opens"`),
> because both change the dialog path. Read `#reportDialogs`, `describeDialog` and 064's `#unsavedEdit` in `src/task/run-task.ts`. Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: MED (changes a dialog hand-back) · **Category**: bug (gate R4 quality)
- **Planned at**: commit `913470b`, 2026-10-16

## Why this matters

In the round-6 R4 gate, the settings chore handed back `blocked` in both runs. The trail was:
1. TYPE_TEXT Description;
2. CLICK Units;
3. CLICK "Wiki — Repository", which raised Forgejo's "leave with unsaved changes?" `beforeunload`. Plan 061 answered
   Stay and noted it on the step;
4. the model clicked the same link again, and the run ended `blocked` with "The page keeps asking (beforeunload dialog)…
   ask the user how to proceed".

The agent re-planned with "description typed but not saved; save first", clicked Save once, and finished. Two things
went wrong:
- the model repeated a click it had seen annotated;
- the reason pointed at the user instead of the run's own unsaved edit. "Save settings" was already candidate #2 or #3
  (0.18 and 0.33).

Any site with an unsaved-changes guard produces this.

## Current state

- `src/browser/tab.ts` `#answerDialog`: a `beforeunload` is answered Stay (`accept: false`) and recorded.
- `src/task/run-task.ts`:
  - `#reportDialogs(firstStep)` appends `(the page then asked whether to leave the page; stayed on it)` to the step.
  - The second identical non-alert dialog returns the reason
    `The page keeps asking … (beforeunload dialog). jev-browse only answers Cancel to these; ask the user how to proceed.`
  - 064's `#unsavedEdit` is set while the last executed step changed a field. Plan 063's `#typedFields` lists the
    fields typed on each path.
  - The `#refusedForValue` pattern feeds a wrong step back once, as a not-executed history entry, before handing back.

## Scope

**In scope:**
- `src/task/run-task.ts`: the beforeunload-after-click handling.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: the dialog invariant.

**Out of scope:**
- `tab.ts`'s answers (Stay stays Stay).
- Other dialog types.
- Plan 071's arm.

Never read `.env`. Forgejo only on your reviewer's go.

## Git workflow

Commits:
1. `test: a click that would leave an unsaved form is fed back as save first`
2. `fix: tell Jev to save before a click that would leave an unsaved form`

No AI attribution. Do NOT push.

## Steps

1. **Tests first** (`fakeTab`):
   - **The note.** TYPE_TEXT "Description", then a CLICK on a link. The fake tab reports one `beforeunload` (Stay), and
     the page is unchanged. The history entry for that click shows `not_executed: 'this link would leave the page with
     unsaved text in "Description"; save it first (a Save or Update button), or answer BLOCKED'`. No hand-back.
   - **Second time.** The model picks the same link again and the dialog returns. The run ends `blocked` with
     `Leaving the page would discard the unsaved text in "Description" (the page asked before leaving); save it first, or ask the user whether to discard it.`
   - **No unsaved edit.** A `beforeunload` with no typed field on this path keeps today's behaviour and reason.

   Run them red. Commit 1.

2. **The rule.**
   - When `#reportDialogs` sees a `beforeunload` right after an executed CLICK, and this path has typed fields
     (`#typedFields` for the current path) or `#unsavedEdit` is set:
     - **First time for that click's node:** rewrite that step's history entry to the not-executed note above. Name the
       last typed field, quoted.
     - **The repeat:** end `blocked` with the save-first reason instead of the generic one.
   - One comment: a page asking before you leave means the run's own edit isn't saved, and a person saves first.
   - AGENTS.md dialog invariant: append `a beforeunload after a click on a page with unsaved typed text is fed back once as "save first", then handed back naming the field.`

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.

3. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`; `pnpm verify:reader` all pass (dialogs fixture).
   - When Forgejo is free: `JEV_AGENT_RUNS=2 JEV_AGENT_ONLY=settings pnpm verify:agent` (blocked ×2 at `5961f99`), and
     `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=description,wiki-off pnpm verify:forgejo`.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations; reader all pass
- [ ] the settings chore and the Forgejo pair reported; `git diff --stat` lists only in-scope paths

## STOP conditions

- The note ever leads to a click that discards typed text (a dialog answered OK). Only Stay is allowed.
