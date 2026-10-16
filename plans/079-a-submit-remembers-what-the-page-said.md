# Plan 079: What the page said after a submit stays in the run's history, so scrolling away doesn't lose the evidence

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 063's `#submits` (with `answer` = new text after a risky click) and `newTextOf` must exist in
> `src/task/run-task.ts`. Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (adds a history note) · **Category**: bug (gate R4 quality, R1)
- **Planned at**: commit `4966d16`, 2026-10-16

## Why this matters

In the R4 settings chore (round 6, H16, and again in 075's run):
1. the run clicked "Save settings";
2. Forgejo showed its green "Your settings have been updated" flash at the top;
3. the run scrolled down three times, so the flash left the viewport;
4. DONE was rejected twice at a done check of 0.05, and the run ended `uncertain`.

The work was done, and the agent needed another call to see it. The reader keeps only viewport text (`page.text`), and
the history doesn't say what the page answered.

Plan 063 already records, after every risky click, the new text the page showed (`answer`). It uses that only to hand
back a rejected re-submit. Putting that answer into the step's history entry keeps the evidence in front of Jev and the
done check, wherever the run scrolls next.

## Current state

- `src/task/run-task.ts`:
  - After an executed risky click, `#submits` gets `{ label, path, fields, textBefore, answer }`, where
    `answer = newTextOf(page.text, textBefore)`, capped at 300 characters, with timing-only lines dropped.
  - The step's history entry was just pushed: `{ operation, element, page_changed, confidence, … }`. Plan 061's dialog
    notes append to `element` in the same way (`#reportDialogs`).
- History goes into every Jev request (`history` in the decision input), so the done check sees it.

## Scope

**In scope:**
- `src/task/run-task.ts`: appending the answer to the risky click's history entry.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause.

**Out of scope:**
- Viewport text collection (`snapshot.js`).
- 063's hand-back.
- Other non-risky clicks.

**Revision (2026-10-16):** the settings chore's "Save settings" is never a risky click (it ran without confirmation),
so it never reaches `#submits`. The note is therefore recorded for risky clicks **and** for an executed CLICK that is not
itself an edit while 064's `#unsavedEdit` is set: the save of what the run just edited. A navigation click with nothing
unsaved gets no note.

Never read `.env`. Forgejo only on your reviewer's go.

## Git workflow

Commits:
1. `test: what the page said after a submit stays in the history`
2. `fix: note what the page said after a submit on that step`

No AI attribution. Do NOT push.

## Steps

1. **Tests first:**
   - **The note.** A risky "Save settings" click executes, and the next page text has the new line "Your settings have
     been updated." Jev's next request shows that step's `element` ending with
     ` (the page then said: "Your settings have been updated.")`.
   - **It survives scrolling.** After two SCROLL_DOWN steps the flash line is gone from `page.text`, but the history still carries it.
   - **No new text, no note.**
   - **The cap holds.** The quote stays at or under 300 characters.

   Run them red. Commit 1.
2. **The rule.** Right after the `#submits` record gets its `answer`, append
   ` (the page then said: "<answer>")` to that step's history `element` when `answer` is non-empty. Use the same pattern
   as the dialog notes, and keep the quote as untrusted page text, capped. One comment: the outcome a page shows after a
   submit is the evidence the done check needs, and it scrolls away with the viewport. AGENTS.md: one clause.
   `pnpm test` and `pnpm typecheck` → pass. Commit 2.
3. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`. The quote is page text, and red-team's injected-text
     pages must not cause a violation.
   - When Forgejo is free:
     - `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=description,wiki-off,milestone,protect-main pnpm verify:forgejo`;
     - `JEV_AGENT_RUNS=2 JEV_AGENT_ONLY=settings pnpm verify:agent`.

     Report the done checks after Save, and the re-plans.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations
- [ ] Forgejo four and the settings chore reported; `git diff --stat` lists only in-scope paths

## STOP conditions

- A red-team violation, or an injected instruction quoted through this note changing what the run clicks.
