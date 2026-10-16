# Plan 018: A done spike the next-step head contradicts is confirmed with a screenshot before the run ends

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat cfd8c65..HEAD -- src/task/run-task.ts test/jev-browse.test.ts AGENTS.md`
> On any output, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (changes when a run may end `done`; one extra model request only in the contradicted-spike case)
- **Depends on**: none (plans 001–017 DONE)
- **Category**: bug
- **Planned at**: commit `cfd8c65`, 2026-10-16

## Why this matters

jev-browse returns `done` to the calling agent only when the goal is visibly met; a false `done` makes the agent act
on a page that isn't what it thinks. Each model decision has two relevant parts: the **next-step head** (an operation
such as CLICK or TYPE_TEXT, with a confidence) and the **done check** (a 0–1 score for the caller's `doneWhen`). Today
a single done-check score ≥ 0.9 (`DONE_EVIDENT`) ends the run at once, "whatever the next-step head prefers".

Measured on the Langfuse demo suite (`pnpm verify:langfuse`, real model, signed-in Chrome on port 9333):
- `worst-relevance` (goal: filter Scores to answer_relevance, sort lowest first, open that trace) ended `done` on the
  **unfiltered Scores list** in 3 of 8 runs on 2026-10-16 after one click. Each time the done check scored 0.90 while
  the head chose `TYPE_TEXT "Search"` at 0.87 — the right next step. The same job was 10/10 the day before; today's
  live demo data makes the spike likelier, which is what makes it measurable.
- Across every saved Langfuse run (≈420 that ended `done`), 16 ended through this exact shape (done check ≥ 0.9 while
  the head chose an action other than DONE/WAIT/BLOCKED with operation confidence ≥ 0.6): **14 correct, 2 false**
  (worst-relevance, and dataset-source at 0.92 with the head on `CLICK "View source observation"` at 0.68). The 14
  correct ones were mostly `session-to-user` (head on a CLICK at 0.60–0.75, done check 0.93–0.96) and
  `failed-experiment`. In the other 57 runs where the done check reached 0.9, the head was unsure or chose WAIT, and
  all 57 were correct.

So rejecting a contradicted spike would lose 14 correct runs. This plan instead takes **one more decision with a
screenshot** (the existing "last look", already used before a loop guard hands back) in exactly that case, and ends
`done` only if that look also clears the done bar. Otherwise the run continues as if the spike hadn't happened. Cost:
one request with a screenshot in roughly 4% of runs.

## Current state

- `src/task/run-task.ts` — constants (excerpts):
  ```ts
  const GUARDS = {
    // ...or this sure on doneSustained consecutive decisions: steady evidence, where a single spike isn't (see DONE_EVIDENT).
    doneSteady: 0.75,
    doneSustained: 3,
    ...
  } as const;
  ...
  // A `done_when` judgment this sure ends the task, whatever the next-step head prefers (it may wander on).
  const DONE_EVIDENT = 0.9;
  // The last look before a loop guard hands back accepts the goal as met at this done check: the same bar a DONE needs.
  const LAST_LOOK_DONE = 0.5;
  ```
- The loop, right after each decision (inside `#loop()`):
  ```ts
        const doneProbability = decision.doneProbability ?? 0;
        doneStreak = doneProbability >= GUARDS.doneSteady ? doneStreak + 1 : 0;
        if (doneWhen && (doneProbability >= DONE_EVIDENT || doneStreak >= GUARDS.doneSustained)) {
          this.trace.push({ decision: { ...decision, action: decision.action?.label }, executed: false, elapsed_ms: elapsed() });
          return stop('done', `Completion condition verified: ${doneWhen}`, decision);
        }
        const record = (didExecute: boolean) => …;
        decision = this.#boxRescue(decision, page);
        …  // DONE-rejection, covered target, hand-back, then the action is executed
  ```
- The look already exists and is reused by the loop guards (`stopAfterLastLook`):
  ```ts
  // One more decision on the current page, with a screenshot unless the profile is text-only; a failure is ignored so
  // the guard's own stop stands. Only worth a request when there is completion evidence to check.
  async #lastLook(page: PageState): Promise<Decision | undefined> {
    if (!this.#options.doneWhen) return undefined;
    try {
      return await this.#decide(page, { lastLook: true });
    } catch {
      return undefined;
    }
  }
  ```
  `#decide(page, { lastLook: true })` sends a screenshot when the profile's `screenshots` is not `'off'`.
  `this.#options.screenshots` is `'off' | 'fallback' | 'always'`; Jev's profile default is `'fallback'` (text first,
  screenshot on shaky steps).
- `Decision` fields used here: `operation` (`'CLICK' | 'TYPE_TEXT' | 'DONE' | 'WAIT' | 'BLOCKED' | …`), `confidence`
  (the operation head's confidence), `doneProbability`, `action?.label`.
- `AGENTS.md` (Invariants, the loop-guards bullet) ends with: "`done_when` ≥ 0.9 once, or ≥ 0.75 on 3 consecutive
  decisions, is `done`." AGENTS.md also says thresholds are tuned per model and Jev's values are its baseline — the
  new constants are Jev baselines; do not change `DONE_EVIDENT`, `GUARDS` or `LAST_LOOK_DONE`.
- Tests: `test/jev-browse.test.ts`, `describe('loop gotchas')` → nested `describe('the last look before a guard hands
  back')` is the closest pattern. Helpers: `scriptedJev(steps)` answers request *i* with `steps[i]` (keys: `operation`,
  `click_target`, `confidence` for the operation head, `done_check` for the done score) and returns `{ ask, requests }`;
  `fakeTab(pages)` returns `{ tab, acted, asTab }` (`tab.screenshots` counts screenshots sent to the model; `acted`
  lists executed actions); `page({ fingerprint })` builds a page. Use `changeWaitMs: 0`. A run on pages with the same
  fingerprint makes `fallback` add a second look after an action that "changed nothing" — give consecutive pages
  different fingerprints so request counts stay exact.
- The model key is in the gitignored `.env`, loaded by the npm scripts. **Never read or print `.env`.**

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Gotchas | `pnpm verify:gotchas` | strict 90/90 last time |
| Red-team | `pnpm verify:redteam` | `violations: 0` |
| Langfuse slice (port 9333) | `CI=1 JEV_LANGFUSE_RUNS=10 JEV_LANGFUSE_ONLY=worst-relevance,session-to-user,failed-experiment,dataset-source pnpm verify:langfuse` | `N/40 runs passed` and a report path |

## Scope

**In scope**: `src/task/run-task.ts` (the done check after each decision, two new constants), `test/jev-browse.test.ts`
(new tests), `AGENTS.md` (that one invariant sentence).

**Out of scope**: `DONE_EVIDENT`, `GUARDS`, `LAST_LOOK_DONE`, `MAX_REJECTED_DONE`, `#lastLook` itself, `src/jev/*`,
the Langfuse jobs (goals, `doneWhen`, checks).

## Git workflow

- Commit on the branch your reviewer gave you: `fix: confirm a done spike the next step contradicts`. Lowercase
  conventional commit, no AI attribution. Do NOT push.

## Steps

### Step 1: Confirm a contradicted spike before ending

In `run-task.ts`:
1. Add two constants next to `DONE_EVIDENT`, each with a one-line comment:
   - `HEAD_DISAGREES = 0.6` — a next-step head this sure of another action contradicts a single done spike (measured on
     Jev: 2 of 16 such spikes were false DONEs).
   - `SPIKE_CONFIRMED = LAST_LOOK_DONE` — the screenshot look confirms the spike at the same bar a DONE needs.
2. Change the done check after each decision to:
   - Steady evidence (`doneStreak >= GUARDS.doneSustained`) ends `done` exactly as today.
   - A spike (`doneProbability >= DONE_EVIDENT`) ends `done` exactly as today **unless** all of these hold:
     the profile's `screenshots` is `'fallback'`; the decision's `operation` is not `DONE`, `WAIT` or `BLOCKED`; and
     `decision.confidence >= HEAD_DISAGREES`.
   - In that case call `this.#lastLook(page)`. If it returns a decision with `doneProbability >= SPIKE_CONFIRMED`,
     push it to `this.trace` (not executed) and `return stop('done', \`Completion condition verified: ${doneWhen}\`, look)`.
   - Otherwise push the look (if any) to `this.trace` as not executed, and **carry on with the original decision**
     through the rest of the loop body unchanged (box rescue, hand-back checks, execution), as if there had been no
     spike. Do not add anything to `this.#history` for the look.
3. Comment the branch in one line: a single done spike that the next step confidently contradicts gets one screenshot
   look; `always` already saw a screenshot and `off` has nothing new to show.

Keep the code shape flat (a small helper predicate such as `contradictedSpike(decision)` is fine; no new class).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all existing tests pass.

### Step 2: Unit tests

Add `describe('a done spike the next step contradicts', …)` inside `describe('loop gotchas')`. Options:
`{ goal: 'Open it', doneWhen: 'It is open', changeWaitMs: 0, screenshots: 'fallback' }` unless a test says otherwise.
1. **Unconfirmed spike carries on**: requests answer `[{ operation: 'CLICK', click_target: '1', confidence: 0.87,
   done_check: 0.9 }, { operation: 'CLICK', click_target: '1', done_check: 0.3 }, { operation: 'DONE', done_check: 0.8 }]`
   → the first CLICK is executed (`acted` has one entry), the run then ends `done` on the DONE; `requests` has length 3;
   `tab.screenshots` is 1 (the look).
2. **Confirmed spike ends done**: `[{ …CLICK 0.87, done_check: 0.9 }, { …CLICK, done_check: 0.8 }]` → status `done`,
   `done_probability` 0.8, nothing executed, 2 requests, 1 screenshot.
3. **An unsure or waiting head needs no look**: a spike with `operation: 'WAIT'`, and separately a spike with
   `operation: 'CLICK', confidence: 0.5` → each `done` after 1 request, 0 screenshots.
4. **Text-only and always-screenshot profiles need no look**: the step-1 spike with `screenshots: 'off'` → `done` after
   1 request; with `screenshots: 'always'` → `done` after 1 request (that request already carried its screenshot).
5. **A failed look carries on**: like test 1, but the second request throws (`400 bad request`, as the last-look test
   does) → the CLICK still executes and the run continues to the DONE.

If an exact request count differs because of the `fallback` second look, fix the test's pages (distinct fingerprints),
not the code, and say so in NOTES.

**Verify**: `pnpm test` → all pass, 5 new tests (or 6 if you split test 3/4 into separate `it`s; say which).

### Step 3: Document the invariant

In `AGENTS.md`, change "`done_when` ≥ 0.9 once, or ≥ 0.75 on 3 consecutive decisions, is `done`." to
"`done_when` ≥ 0.75 on 3 consecutive decisions is `done`; ≥ 0.9 once is `done` too, unless the next step confidently
contradicts it (≥ 0.6 on another action, `fallback` screenshots): then one screenshot look must also clear 0.5."

**Verify**: `git diff AGENTS.md` shows only that sentence.

### Step 4: Measure

1. `pnpm typecheck`, `pnpm test`, `pnpm verify` → 8/8.
2. Langfuse slice on the shared signed-in Chrome (`http://127.0.0.1:9333`; use it **only** through this suite; never
   sign in or out; nothing else may drive it while it runs):
   `CI=1 JEV_LANGFUSE_RUNS=10 JEV_LANGFUSE_ONLY=worst-relevance,session-to-user,failed-experiment,dataset-source pnpm verify:langfuse`
   (foreground; ~12 minutes — split into two calls of two jobs each if a call would exceed 10 minutes).
   Before (same day, without this change): worst-relevance 4/8 with 3 false DONEs; the other three were 10/10 each on
   2026-10-15. Report per job: passes, false DONEs (status `done` but ✘), and other statuses.
3. From the run directories' `trace.json` files, count the confirmation looks: how many runs took one, each look's
   done score, and whether that run passed. (A look is a trace entry right after a spike entry with done ≥ 0.9 whose
   operation is not DONE/WAIT/BLOCKED.)
4. `pnpm verify:gotchas` (all 90 runs) → report strict totals per profile (last: 30/30 each).
5. `pnpm verify:redteam` → `violations: 0`.

The model key is in the gitignored `.env`; never read or print it. Gotchas and red-team launch their own headless
Chrome; only the Langfuse slice uses port 9333.

## Test plan

Five unit tests pin the rule (confirm / carry on / no look for unsure, waiting, off and always / failed look). The
Langfuse slice is the live evidence: the false-DONE job should stop ending `done` on the wrong page, and the jobs
whose correct DONEs came through this path must not lose them.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0 with the new tests
- [ ] `pnpm verify` 8/8; gotchas strict reported per profile; red-team 0 violations
- [ ] Langfuse slice: per-job results, false-DONE count, and the confirmation-look table reported
- [ ] `git diff --stat cfd8c65..HEAD` lists only `src/task/run-task.ts`, `test/jev-browse.test.ts`, `AGENTS.md`

## STOP conditions

- `session-to-user` or `failed-experiment` drops below 9/10, with a confirmation look under 0.5 on a run whose page
  was right — the screenshot look under-reads correct pages; report each look's score. Do **not** lower
  `SPIKE_CONFIRMED` or change `HEAD_DISAGREES`.
- worst-relevance still ends `done` on the wrong page **after** a confirmation look scored ≥ 0.5 — report the look's
  score and screenshot path.
- Gotchas strict drops below 29/30 on any profile, or any red-team violation.
- The change seems to need edits in `src/jev/*` or to `#lastLook`.

## Maintenance notes

- `HEAD_DISAGREES` and `SPIKE_CONFIRMED` are Jev baselines measured on Langfuse traces (16 contradicted spikes, 2
  false). Other models must not inherit them blindly.
- A screenshot can make Jev's done check read lower on a correct page (why Jev runs text-first); if correct DONEs start
  falling into "carry on", the next lever is the done-check rule text, not these numbers.
