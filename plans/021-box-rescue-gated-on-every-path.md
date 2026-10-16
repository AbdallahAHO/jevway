# Plan 021: Every Box rescue path is pinned behind the irreversible-click gate

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 5822f71..HEAD -- src/task/run-task.ts test/jev-browse.test.ts`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (tests only; no source change)
- **Depends on**: none
- **Category**: tests / security
- **Planned at**: commit `5822f71`, 2026-10-16

## Why this matters

With screenshots on, the model also answers "Box" questions: where on the screenshot the next click should go, how
sure it is, and how risky (irreversible) that click looks. `#boxRescue` in `src/task/run-task.ts` uses a confident box
to **replace** a stuck or unsure decision with a click on the observed element under the box (or, opt-in, a click at the
box's centre). That is a second route to a click, so it must face the same gate as any click: a click judged risky
(`commitRisk ≥ 0.5`) hands back `needs_confirmation` unless the caller confirmed it.

The gate holds today, but only one of the four rescue routes is pinned by a test with a risky target (a BLOCKED step
rescued onto "Confirm booking and pay €412"). In the red-team suite's screenshot mode the Box pointed at bait controls
4 times and handed back safely — live evidence that this path is exercised. A refactor that, say, dropped
`commitRisk: next.commitRisk` from the rescued decision would silently let the other three routes click a "Pay"
button. This plan pins all four.

## Current state

- `src/task/run-task.ts`:
  ```ts
  // Stuck (BLOCKED, or DONE that the completion check rejects) or unsure, but the screenshot confidently shows a
  // control worth clicking: click the observed element the box points at, or (opt-in, stuck only) the box itself
  // when the DOM reader never reported that control.
  #boxRescue(decision: Decision, page: PageState): Decision {
    const next = decision.nextClick;
    if (!next || next.present < BOX_SURE || next.confidence < BOX_SURE) return decision;
    const rejectedDone =
      decision.operation === 'DONE' && !!this.#options.doneWhen && (decision.doneProbability ?? 0) < 0.5;
    const blocked = rejectedDone || (decision.operation === 'BLOCKED' && !decision.fieldsWithoutValue.length);
    const unsure = !blocked && this.#lowConfidence(decision);
    if (!blocked && !unsure) return decision;
    if (unsure && !next.match) return decision;
    const rescued = { ...decision, via: 'box' as const, confidence: Math.min(next.present, next.confidence),
      targetConfidence: undefined, commitRisk: next.commitRisk };
    if (next.match) {
      const action = buildActionSpace(page.actions).targets.CLICK![next.match];
      return { ...rescued, operation: 'CLICK', action, target: next.match };
    }
    return this.#options.allowCoordinateClicks ? { ...rescued, operation: 'CLICK_AT' } : decision;
  }
  ```
  The four routes: (a) BLOCKED → CLICK on the matched element; (b) a DONE the done check rejects → CLICK;
  (c) an unsure step (confidence under `minConfidence`, 0.3 by default) → CLICK; (d) BLOCKED with no matching element
  and `allowCoordinateClicks` → CLICK_AT. The gate: `isRiskyClick` covers `CLICK` and `CLICK_AT` with
  `commitRisk >= 0.5`, and `#handBack` returns `needs_confirmation` unless `confirmIrreversible` was given.
- `test/jev-browse.test.ts`, `describe('Box in the task loop')` (line ~548). Setup to reuse:
  ```ts
  const boxed = { goal: 'Pay', screenshots: 'always' as const, imageTransport: 'assets' as const, box: true };
  const noFields = (overrides: Partial<PageState> = {}) =>
    page({ actions: bookingActions.filter((action) => action.kind !== 'fill'), ...overrides });
  ```
  Existing tests show every answer key: `next_click_box: boxAt(PAY_RECT)`, `next_click_present: 0.9`,
  `next_click_commit_risk: 0.95`, `operation`, `confidence`, `done_check`. Route (a) is already pinned by
  `'rescues a BLOCKED step by clicking the observed element the box covers, still gated by commit risk'`; route (c) is
  tested only with a **safe** target (`next_click_commit_risk: 0.02`) in `'follows a confident screenshot box when the
  next-step head is unsure'`; route (d) only checks the coordinate click itself (`'clicks a box the DOM never reported
  only with allowCoordinateClicks'`). `fakeTab()` exposes `acted` (executed actions) and `tab.clicksAt` (coordinate
  clicks).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (92 before) |

## Scope

**In scope**: `test/jev-browse.test.ts`, the `describe('Box in the task loop')` block only.

**Out of scope**: `src/` (no source change at all — the temporary mutation in step 2 is reverted before committing),
every other describe (another plan edits `errors become hand-backs` in parallel).

## Git workflow

- Commit on the branch your reviewer gave you: `test: pin every box rescue route behind the irreversible-click gate`.
  Lowercase conventional commit, no AI attribution. Do NOT push.

## Steps

### Step 1: Three tests, one per unpinned route

Add to `describe('Box in the task loop')`, after the existing rescue tests:
1. `'a rejected DONE rescued onto a risky control still asks for confirmation'`: options `{ ...boxed, doneWhen: 'Paid' }`,
   page `noFields()`, script `[{ operation: 'DONE', done_check: 0.2, next_click_box: boxAt(PAY_RECT),
   next_click_present: 0.9, next_click_commit_risk: 0.95 }]` → `status: 'needs_confirmation'`, `acted` empty, reason
   contains `Confirm booking and pay €412`.
2. `'an unsure step rescued onto a risky control still asks for confirmation'`: like the existing unsure test but
   `next_click_commit_risk: 0.95` → `needs_confirmation`, `acted` empty.
3. `'a coordinate click on a risky box still asks for confirmation'`: options `{ ...boxed, allowCoordinateClicks: true }`,
   script `[{ operation: 'BLOCKED', next_click_box: boxAt({ x: 100, y: 400, w: 100, h: 50 }), next_click_present: 0.9,
   next_click_commit_risk: 0.95 }]` → `needs_confirmation`, `tab.clicksAt` empty.
Add a fourth assertion to test 2's file location only if natural: after `task.update({ confirmIrreversible: true })`
and a second `run()`, the rescued click executes exactly once (one confirmation covers one click). If the script
plumbing for a second run is awkward, skip this and say so.

**Verify**: `pnpm test` → all pass (3 or 4 new assertions in 3 new tests).

### Step 2: Prove the tests catch the regression they exist for (do not commit this)

Temporarily change `commitRisk: next.commitRisk` in `#boxRescue` to `commitRisk: 0`, run `pnpm test`, and record which
tests fail: all three new tests (and the existing route-(a) test) must fail. Then restore the line exactly
(`git diff src/` must be empty).

**Verify**: the failing test names are reported; `git diff --stat src/` prints nothing afterwards.

## Test plan

Three new unit tests (one per unpinned rescue route) plus a mutation check proving they fail if the rescued decision
loses its commit risk.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0 with the new tests
- [ ] Mutation check reported: all new tests failed with `commitRisk: 0`, and `src/` is unchanged
- [ ] `git diff --stat 5822f71..HEAD` lists only `test/jev-browse.test.ts`

## STOP conditions

- Any new test fails on the current code — that would be a real gate bypass: report the route, the summary status
  and reason, and stop (do not fix `src/`).
- A test can't be expressed with the existing helpers without editing `src/`.

## Maintenance notes

- Any new way to turn model output into a click (another rescue, a new key) needs a test like these: risky target →
  `needs_confirmation`, nothing executed.
