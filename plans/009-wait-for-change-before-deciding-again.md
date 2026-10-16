# Plan 009: After a quiet action or a WAIT, jev-browse waits for the page to change before deciding again

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 051f9e9..HEAD -- src/task/run-task.ts test/jev-browse.test.ts`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (changes loop timing for every task; covered by unit tests and the gotcha suite)
- **Depends on**: plans/003-gotcha-fixtures-under-chaos.md (its suite and fixtures are the measurement)
- **Category**: bug
- **Planned at**: commit `051f9e9`, 2026-10-15

## Why this matters

jev-browse decides one action per step: observe the page, ask the model, act, observe again. Two failures from the
gotcha suite (plan 003, 90 runs) share one cause — it decides again before the page has finished reacting:

1. **Loading pages (late-content: 0/9).** A page shows animated skeleton rows for 2.5 s. The model correctly
   chooses WAIT, but a WAIT only sleeps 100 ms, and the skeleton's shimmer makes the page alternate between two
   states. After 4 WAITs the "toggling in place" guard stops the run as `blocked`
   (`"Wait for the page to update" only toggles the page back and forth (4× in a row)`), or after 6 the repeat
   guard does (`was used 6 times in 7 actions`), all before the real content arrives.
2. **Slow click handlers (toggle-trap under churn: 3 false DONEs).** A filter chip's effect lands 300–800 ms after
   the click. The re-observe right after the click sees no change, so the model clicks the chip again; then both
   delayed effects fire (filter on, then off). The done check saw the momentarily filtered list and reported
   `done`, but the filter ended up cleared. Recorded steps: `CLICK Status: failed changed=false → CLICK Status: failed changed=true`.

A person waits a moment when a click seems to do nothing, and waits for loading to finish. This plan does the same.

## Current state

- `src/browser/tab.ts:263` — `if (action.kind === 'wait') return sleep(100);` (leave as is).
- `src/task/run-task.ts:352-371` — after an executed action:
  ```ts
        const before = page.fingerprint;
        page = await this.#tab.observe();
        const field = decision.operation === 'TYPE_TEXT' && page.actions.find((a) => a.kind === 'fill' && a.node === action.node);
        this.#history.push({
          operation: decision.operation,
          element,
          ...(decision.valueKey && { value_key: decision.valueKey }),
          // A field that is gone (navigated, submitted) can't say; one still on the page must show what was typed.
          ...(field && { value_kept: field.value === text }),
          page_changed: page.fingerprint !== before,
          confidence: round(Math.min(decision.confidence, decision.targetConfidence ?? 1)),
        });
        if (repeatingWithoutEffect(this.#history)) {
          return stop('blocked', 'The last 3 actions did not change the page', decision);
        }
  ```
  and a few lines later `this.#outcomes.push({ action: \`${decision.operation} ${element}\`, print: page.fingerprint });`
  feeding `togglingInPlace(this.#outcomes)` and `repeating(this.#outcomes)` (helpers at the bottom of the file,
  thresholds in the `GUARDS` object).
- `PageState.fingerprint` is a hash of the page's actions and text; it changes when anything visible changes
  (including a skeleton shimmer).
- Options pattern: `TaskOptions` (top of `run-task.ts`) with defaults in `DEFAULTS`; each option has a one-line
  JSDoc. Tests: `test/jev-browse.test.ts`, helpers `scriptedJev`, `fakeTab(pages)` (`observe` returns the pages in
  order, then repeats the last). Existing test to keep green — `test/jev-browse.test.ts:270`:
  ```ts
  it('stops as blocked when three actions change nothing', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Loop' }).run();
    expect(summary).toMatchObject({ status: 'blocked', reason: 'The last 3 actions did not change the page' });
    expect(summary.steps).toHaveLength(3);
  });
  ```
- Gotcha suite (from plan 003): `pnpm verify:gotchas` with `JEV_GOTCHAS_RUNS`, `JEV_GOTCHAS_PROFILES`
  (`normal,slow,churn`), and a scenario filter if present (check `verify/gotchas.ts`; if there is none, use the full
  suite). It needs the model key in the gitignored `.env` (never read or print it).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Gotchas | `pnpm verify:gotchas` | per-run lines + table; exit 0 when all pass |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |

## Scope

**In scope**: `src/task/run-task.ts`, `test/jev-browse.test.ts`.

**Out of scope**: `src/browser/tab.ts` (keep `sleep(100)`), `src/browser/snapshot.js`, the gotcha fixtures and
runner (they are the measurement — do not edit them), guard threshold values in `GUARDS`.

## Git workflow

- Commit on the branch your reviewer gave you: `fix: wait for the page to react before deciding again`. No AI
  attribution. Do NOT push.

## Steps

### Step 1: Wait for a change after quiet actions and WAITs

- Add `TaskOptions.changeWaitMs?: number` — JSDoc: "After an action that changed nothing yet, or a WAIT, keep
  observing up to this long for the page to change before deciding again." Default `1500` in `DEFAULTS`.
- Add a private `async #awaitChange(before: string, page: PageState): Promise<PageState>`: while
  `page.fingerprint === before` and less than `changeWaitMs` has passed, sleep 150 ms and `page = await this.#tab.observe()`.
  Return the last page. With `changeWaitMs: 0` it returns immediately.
- In the block above, right after `page = await this.#tab.observe();`, add
  `if (page.fingerprint === before) page = await this.#awaitChange(before, page);` — this covers WAIT too (WAIT is an
  executed action with `operation === 'WAIT'`).

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: WAIT never counts as a loop

In the `this.#outcomes.push(...)` line, skip the push when `decision.operation === 'WAIT'` (waiting is bounded by
`maxSteps` and the wander guard; it must not trip the toggle or repeat guards). Do not change `repeatingWithoutEffect`
(it already ignores WAIT).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass. If existing tests became slow (> 5 s total) because
of the new wait, pass `changeWaitMs: 0` in those tests' options rather than changing the default.

### Step 3: Unit tests (add to the `loop gotchas` describe block)

1. **Slow handler**: pages `['a', 'a', 'a', 'b']` (fingerprints), script `CLICK` then `DONE`, `changeWaitMs: 1000` →
   exactly one click executed, the recorded step has `page_changed: true`.
2. **No change at all**: pages all `'a'`, `changeWaitMs: 300` → still ends `blocked` with
   `The last 3 actions did not change the page` (the wait only delays it).
3. **Loading with WAIT**: pages alternate `'s1','s2','s1','s2',…` 10 times then `'loaded'`; script WAIT × 8 then DONE →
   status is not `blocked` (no toggle/repeat stop on WAITs).
Use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` or small `changeWaitMs` values so the suite stays fast.

**Verify**: `pnpm test` → all pass, 3 new tests.

### Step 4: Measure

1. `pnpm verify:gotchas` (all profiles, 3 runs). Record per-scenario and per-profile pass rates, especially
   `late-content` (was 0/9) and `toggle-trap` churn (was 0/3 by ground truth), and crashes (must stay 0).
2. `pnpm verify` → 8/8.

**Verify**: both results in your report.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0 with 3 new tests
- [ ] `pnpm verify:gotchas` completed; `late-content` passes ≥ 8/9 and `toggle-trap` churn ≥ 2/3; 0 crashes
- [ ] `pnpm verify` 8/8
- [ ] `git diff --stat 051f9e9..HEAD` lists only `src/task/run-task.ts` and `test/jev-browse.test.ts`

## STOP conditions

- `late-content` still fails mostly after steps 1–2: report each run's final `reason` and steps; do not raise
  `changeWaitMs` above 2000 or touch fixtures.
- Any previously passing gotcha scenario drops by more than 1 run per profile.
- `pnpm verify` drops below 8/8.

## Maintenance notes

- Cost: up to `changeWaitMs` extra per quiet action; pages that react instantly pay nothing.
- If a site keeps animating forever (a spinner), the wait simply times out; the wander guard and `maxSteps` bound it.
