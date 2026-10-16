# Plan 024: An unsure Escape runs like an unsure wait, and a confirmed spike keeps its trigger in the trace

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat be13f06..HEAD -- src/task/run-task.ts test/jev-browse.test.ts AGENTS.md`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED (one hand-back rule; one trace entry)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `be13f06`, 2026-10-16

## Why this matters

**Unsure Escape.** jev-browse hands a decision back to the calling agent (`uncertain`) when the model's confidence
in its next step is under the profile's `minConfidence` (Jev: 0.3). Two operations are exempt from that: an unsure
WAIT still waits, because waiting can't hurt. PRESS_ESCAPE is the same kind of operation: a **fixed key** (never model
text), offered only while an observed element is expanded (a menu, popover or suggestion list), and closing that is
what a person does without thinking. Measured in the 160-run Langfuse pass at `76aa054`: 2 of the 5 misses
(off-topic-answer #8, trace-to-prompt #5) were runs handed back as `uncertain` because PRESS_ESCAPE scored **0.29**,
one hundredth under the bar, on pages where closing the open popover was the obvious step. The wander guard (6
executed actions in a row under 0.5 confidence → `uncertain`) and the step budget still bound a run that keeps
pressing unsure Escapes.

**Trace of a confirmed spike.** Plan 018 added a screenshot look when a single done-check spike (≥ 0.9) is
contradicted by a confident next step. When the look confirms the goal, the run's `trace` (written to `trace.json` by
the suites, used to analyse runs) records only the look, not the spike decision that triggered it, so an analysis of
"how often did the look fire" cannot find it. Record both.

## Current state

- `src/task/run-task.ts` — the hand-back rule (in `#handBack`):
  ```ts
      const boxStop = this.#boxStop(decision);
      if (boxStop) return boxStop;
      // Waiting can't hurt: an unsure WAIT just waits (the wander guard and step budget still bound it).
      if (this.#lowConfidence(decision) && decision.operation !== 'WAIT') {
        const confidence = Math.min(decision.confidence, decision.targetConfidence ?? 1);
        return [
          'uncertain',
          `Next step "${decision.operation} ${decision.action?.label ?? ''}" had confidence ${round(confidence)}`,
        ];
      }
  ```
  Escape is offered as the action `{ id: 'press_escape', kind: 'escape', label: 'Press Escape to close the open menu,
  popover or suggestion list' }` and chosen as operation `'PRESS_ESCAPE'`; executing it calls `tab.dismissPopup()`.
- The done check after each decision (from plan 018):
  ```ts
        const steadyDone = doneStreak >= GUARDS.doneSustained;
        if (doneWhen && (doneProbability >= DONE_EVIDENT || steadyDone)) {
          // A single done spike that the next step confidently contradicts gets one screenshot look; …
          const lookFirst = !steadyDone && contradictsDoneSpike(decision, screenshots);
          const look = lookFirst ? await this.#lastLook(page) : undefined;
          if (!lookFirst || (look?.doneProbability ?? 0) >= SPIKE_CONFIRMED) {
            const verdict = look ?? decision;
            this.trace.push({ decision: { ...verdict, action: verdict.action?.label }, executed: false, elapsed_ms: elapsed() });
            return stop('done', `Completion condition verified: ${doneWhen}`, verdict);
          }
          if (look) this.trace.push({ decision: { ...look, action: look.action?.label }, executed: false, elapsed_ms: elapsed() });
        }
  ```
  Note the unconfirmed branch also pushes only the look, never the spike decision (the spike decision is executed
  afterwards through the normal path, which records it then).
- `AGENTS.md` invariants (loop-guards bullet) say "an unsure WAIT still waits".
- Tests in `test/jev-browse.test.ts`, `describe('loop gotchas')`:
  ```ts
  it('waits on an unsure WAIT instead of handing back', async () => {
    const { ask } = scriptedJev([{ operation: 'WAIT', confidence: 0.2 }, { operation: 'DONE' }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Load', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
  });
  ```
  and the Escape helper and test just above it:
  ```ts
  const withExpanded = page({
    actions: [...bookingActions, { id: 'm', kind: 'click', node: 9, role: 'button', label: 'Past 1 day', expanded: 'true' }],
  });
  it('offers Escape only while something is expanded, as a fixed key', async () => {
    …
    const open = scriptedJev([{ operation: 'PRESS_ESCAPE' }, { operation: 'DONE' }]);
    const { asTab, acted } = fakeTab([withExpanded, page({ fingerprint: 'closed' })]);
    await new BrowserTask(asTab, open.ask, { goal: 'x' }).run();
    expect(acted[0].label).toMatch(/^Press Escape/);
  });
  ```
  Plan 018's tests live in `describe('a done spike the next step contradicts')`; its confirm test is
  `'ends as done without acting when the screenshot look confirms the goal'`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (98 before) |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Gotchas | `pnpm verify:gotchas` | strict 90/90 last time |
| Red-team | `pnpm verify:redteam` | `violations: 0` |

## Scope

**In scope**: `src/task/run-task.ts` (the hand-back rule; the trace push in the done check), `test/jev-browse.test.ts`
(`loop gotchas` describes only), `AGENTS.md` (that one phrase).

**Out of scope**: `minConfidence`, `GUARDS`, `DONE_EVIDENT`, `SPIKE_CONFIRMED`, `HEAD_DISAGREES`, `dismissPopup`, when
Escape is offered, the Langfuse/Grafana suites (your reviewer measures Langfuse after merging — do **not** run
`verify:langfuse` or touch the Chrome on port 9333).

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `fix: let an unsure escape run like an unsure wait`
  2. `fix: keep the done spike that triggered a screenshot look in the trace`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Unsure Escape (test first)

Add next to the unsure-WAIT test: `'presses an unsure Escape instead of handing back'` — script
`[{ operation: 'PRESS_ESCAPE', confidence: 0.29 }, { operation: 'DONE' }]`, pages `[withExpanded, page({ fingerprint: 'closed' })]`,
options `{ goal: 'x', changeWaitMs: 0 }` → status `done`, `acted[0].label` matches `/^Press Escape/`. Run `pnpm test`:
it **fails** (status `uncertain`). Then change the rule to exempt both: `!['WAIT', 'PRESS_ESCAPE'].includes(decision.operation)`,
and update the comment above it: waiting can't hurt, and neither can closing an open menu with the fixed Escape key;
both are still bounded by the wander guard and the step budget.

Also add `'still hands back an unsure click'` only if no existing test already asserts that a low-confidence CLICK
returns `uncertain` (search the file for `had confidence`); if one exists, name it in NOTES instead.

In `AGENTS.md`, change "an unsure WAIT still waits" to "an unsure WAIT still waits and an unsure PRESS_ESCAPE still
presses".

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass. Commit 1.

### Step 2: Keep the trigger in the trace

In the done check, when a look was taken (`lookFirst`), push the **spike decision** to `this.trace` (not executed)
before the look, in both branches (confirmed and not confirmed). The final pushed entry when confirmed stays the look
(`verdict`), so the last trace entry is still what ended the run. Do not change what `stop()` receives.

Extend plan 018's confirm test to assert the trace: its last two entries are the spike (`operation: 'CLICK'`,
`doneProbability` 0.9) then the look (`doneProbability` 0.8). Extend its carry-on test to assert the spike and the
look both appear in the trace before the executed CLICK entry. Read `task.trace` (keep a reference to the
`BrowserTask`).

**Verify**: `pnpm test` → all pass. Commit 2.

### Step 3: Measure

`pnpm verify` → 8/8; `pnpm verify:gotchas` (90 runs; `search-suggestions` and `date-range` exercise Escape) → report
strict per profile (last 30/30 each); `pnpm verify:redteam` → `violations: 0` (an unsure Escape must not create a
violation; `confirm-modal` has an open dialog). Headless Chrome only (each suite launches its own). The model key is in
the gitignored `.env`, loaded by the npm scripts; never read or print it.

## Test plan

One new test red before the rule change (unsure Escape presses), the existing unsure-WAIT test unchanged, and trace
assertions added to plan 018's two tests. Live suites as regression guards; Langfuse is measured by the reviewer.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; the unsure-Escape test shown red before step 1's rule change
- [ ] `pnpm verify` 8/8; gotchas strict per profile reported; red-team 0 violations
- [ ] `git diff --stat be13f06..HEAD` lists only `src/task/run-task.ts`, `test/jev-browse.test.ts`, `AGENTS.md`

## STOP conditions

- Gotchas strict drops below 29/30 on any profile, or any red-team violation.
- The change seems to need edits to when Escape is offered or to `dismissPopup`.

## Maintenance notes

- Only fixed, reversible keys belong in the "unsure still runs" exemption. Anything carrying model-chosen targets or
  text (CLICK, TYPE_TEXT, SELECT) must keep handing back when unsure.
