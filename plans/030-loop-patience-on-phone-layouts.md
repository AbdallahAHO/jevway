# Plan 030: Waits and Escapes don't count as wandering, a loading page gets a moment before a hand-back, and filter fields take Enter

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat f91840e..HEAD -- src/task/run-task.ts test/jev-browse.test.ts AGENTS.md`
> On any output, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (loop rules; `GUARDS` are Jev baselines — this changes which steps a guard counts, not its numbers)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f91840e`, 2026-10-16

## Why this matters

On an emulated iPhone 15 (Langfuse 30/48, Grafana 15/24 vs ~99% desktop), a diagnosis of every failing run's
recording found three loop-rule causes:
1. **Wander guard counts harmless steps.** The guard ends a run `uncertain` after 6 executed actions in a row under
   0.5 confidence. On phone, Langfuse's search lives in a full-screen Filters sheet; the extra steps are unsure, and the
   window filled with a WAIT at 0.29 while the 3 matching rows were already on screen (off-topic-answer #2: Filters
   0.33, type 0.32, Open Search 0.30/0.37, Show results 0.42, **WAIT 0.29** → stopped; run #3 took the same path and
   clicked the row at 0.92). WAIT and PRESS_ESCAPE are fixed, reversible steps that are already exempt from the unsure
   hand-back; they shouldn't fill the wander window either.
2. **Hand-back while the page is still loading.** dataset-source #3 handed back `needs_input` for "Search (Name)"
   while the Datasets list was still skeleton rows ("Page 1 of ◌"); runs #1/#2 made the same first choice but the list
   arrived before the hand-back. Skeleton rows have no text, so the existing stale-page re-check saw no change.
3. **Enter isn't offered after typing into a filter field.** On Grafana's phone alert list the model typed "cpu" into
   "Filter by name…"; the list only filters on Enter, but PRESS_ENTER is offered only after a search-like field
   (`/search|query|find/`), so the run had DONE rejected 3×.

## Current state

- `src/task/run-task.ts`:
  ```ts
  const wandering = (history: { confidence: number; not_executed?: string }[]) => {
    const executed = history.filter((step) => !step.not_executed).slice(-GUARDS.wanderSteps);
    return executed.length === GUARDS.wanderSteps && executed.every((step) => step.confidence < GUARDS.wanderConfidence);
  };
  ```
  called as `wandering(this.#history.slice(firstStep))` after each executed action. History steps carry `operation`.
  ```ts
  // Enter is offered only after typing into a field like these; elsewhere it could submit a form.
  const SEARCH_LIKE = /search|query|find/i;
  ```
  The hand-back block in `#loop()`:
  ```ts
        const handBack = this.#handBack(decision);
        if (handBack) {
          // A stop decided on a page that has since changed is stale: re-observe instead of reporting it.
          if (!(await this.#tab.fresh(page))) {
            record(false);
            page = await this.#tab.observe();
            continue;
          }
          record(false);
          return stop(handBack[0], handBack[1], decision);
        }
  ```
  and the existing wait helper:
  ```ts
  // Keeps observing a page that still looks like `before`; stops at the first change or after changeWaitMs.
  async #awaitChange(before: string, page: PageState): Promise<PageState> { … }
  ```
  `changeWaitMs` defaults to 1500 (tests pass `changeWaitMs: 0`).
- `AGENTS.md` invariants describe the wander guard ("6 executed actions in a row under 0.5 confidence is `uncertain`")
  and Enter ("offered only right after typing into a search-like field").
- Tests: `test/jev-browse.test.ts`, `describe('loop gotchas')` has the wander and Enter tests (search for
  `unsure for` and `PRESS_ENTER`); `fakeTab(pages)` serves `pages` in order and `page({ fingerprint, actions })` builds
  one.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (105 before) |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Gotchas | `pnpm verify:gotchas` | strict 90/90 last time |
| Red-team | `pnpm verify:redteam` | `violations: 0` |
| Grafana desktop / phone | `pnpm verify:grafana` / `JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` | 23–24/24 / 15/24 last time |

## Scope

**In scope**: `src/task/run-task.ts` (`wandering`, `SEARCH_LIKE`, the hand-back block), `test/jev-browse.test.ts`
(`loop gotchas` only), `AGENTS.md` (the two invariant phrases).

**Out of scope**: `GUARDS` values, `minConfidence`, `#handBack`'s rules, the Box path, `tab.ts`, `snapshot.js`. Do not run
`verify:langfuse` or touch the Chrome on port 9333.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `fix: leave waits and escapes out of the wander guard`
  2. `fix: give a loading page a moment before handing back`
  3. `fix: offer enter after typing into a filter field`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Wander window skips WAIT and PRESS_ESCAPE (test first)

Test: five unsure executed CLICKs (confidence 0.3) interleaved with one unsure WAIT do **not** trip the guard; a sixth
unsure CLICK does. Script it with `scriptedJev` and pages with distinct fingerprints so every step changes the page;
assert the status/reason at the right step. Red first. Then filter `operation` WAIT and PRESS_ESCAPE out before taking
the last `wanderSteps`. Update the AGENTS.md phrase to "6 executed actions in a row under 0.5 confidence (waits and
Escapes not counted) is `uncertain`".

**Verify**: `pnpm test` → all pass. Commit 1.

### Step 2: Wait for a change before a needs_input or blocked hand-back (test first)

Test: the first decision is a TYPE_TEXT with no value (→ `needs_input`) on page A; `fakeTab` then serves page B (a
different fingerprint, e.g. the list arrived); the second decision is `DONE` → the run ends `done`, not `needs_input`.
Use `changeWaitMs: 1000` with fake timers or a small real value. A second test: the page never changes → still
`needs_input` (delayed by at most `changeWaitMs`). Red first for the first test.

Then, in the hand-back block, for `needs_input` and `blocked` only (not `needs_confirmation`, not `uncertain`, not
`done`): before the existing freshness check, `const settled = await this.#awaitChange(page.fingerprint, page)`; if
`settled.fingerprint !== page.fingerprint`, record the decision as not executed, set `page = settled` and `continue`.
One-line comment: a page still loading (skeleton rows have no text) gets up to `changeWaitMs` before the agent is
asked for input or told the run is stuck.

**Verify**: `pnpm test` → all pass. Commit 2.

### Step 3: Enter after a filter field (test first)

Test: like the existing Enter test, but the field's label is `Filter by name...` → PRESS_ENTER is offered after typing.
Red first. Then `SEARCH_LIKE = /search|query|find|filter/i` with the comment updated. Update AGENTS.md's Enter phrase to
"search-like or filter field".

**Verify**: `pnpm test` → all pass. Commit 3.

### Step 4: Measure

1. `pnpm verify` → 8/8; `pnpm verify:gotchas` → strict per profile (last 30/30 each); `pnpm verify:redteam` →
   `violations: 0` (Enter is a fixed key; a filter field in a form could submit it — red-team must stay clean).
2. `pnpm verify:grafana` (desktop) and `JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` (phone) → report per job.
Headless Chrome only (suites launch their own). The model key is in the gitignored `.env`, loaded by the npm scripts;
never read or print it. Run suites in the foreground, split with `_ONLY`/`_PROFILES` variables if a call would pass 10
minutes.

## Test plan

Five unit tests (wander window, two for the loading wait, Enter after a filter field, plus the unchanged existing
ones), each new behaviour red first; live gotchas, red-team and Grafana desktop/phone as evidence and guards.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; each new test shown red before its change
- [ ] `pnpm verify` 8/8; gotchas strict per profile; red-team 0 violations; Grafana desktop and phone reported per job
- [ ] `git diff --stat f91840e..HEAD` lists only `src/task/run-task.ts`, `test/jev-browse.test.ts`, `AGENTS.md`

## STOP conditions

- Gotchas strict drops below 29/30 on any profile, any red-team violation, or Grafana desktop below 22/24.
- The change seems to need new `GUARDS` values or edits outside scope.

## Maintenance notes

- The loading wait adds at most `changeWaitMs` (1.5 s) to genuine `needs_input`/`blocked` hand-backs.
- Enter stays a fixed key pressed only while the typed field still has focus; "filter" widens where it is offered.
