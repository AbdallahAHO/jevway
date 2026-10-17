# Plan 081: A checkbox or switch this run flipped is not flipped back: fed back once ("save it, or it's done"), then handed back

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: in `src/task/run-task.ts`, these must exist: `isUnsavedEdit`, `#unsavedEdit`, plan 077's
> `#unpickedMenuValue` and its `not accepted: the menu you opened lists …` note in the loop, and `update(patch)`. Otherwise
> STOP. Plan 082 edits the same loop region: if your reviewer says 082 is merged first, rebase and keep both notes.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: MED (a new feedback step on toggle clicks) · **Category**: bug (gates R1 and R4 quality)
- **Planned at**: commit `d8b4fb5`, 2026-10-17

## Why this matters

wiki-off ("Turn off the wiki for this repository") was 2/3 at the round-7 gate. The trail in each run:

| Run | What happened | Outcome |
|---|---|---|
| 1 | Settings → Units → "Wiki — Repository" → CLICK "Enable repository wiki" (unticks it, right). Then CLICK it again at 0.67 (ticks it), again at 0.97, again at 0.63, with "Save settings" second each time at 0.30–0.35. Never saved. | `blocked` by the A/B toggle guard (4×) |
| 2 | Unticks it, saves, done | pass |
| 3 | Unticks it, saves, then re-ticks it, unticks, saves, and keeps toggling 4 more times. It passed only because it stopped on an even count. | pass, by luck |

In the R4 real-agent settings chore ("change the description and turn off its wiki") the same loop after a Save that
already worked cost a re-plan in both runs: `uncertain` after 6 unsure toggles, and `blocked` after a correct
"Wiki is disabled" done.

The reader is right. A live probe (2026-10-17) shows "Enable repository wiki" as `role: 'checkbox'`, with `checked`
flipping `"true" → "false" → "true"` click by click, same node. The model sees the box is unchecked and still picks it
(about 0.6) over Save, because "the wiki checkbox" is what the goal is about. Re-ticking it after a save is worse than a
loop: run 3 shows the run writing the wrong state, then luckily writing the right one again.

A person who just unticked a box doesn't click it again; they save, or they're done.

## Current state

`src/task/run-task.ts`:
- **The executed-step path** records the click, observes, pushes history, then
  `this.#unsavedEdit = isUnsavedEdit(decision.operation, action, page) ? { noted: false, label: action.label } : undefined;`.
  `action` is the clicked `PageAction` *before* the click, and its `checked` is the state the model saw. `page` is the
  page after.
- **`isUnsavedEdit`** treats `['checkbox', 'radio', 'switch'].includes(action.role ?? '') || action.checked !== undefined`
  as a tick.
- **Plan 077's note** sits in the loop just before `const handBack = this.#handBack(decision, page);`:

  ```ts
  const unpicked = this.#unpickedMenuValue(decision, page);
  if (unpicked) {
    this.#pickNoted.add(`${unpicked.option.node}:${unpicked.key}`);
    record(false);
    this.#history.push({ operation: decision.operation, element: '', not_executed: `not accepted: …`, confidence: round(decision.confidence) });
    page = await this.#tab.observe();
    continue;
  }
  ```
- **`pathOf(url)` and `bareLabel(label)`** exist. Node ids are renumbered when a save reloads the page, so key toggles by
  path and label, not by node.
- **`update(patch)`** merges a new goal, values or a confirmation for the next call in the same session. Per-run records
  like `#submits` are not reset there.
- Tests: `test/jev-browse.test.ts`. 077's `describe` (search `lists "bug" (label)`) and 076's tests (search
  `save it first`) show `fakeTab` pages and scripted decisions.

## Scope

**In scope:**
- `src/task/run-task.ts`: the toggle record, the note, and the hand-back.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause in the loop-guards line.

**Out of scope:**
- Radios. Clicking a radio again changes nothing, and picking another radio isn't an undo.
- The A/B toggle guard.
- 076's beforeunload note.
- The model's rules and prompts.

Never read `.env`. The Forgejo stack is shared: run it only on your reviewer's "forgejo free", holding the lock.

## Git workflow

Commits:
1. `test: a checkbox the run flipped is not flipped back without a word`
2. `fix: feed back a click that would undo the run's own toggle`

Lowercase conventional commits. **No AI attribution of any kind**: no Co-Authored-By, no "Generated with", no
session links or trailers, no mention of an AI assistant. Do NOT push.

## Steps

1. **Data check first (no code).** Across the reports under
   `/Users/abdallah/Developer/playground/jev-browse/verify/out/worktrees/*/` (forgejo, agent, signup, checkout, langfuse,
   grafana, gotchas), find every run that executed a CLICK on the **same checkbox or switch label 2+ times**.
   - **Finding them.** `trace.json` decisions carry `action` (the label) and `executed`. Decide whether a label is a
     checkbox or switch from the app: for Forgejo labels, use the reader on the live page, under the lock; for fixtures,
     read the HTML.
   - **Classifying them.**
     - **Correction:** the run fixed a wrong tick, and the outcome needed the second click.
     - **Undo:** it toggled back for no reason.

     Give the job, the outcome and the count.
   - **What decides the repeat in step 3:** if there are **0 corrections**, the repeat hands back `blocked` without
     executing. If any correction is needed for a passing run, the repeat executes (the usual once-pattern) and the win
     is the note alone. Report which.
2. **Tests first** (`fakeTab`):
   - **The note.** The page lists checkbox "Enable repository wiki" (`checked: 'true'`) and a button "Save settings".
     CLICK it, and the next page shows it `checked: 'false'`. The model picks it again. It is not acted on, and the history
     gets
     `not accepted: "Enable repository wiki" is now unchecked because this run clicked it; clicking it again undoes that. Save the change (a Save or Update button) if it isn't saved yet, answer DONE if the goal is met, or BLOCKED`.
     The next scripted CLICK "Save settings" proceeds.
   - **After a save.** Same toggle, then "Save settings" reloads the page (new node ids, same path, still unchecked). A
     third pick of the checkbox is still noted. Key by path and label.
   - **The repeat.** The model picks it again after the note. Per step 1, either it ends `blocked` with
     `Jev chose "Enable repository wiki" again, which would undo this run's own change (it is now unchecked); say which state it should end in.`
     and isn't acted on, or it is acted on.
   - **No note for:** a checkbox the run never clicked; a different checkbox; a radio; a checkbox on another path; a
     checkbox whose current state no longer matches what the run left (the page changed it, so the click isn't an undo).
   - **A new goal clears it.** After `update({ goal: 'Turn the wiki back on' })`, the same click is not noted.

   Run them red. Commit 1.
3. **The rule.**
   - A field `#toggled = new Map<string, { label: string; checked: string }>()`, keyed `${path}\u0000${bareLabel(label)}`.
   - **Recording.** In the executed path, after `page` is re-observed: when the click was on a checkbox or switch (role
     `checkbox` or `switch`, or `checked` defined, but not role `radio`), and the page after lists an action with the same
     label on the same path whose `checked` differs from `action.checked`, record `{ label, checked: <after> }`.
   - **The check.** In the loop, right after 077's note: a CLICK whose action is such a control, whose key is in
     `#toggled`, and whose current `checked` equals the recorded one, would undo the run's own change.
     - First time per key: push the note above (`unchecked` or `checked` from the recorded state), `record(false)`,
       re-observe, `continue`.
     - Second time: as step 1 decided.
   - **New goal.** In `update()`, when `patch.goal` is given and differs from the current goal, clear `#toggled` and the
     noted set.
   - One comment: a person who just flipped a box doesn't flip it back; they save, or they're done.
   - AGENTS.md loop-guards: add the clause
     `a click that would flip back a checkbox or switch this run flipped (same path and label, state unchanged since) is fed back once ("save it, or answer DONE"), then <handed back blocked | runs>`.

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.
4. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`; `pnpm verify:reader` all pass; `pnpm verify:gotchas`
     strict per profile.
   - When Forgejo is free:
     - `CI=1 JEV_FORGEJO_RUNS=5 JEV_FORGEJO_ONLY=wiki-off pnpm verify:forgejo`;
     - `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=description,protect-main pnpm verify:forgejo`. protect-main ticks
       checkboxes in the branch-protection form.
     - `JEV_AGENT_RUNS=2 JEV_AGENT_ONLY=settings pnpm verify:agent`.

     Report every note and hand-back, actions per run, toggles executed after a Save on the same path (target 0), and
     the settings chore's re-plans (round 7: 2 of 4 hand-backs).

## Done criteria

- [ ] Step 1 reported with the count and the decision for the repeat
- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0; reader all pass; gotchas strict
- [ ] wiki-off ×5, description and protect-main ×3, and the settings chore ×2 reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- A job that passed at `d8b4fb5` (description, protect-main, settings) fails because of the note.
- The note ever leads to a click that writes the wrong state (wiki left on after the run ends `done`).

## Maintenance note

The key is path plus label. A page with two checkboxes of the same label on one path (repeated rows) would share a key.
If that shows up, add the row context to the key.
