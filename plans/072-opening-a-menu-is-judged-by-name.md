# Plan 072: Opening a collapsed control is judged by its name, not by the page-level commit question

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `src/jev/decide.ts` must combine the chosen click's risk as
> `decision.commitRisk = input.pageRisk ? Math.max(decision.commitRisk ?? 0, elementRisk) : elementRisk;` (search `pageRisk ? Math.max`). Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (the irreversible-click gate) · **Category**: bug (gate R1 margin)
- **Planned at**: commit `ea9282f`, 2026-10-16

## Why this matters

Gate R1 passed at 30/33 on `5961f99`, only just over 90%. All three misses were new-issue. In two of them the run handed
back `needs_confirmation` on the issue form's "Labels" dropdown:
- the by-name risk for "Labels" is 0.01 (after plan 055 dropped its hidden menu from the name);
- but Jev's page-level `commit_risk` question ("does the next click commit something irreversible on this page?") read
  0.51–0.56 on that form, and Jev takes the higher of the two.

The page-level question reads the page, a form with a Create button, not the element. A control listed
`expanded: 'false'` (a dropdown, a menu button, a disclosure) only opens something, and that is reversible. Whatever
it opens is judged again when it is clicked.

## Current state

- `src/jev/decide.ts`, in the element-risk follow-up:
  ```ts
  if (decision.operation === 'CLICK') {
    const elementRisk = decision.elementRisks[targetIndexOf(space, 'CLICK', decision.action!)];
    decision.commitRisk = input.pageRisk ? Math.max(decision.commitRisk ?? 0, elementRisk) : elementRisk;
  }
  ```
  `input.pageRisk` is true for Jev (`src/jev/model.ts`). AGENTS.md says Jev's page-level commit risk is its verified
  baseline and must not be retuned on other models' data. This plan uses Jev's own data and changes only which question
  counts for a collapsed control.
- `src/task/run-task.ts` `#openDisclosure` computes the same combination for a rescue click (search `pageRisk ? Math.max(byName`).
- `PageAction.expanded` is `'false'` for a collapsed control (from `aria-expanded`, or `<details>` after plan 055).
- Reports for step 1: `verify/out/worktrees/*/` and `verify/out/gates-r6/` (`results.json` and `report.json`, with
  summaries, steps and hand-back reasons).

## Scope

**In scope:**
- `src/jev/decide.ts`: the combination for a collapsed chosen click.
- `src/task/run-task.ts`: the same in `#openDisclosure`.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: the commit-risk line.

**Out of scope:**
- The risk prompts, thresholds and other models' profiles.

Never read `.env`. Use the Forgejo stack only when your reviewer says it's free.

## Git workflow

Commits:
1. `test: opening a collapsed control is judged by its name`
2. `fix: judge a collapsed control by name, since opening it is reversible`

No AI attribution. Do NOT push.

## Steps

1. **Data check first (no code).** Across the reports listed above, list every `needs_confirmation` hand-back and every
   confirmed click whose clicked control was collapsed. Recognise those from the trace's action `expanded: 'false'` if
   recorded; otherwise from labels known to be triggers ("Labels", "Milestone", "Assignees", menu buttons). For each,
   give the label, the by-name risk, the page-level risk, and what clicking it did. If any was a genuinely irreversible
   click (it changed data when clicked), STOP and report: the rule would let that through.

2. **Tests first:**
   - a CLICK on an action with `expanded: 'false'`, by-name risk 0.01 and page-level 0.55 gives `commitRisk` 0.01, and
     the click runs;
   - the same with `expanded` undefined (a plain button) keeps the max (0.55): handed back;
   - a collapsed control with by-name risk 0.7 (say a "Delete…" menu button) is still handed back;
   - in `#openDisclosure`, a collapsed rescue chip is judged by name only.

   Run them red. Commit 1.

3. **The rule.** In both places, when the chosen action's `expanded === 'false'`, use the by-name risk alone. Add one
   comment: a collapsed control only opens something, and what it opens is judged when it's clicked. AGENTS.md: add
   `(a collapsed control, expanded=false, is judged by name only)` to the commit-risk sentence. `pnpm test` and
   `pnpm typecheck` → pass. Commit 2.

4. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`. Watch confirm-modal, bulk-delete and hover-delete.
   - `pnpm verify:gotchas` strict.
   - When Forgejo is free: `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=new-issue,add-label,delete-label,delete-repo pnpm verify:forgejo`.
     new-issue is 0/3 at `5961f99`; the destructive jobs must still end `needs_confirmation`.

## Done criteria

- [ ] Step 1's data check reported, with no irreversible collapsed click found
- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations; gotchas strict
- [ ] the Forgejo four reported; `git diff --stat` lists only in-scope paths

## STOP conditions

- Step 1 finds a collapsed control whose click was irreversible.
- A destructive job stops ending `needs_confirmation`.
