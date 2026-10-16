# Plan 020: An executed action is always in the summary, even when the page then fails to settle

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 5822f71..HEAD -- src/task/run-task.ts test/jev-browse.test.ts`
> On any output, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (adds a history entry on one error path; unit-tested)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5822f71`, 2026-10-16

## Why this matters

jev-browse returns a summary to the calling agent, and `summary.steps` is how the agent knows what was actually done
in the browser. If an action executes (a click on "Submit", "Place order", "Delete") and the page then fails to settle
(observing it throws, e.g. `Page did not settle within 1s`, or the browser connection drops), the run correctly ends
`blocked` with `Browser error: …` — but the executed action is **missing** from `summary.steps`, because the step is
only recorded after the post-action observation succeeds. The agent then believes nothing happened and may repeat a
click that already went through. A step that ran must always be reported.

## Current state

- `src/task/run-task.ts`, inside `#loop()`, right after an action executes (excerpt):
  ```ts
        record(true);
        executed++;
        this.#unreachable = { node: undefined, count: 0 };
        this.#lastTyped = decision.operation === 'TYPE_TEXT' && isSearchLike(action) ? action : undefined;
        // A confirmation covers exactly one risky click.
        if (isRiskyClick(decision)) this.#confirmedCommit = false;

        const before = page.fingerprint;
        page = await this.#tab.observe();
        // A slow click handler or a loading page hasn't reacted yet: a person waits a moment before trying again.
        if (page.fingerprint === before) page = await this.#awaitChange(before, page);
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
  ```
  The whole loop body is inside `try { … } catch (error) { return stop('blocked', describeError(error)); }`, and
  `stop()` builds `steps` from `this.#history.slice(firstStep)`.
- `StepRecord` (`src/jev/decide.ts`): `{ operation; element; value_key?; page_changed?; value_kept?; not_executed? }` —
  `page_changed` is optional, so "unknown" is simply leaving it out.
- `test/jev-browse.test.ts`, `describe('errors become hand-backs')` has this tolerant test today:
  ```ts
  it('ends as blocked when the page never settles after an action', async () => {
    const { ask } = scriptedJev([click]);              // click = { operation: 'CLICK', click_target: '1' }
    const { tab, asTab, acted } = fakeTab();
    let observed = 0;
    tab.observe = async () => {
      if (observed++) throw new StalePage(SETTLE_TIMEOUT);
      return page();
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('did not settle');
    expect(summary.steps.length).toBeLessThanOrEqual(1);
    expect(acted).toHaveLength(1);
  });
  ```
  The default `page()` lists `bookingActions`; click target `'1'` resolves to the first clickable action (check which
  label it is by reading `acted[0].label` in the test).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (92 before) |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Gotchas, plain profile | `JEV_GOTCHAS_PROFILES=normal pnpm verify:gotchas` | strict 30/30 last time |

## Scope

**In scope**: `src/task/run-task.ts` (the post-action observation only), `test/jev-browse.test.ts` (the
`errors become hand-backs` describe only).

**Out of scope**: `StepRecord`, `stop()`, the recording, the loop guards, every other describe in the test file
(another plan adds tests to `Box in the task loop` in parallel; do not touch it).

## Git workflow

- Commit on the branch your reviewer gave you: `fix: report an executed action even when the page then fails to settle`.
  Lowercase conventional commit, no AI attribution. Do NOT push.

## Steps

### Step 1: Tighten the test (red)

Change the existing test above so it asserts the step is reported: `summary.steps` has length exactly 1 and matches
`{ operation: 'CLICK', element: acted[0].label }`, and the step has **no** `page_changed` key
(`expect(summary.steps[0]).not.toHaveProperty('page_changed')`). Rename it to
`'ends as blocked, still reporting the executed action, when the page never settles after it'`.

Add a second test in the same describe: a `TYPE_TEXT` that executes, then the observation throws → the step is
reported with `operation: 'TYPE_TEXT'` and its `value_key`. Script it the way the existing TYPE_TEXT tests
do (e.g. line ~197): `scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' }])` with
`values: { email: 'ada@example.com' }` in the task options; the reported step then has `value_key: 'email'`.

**Verify**: `pnpm test` → the two tests **fail** (steps empty); everything else passes.

### Step 2: Record the step before rethrowing

Wrap the post-action observation (`page = await this.#tab.observe()` and the `#awaitChange` call) so that if it throws,
the step is pushed to `this.#history` **without** `page_changed` and `value_kept` (unknown), with `operation`,
`element`, `value_key` (when present) and `confidence` exactly as the normal push computes them, and then the error is
rethrown unchanged (the outer catch still ends the run `blocked` with `Browser error: …`). Add a one-line comment: an
action that ran is reported even when the page can't be read afterwards, so the caller never repeats it blindly.
Avoid duplicating the confidence/value_key expression: compute the shared part of the record once and reuse it for both
pushes.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass.

### Step 3: Measure

`pnpm verify` → 8/8; `JEV_GOTCHAS_PROFILES=normal pnpm verify:gotchas` → report strict (last 30/30). Headless Chrome
only (the suites launch their own); never touch the Chrome on port 9333. The model key is in the gitignored `.env`,
loaded by the npm scripts; never read or print it.

## Test plan

Two unit tests in `errors become hand-backs` (CLICK and TYPE_TEXT), red before the fix; the live suites guard the
normal path.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; the two tests shown red before step 2
- [ ] `pnpm verify` 8/8; gotchas normal reported
- [ ] `git diff --stat 5822f71..HEAD` lists only `src/task/run-task.ts` and `test/jev-browse.test.ts`

## STOP conditions

- The fix seems to need a change to `StepRecord`, `stop()`, or the recording.
- Any existing test changes meaning (other than the one renamed and tightened in step 1).

## Maintenance notes

- Any new code between executing an action and recording it must keep this guarantee: executed ⇒ in `steps`.
