# Plan 099: The caller's checks on the final page confirm or overturn `done`

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/task/run-task.ts` must have `export type TaskStatus = 'done' | 'needs_input' | 'needs_confirmation' | 'uncertain' | 'blocked' | 'step_budget';`
>   and the `stop` closure inside `#loop()` that builds every `TaskSummary`.
> - `run()` must be `await this.#recording?.start(...)`, `const summary = await this.#loop();`, then
>   `await this.#recording?.finish(this.#tab, summary)`.
> - `src/mcp.ts` must register `browser_task` with a `done_when` input.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (a status can change after the loop; no new action, no change to Jev's request) · **Category**: caller contract
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

`done` is Jev's judgment. The calling agent often knows facts that settle it for certain: the address it should end on,
a word that must show, a field that must hold a value. Today it can only read `page_text` and compare by itself
(`docs/prior-art.md` K1; "Today: `done` is judged by the `done_when` model check only; ground-truth checks live in
`verify/`"). Our own suites prove the gap: every suite judges by ground truth, never by `status` (AGENTS.md
"Verification asserts ground truth"), because `done` and the goal disagree in both directions:

- **A false `done`.** `verify/out/real-2026-10-18T08-24-16-820Z/booking-*.json`: 3 runs ended `done` on Booking's
  dateless city page (plans/LOG.md, 2026-10-18).
- **A finished task handed back.** Forgejo wiki-off and Langfuse runs end `uncertain` or `blocked` on a page that already
  shows the change (plans/LOG.md round 8: "wiki-off run 3, `uncertain`").

jiawei686's `browser_goal(goal, url, verify=[…])` checks by code afterwards and lets the page win
(`jev_ultrafast_mcp/assertions.py:16-63`, override at `jev_ultrafast_mcp/server.py:581-608`). Its own comments record
both directions: "status: done twice while the points balance had not moved", and a check-in button that is gone after
the click, so the model says BLOCKED on a goal that succeeded.

## Current state

- `src/task/run-task.ts:44` `TaskStatus`; `:46-61` `TaskSummary`; `:256-262` `run()`; the `stop` closure (`:279-305`)
  builds every summary from the closure's `page` (the last observed `PageState`) and the `decision` it is given, with
  `done_probability` from that decision.
- `PageState` (`src/browser/tab.ts:55-70`): `url`, `title`, `text` (the reader's visible text, up to 6000 characters;
  it may start with `Loading: N placeholder blocks on screen` and `Password field "…" is filled|empty` lines), and
  `actions` (observed controls: `label`, `role`, `node`, `kind`, `value`, `current_value`, `checked`, `selected`,
  `expanded`; a `<select>` gives one action per option, labelled `<field> → <option>`; a text field gives a `fill`
  and an `Open <field>` click with the same node; a hover-only control ends with ` (appears on hover)`).
- Nothing in the summary is checked by code.

## Design decisions (made here, before code)

1. **Name: `checks`.** `verify` is the suites' word (`pnpm verify`, `verify/`), so `browser_task({ checks })`,
   `--checks '<json>'` on the CLI, `TaskOptions.checks`, and `summary.checks` for the results.
2. **Types**, a zod discriminated union in `src/task/checks.ts` used by MCP and CLI (one schema):
   - `url_contains {text}`, `url_matches {pattern}`, `title_contains {text}`
   - `text_contains {text}`, `text_absent {text}`: the reader's visible text (all frames the reader sees), not the
     2500-character `page_text` cut, without the reader's own `Password field`/`Loading:` lines.
   - `element_exists {name, role?}`: a listed control whose label contains `name`.
   - `value_equals {label, value}`: a field (`fill` value or `<select>` selected option).
   - `checked {label, state}`: a checkbox, radio or switch; `state` is required (no default: jiawei686 found a default
     of true turned `"checked": false` into a pass).
   - `count_at_least {min, name?, role?}`: at least `min` listed controls (by node) match.
   - No `js` type.
3. **No CSS selectors.** A selector would read nodes the reader never listed (hidden, off-screen, outside the modal),
   so a check could pass on something no person sees, and it would invite the caller to script the page. Checks read
   only what the run observed: role and name from the listed controls.
4. **Matching.** Case, accents (NFKC) and spacing set aside; substring. Labels lose the hover suffix; a `<select>`'s
   label is the part before ` → `; controls are counted once per node. For `value_equals` and `checked`, exact label
   matches are used when there are any, otherwise substring matches; every matched control must hold the value or
   state, and none matched fails. `url_matches` is a glob over the whole URL (`*` = any run of characters; everything
   else literal), not a caller regex: no regex engine runs caller input.
5. **An empty needle fails** (`text`, `pattern`, `name`, `label` blank after trimming; `count_at_least` with neither
   `name` nor `role`), as jiawei686's `_needle` does (`assertions.py:47-63`): `"" in s` is true for every string.
   `value_equals` with `value: ""` is allowed: it asserts an empty field.
6. **The final page** is the last page the run observed: the one the summary's `url`, `title` and `page_text` already
   report, and the one the last decision's `done_when` score was made on. No extra observe, so the checks, the score
   and what the caller reads always agree.
7. **Override rules** (after the loop, in one place; the loop is untouched):
   - `done` with any failed check → `uncertain`, reason `Jev reported done, but N of M checks failed on the final page:
     <type> "<needle>" (<detail>); …`.
   - `blocked` or `uncertain` with every check passing → `done` only when `done_when` was given and the stopping
     decision's `done_when` score is ≥ 0.5 **and was made on that final page** (a decision taken before the last
     action does not count), and ≥ 0.75 while an edit is unsaved (the bar AGENTS.md sets for a DONE right after an
     unsaved edit). Reason: `All M checks passed on the final page and "<done_when>" scored X there (the run had ended
     <status>: <reason>)`. `stuck` is dropped. Checks run alongside `done_when`, never instead of it, because text can
     already be on the page before the run.
   - `needs_input`, `needs_confirmation`, `step_budget` never change: they hand back a question, not a verdict.
8. **Keep `TaskStatus`.** No `unconfirmed` status: every suite (`verify/*.ts`, `verify/jobs/runner.ts`), the CLI's exit
   code and the skill match on the six statuses, and `uncertain` already means "read `page_text` and `stuck`, then
   decide". The reason names the failed checks, and `summary.checks` lists them all.
9. **Session.** Like `done_when`, `checks` stay for the session until a call replaces them; `[]` clears them. Checks
   never enter Jev's request.

## Scope

**In scope:**
- `src/task/checks.ts` (new): schema, `runChecks(checks, page)`, `listedElements(page)`.
- `src/task/run-task.ts`: `TaskOptions.checks`, `TaskSummary.checks`, one line in `stop` remembering how the run ended,
  one `WeakMap` entry in `#decide` (which page a decision was made on), and a `#settle` step in `run()`.
- `src/mcp.ts`, `src/cli.ts`: the `checks` input.
- Tests: `test/checks.test.ts` (new) and `test/jev-browse.test.ts`.
- `AGENTS.md` Invariants, `README.md`, `skill/jev-browse/SKILL.md`, the `browser_task` description.

**Out of scope:** any change to the loop, its guards or thresholds; checks inside Jev's request; selectors; `js`.

Never read `.env`.

## Git workflow

1. `docs: add plan 099 caller checks confirm or overturn done`
2. `test: caller checks confirm or overturn done`
3. `feat: check the caller's checks on the final page`

Lowercase conventional commits, no AI attribution, no push.

## Steps

### 1. Tests first
- `test/checks.test.ts`: each type passing and failing on a `PageState`; empty needles fail; matching ignores case and
  spacing; reader lines don't count; a select's label and current value; nodes counted once; `checked` with mixed
  matches fails; glob anchors the whole URL and treats `.`/`?` literally.
- `test/jev-browse.test.ts`, `describe('caller checks', …)`:
  - `done` + a failing check → `uncertain`, reason names it; `summary.checks` has every result.
  - `blocked` + all pass + `done_when` 0.6 on the final page → `done`; the same with no `done_when` stays `blocked`;
    with the score made before the last action stays `blocked`; with the score at 0.3 stays `blocked`.
  - `needs_input` stays `needs_input` whatever the checks say.
  - Jev's requests never contain the checks.
  Run them red.

### 2. Implement
`runChecks` is pure. `#settle(summary)` runs after `#loop()` and before the recording's `finish`, so `summary.json`
carries the results. `pnpm typecheck`, `pnpm test`.

### 3. Measure
With plans 100 and 101: `pnpm verify` (a new fixture scenario with `checks`), red-team 0, gotchas strict, checkout ×3,
public sites ×3, Forgejo ×1 with `checks` passed in the runner's call where a job's ground truth is visible on its final
page (judging unchanged).

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, new tests red first
- [ ] `pnpm verify` all pass with the checks scenario; red-team 0; gotchas strict
- [ ] `git diff --stat main` lists only the in-scope paths (plus plans 100/101's)

## STOP conditions

- A red-team violation.
- An override turns a run `done` where the suite's ground truth says the goal was not reached.

## Maintenance note

Checks read the viewport text the reader lists. A success message that scrolled away fails `text_contains`; prefer
`url_contains` and `title_contains` for navigation goals. If C4 (frames) widens the reader, checks widen with it.
