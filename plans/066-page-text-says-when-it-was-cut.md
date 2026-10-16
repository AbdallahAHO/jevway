# Plan 066: `page_text` says when it was cut, and carries 2500 characters

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `rg -n "PAGE_TEXT_CHARS" src/task/run-task.ts` shows `const PAGE_TEXT_CHARS = 1500;` and the one use in
> `stop()` (`page_text: page.text.slice(0, PAGE_TEXT_CHARS)`). Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (summary text only) · **Category**: contract (gate R4)
- **Planned at**: commit `06fe5c0`, 2026-10-16

## Why this matters

Every summary carries `page_text`: the final viewport's visible text, cut at 1500 characters (plan 053). An offline scan
of the saved summaries (2026-10-16) found:

| Suite | Summaries at the 1500 cap | Notes |
|---|---|---|
| Agent suite | 25 of 93 (27%) | The distribution is bimodal: short pages, or cut |
| Langfuse | 5 of 30 | |
| Forgejo | 3 of 64 | |
| Checkout, Grafana | 0 | Replayed public pages peak at 1174 characters |

**The cut lands where an agent reads.**
- On Forgejo's repository settings scrolled to the danger zone, "Transfer ownership" starts at character 1281 and "Delete
  wiki data" at 1417. The text ends at 1500 mid-item (`…cannot be undone.\nD`), so "Delete this repository" and
  "Archive this repo" are lost.
- In the last two suite runs, 4 of 4 look-not-delete agents named exactly 3 of the 4 actions, never "Archive". They
  passed only because that chore needs 2 of 4.

**The cut is silent.** Nothing tells the agent that the text ends early, so it can't know to read the rest with another
call or with chrome-devtools.

## Current state

- `src/task/run-task.ts`: `const PAGE_TEXT_CHARS = 1500;` is used in `stop()` as `page_text: page.text.slice(0, PAGE_TEXT_CHARS)`.
  The `TaskSummary.page_text` JSDoc says "viewport, first 1500 chars".
- Agent-facing text that names 1500:
  - `src/mcp.ts`: "the final page's visible text (up to 1500 characters)";
  - `skill/jev-browse/SKILL.md`: "(the visible part, up to 1500 chars)";
  - `README.md`: "(the viewport, first 1500 characters)".
- `test/jev-browse.test.ts`: `const TEXT_CAP = 1500;` and the `page_text` tests around it.
- `page.text` itself (the request's state) is capped separately and is unaffected.

## Scope

**In scope:**
- `src/task/run-task.ts`: the constant, the cut and the JSDoc.
- `src/mcp.ts`, `skill/jev-browse/SKILL.md` and `README.md`: the one phrase in each.
- `test/jev-browse.test.ts`.

**Out of scope:**
- How `page.text` is collected (viewport only).
- The request's own text cap.
- Ordering text by element.

Never read `.env`. Use the Forgejo stack and live runs only when your reviewer says so.

## Git workflow

Commits:
1. `test: page_text says how much it left out`
2. `fix: say when page_text was cut and carry 2500 characters`

No AI attribution. Do NOT push.

## Steps

1. **Tests first.**
   - A page text of 3000 characters gives a `page_text` of the first 2500 characters, followed by
     `\n…[500 more characters not shown]`.
   - A page text of 2500 characters or fewer is unchanged, with no marker.
   - Update the existing `TEXT_CAP` tests.

   Run them red. Commit 1.

2. **The change.**
   - Set `PAGE_TEXT_CHARS = 2500`.
   - In `stop()`, when `page.text.length > PAGE_TEXT_CHARS`, append `\n…[${page.text.length - PAGE_TEXT_CHARS} more characters not shown]`.
   - One comment: an agent must know the text was cut, to read the rest with another call or chrome-devtools.
   - Update the JSDoc and the three agent-facing phrases to "up to 2500 characters; a cut is marked with how much was left out".

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.

3. **Measure:**
   - `pnpm verify` → 8/8.
   - Report the median summary length change on the scripted tests if they show it.
   - When your reviewer says credits are back and Forgejo is free:
     `JEV_AGENT_RUNS=2 JEV_AGENT_ONLY=look-not-delete pnpm verify:agent`. Each answer should now name all 4 danger-zone
     actions, against 3 of 4 before. Also report the summary's `page_text` length and whether it carried the marker.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8
- [ ] look-not-delete ×2 reported (when live runs are possible)
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- Any test or file outside the scope needs changing for the cap.

## Maintenance notes

- If text near the element a run scrolled to turns out to matter more than a larger cap, the next step is head-and-tail
  text with a marker. It costs nothing extra, but it cuts the middle, where lists live, so measure it first.
