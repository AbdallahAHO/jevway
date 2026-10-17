# Plan 084: The toggle note says whether anything was clicked to save it, and a rejected DONE says so too

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 081 must be on main (`git log --oneline -15 | rg "feed back a click that would undo the run's own toggle"`).
> `src/task/run-task.ts` must have `#toggled`, `#recordToggle`, `#undoesOwnToggle`, the note text starting
> `not accepted: "${undo.label}" is now ${state} because this run clicked it`, and the rejected-DONE note
> `rejected: "${doneWhen}" is not visible yet; keep working toward it`. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: LOW (wording of two notes, plus one boolean per toggle) · **Category**: bug (gate R1)
- **Planned at**: commit `a5fab89`, 2026-10-17

## Why this matters

Plan 081 stops a run from flipping back a checkbox it just flipped. Its note gives Jev three choices:

> not accepted: "Enable repository wiki" is now unchecked because this run clicked it; clicking it again undoes that.
> Save the change (a Save or Update button) if it isn't saved yet, answer DONE if the goal is met, or BLOCKED

The note fired at different points:
- **081's ×5 measurement:** it fired only *after* Save, Jev answered DONE, and the run was right 3/3.
- **Round-8 R1 gate, wiki-off #3:** it fired *before* any save:
  1. Settings → Units → "Wiki — Repository";
  2. CLICK "Enable repository wiki", which unticks it;
  3. the model picks the box again (0.66, with "Save settings" second at 0.37), and the note fires;
  4. Jev answers DONE three times. The done check is 0.15, 0.32, 0.40, each rejected with the generic `rejected: … is not visible yet; keep working toward it`;
  5. the run ends `uncertain` (`MAX_REJECTED_DONE`) and never saves. `has_wiki` stays true.

Jev can't tell whether the change was saved, and the note leaves it to guess. The run itself knows whether anything was
clicked on that page after the toggle. Saying that plainly removes the guess:
- **nothing clicked since:** save it;
- **something clicked since:** DONE if met.

The rejected DONE should say the same.

## Current state

`src/task/run-task.ts` (after 081):
- `#toggled = new Map<string, { label: string; checked: string; noted: boolean }>()`, keyed `toggleKey(path, label)`.
- **Recording.** `#recordToggle(action, pathBefore, page)` runs after every executed CLICK. It records `{ label, checked: now.checked, noted: false }` when the click flipped a checkbox or switch on the same path.
- **The note.** The loop block after 077's note:

  ```ts
  const undo = this.#undoesOwnToggle(decision, page);
  if (undo) {
    record(false);
    const state = undo.checked === 'true' ? 'checked' : 'unchecked';
    if (undo.noted) return stop('blocked', `Jev chose "${undo.label}" again, …`, decision);
    undo.noted = true;
    this.#history.push({ …, not_executed: `not accepted: "${undo.label}" is now ${state} because this run clicked it; clicking it again undoes that. Save the change (a Save or Update button) if it isn't saved yet, answer DONE if the goal is met, or BLOCKED`, … });
    …
  }
  ```
- **The rejected DONE**, earlier in the loop:
  `if (decision.operation === 'DONE' && doneWhen && (decision.doneProbability ?? 0) < 0.5) { record(false); if (++rejectedDone >= MAX_REJECTED_DONE) return stop('uncertain', …); this.#history.push({ operation: 'DONE', element: '', not_executed: \`rejected: "${doneWhen}" is not visible yet; keep working toward it\`, … }); … }`.
- **Tests:** 081's describe in `test/jev-browse.test.ts` (search `is now unchecked because this run clicked it`) has
  `wikiPages()` and the scripted flows to copy.

## Scope

**In scope:**
- `src/task/run-task.ts`: a `clickedAfter` field on each toggle record, the two note texts, and the rejected-DONE suffix.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: adjust 081's clause.

**Out of scope:**
- 081's matching and its blocked repeat.
- 064's `#sendBackUnsavedEdit`.
- `MAX_REJECTED_DONE`.
- Any label heuristic for what "Save" looks like.

Never read `.env`. The Forgejo stack is shared: run it only holding the lock (see your instructions).

## Git workflow

Commits:
1. `test: the toggle note says whether anything was clicked after the toggle`
2. `fix: say whether a toggle was followed by a click when noting it`

Lowercase conventional commits. **No AI attribution of any kind**: no Co-Authored-By, no "Generated with", no
session links or trailers, no mention of an AI assistant. Do NOT push.

## Steps

1. **Tests first** (extend 081's describe):
   - **Nothing clicked since.** Untick, then the model picks the box again. The note reads
     `not accepted: "Enable repository wiki" is now unchecked because this run clicked it, and nothing on this page was clicked after it to save it; clicking it again undoes it. Save it (a Save or Update button), or answer BLOCKED`.
     The next scripted CLICK "Save settings" proceeds.
   - **Something clicked since.** Untick, CLICK "Save settings" (same path), then the box again. The note reads
     `not accepted: "Enable repository wiki" is now unchecked because this run clicked it, and "Save settings" was clicked after it; clicking it again undoes it. Answer DONE if the goal is met, or BLOCKED`.
   - **Scrolls and waits don't count.** A SCROLL_DOWN between the toggle and the repeat still gives the "nothing clicked" note.
   - **Rejected DONE.** Untick, then DONE with the done check at 0.2. History gets
     `rejected: "<doneWhen>" is not visible yet; "Enable repository wiki" was changed and nothing on this page was clicked after it to save it`.
     With a click since, it is today's text, unchanged.
   - **Other paths unaffected.** A toggle on another path leaves both notes as today.

   Run them red. Commit 1.
2. **The rule.**
   - Add `clickedAfter?: string` (a label) to the toggle record.
   - After every executed CLICK that is not itself the toggle being recorded, set `clickedAfter = bareLabel(action.label)` on every record of that click's path (`pathBefore`) that has none yet. Recording a fresh flip resets it to undefined.
   - **The note.** Choose its text by `clickedAfter`, as in the tests.
   - **The rejected DONE.** Find a record on the current path with no `clickedAfter` and the page still showing its recorded `checked` state. If there is one, use the suffix above in place of `; keep working toward it`.
   - One comment: Jev can't see whether a change was saved; the run knows whether anything was clicked after it, so the note says which, instead of asking it to guess.
   - AGENTS.md: in 081's clause, replace `("save it, or answer DONE")` with
     `(saying whether anything on the page was clicked after it: if not, save it; if so, DONE if met)`, and add that
     a rejected DONE names an unsaved toggle the same way.

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.
3. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`; `pnpm verify:gotchas` strict per profile (it has a
     `toggle-trap` fixture; report it).
   - Holding the Forgejo lock:
     - `CI=1 JEV_FORGEJO_RUNS=6 JEV_FORGEJO_ONLY=wiki-off pnpm verify:forgejo`;
     - `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=description pnpm verify:forgejo`;
     - `JEV_AGENT_RUNS=2 JEV_AGENT_ONLY=settings pnpm verify:agent`.

     Report every note (which text), what came next, and the final `has_wiki`.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0; gotchas strict
- [ ] wiki-off ×6 reported (target 6/6, 0 runs ending on rejected DONEs before a save), description ×3 and settings ×2 reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- A run ends `done` with the wiki still on (`has_wiki` true).
- description or settings fails because of a note.
