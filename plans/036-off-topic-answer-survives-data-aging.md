# Plan 036: The off-topic-answer job keeps working as the demo's traces age out of the default time range

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 2c693dc..HEAD -- verify/langfuse.ts`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (one job's goal)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2c693dc`, 2026-10-16

## Why this matters

The Langfuse suite's `off-topic-answer` job searches the demo project's traces for "weather in berlin" and opens that
trace. On 2026-10-16 at ~11:15 it failed 10/10 on desktop and 3/3 on a phone: the only matching trace was from
2026-10-15 11:44, and the Tracing page's default range is **Past 1 day**, so the search showed "No results." The agent
correctly handed back `uncertain` (it never claimed done) — the job's data had aged out, not jev-browse. Round 4 had the
same job at 9/10 a few hours earlier.

A person looking for a specific older trace widens the time range. The goal should say so, which also adds a realistic
date-picker step.

## Current state

`verify/langfuse.ts`:
```ts
  {
    id: 'off-topic-answer',
    …
    goal: `Go to Tracing, search the traces for the text in search_query, and open the trace whose input asks about the weather in Berlin. ${READ_ONLY}`,
    // The phrase the user remembers: plain "weather" matches too much and buries the trace pages deep.
    values: { search_query: 'weather in berlin' },
    doneWhen: 'The detail of the trace asking about the weather in Berlin is open, showing its input and output.',
    check: 'A trace is open (traceId/peek in the URL) and the page mentions the weather in Berlin',
    passes: (url, text) => openTrace(url) && /weather in berlin/i.test(text),
  },
```
Other jobs set ranges in their goals the same way (e.g. `cost-dashboard` / `monthly-cost` mention "Past 30 days"); read
them for the exact wording the Langfuse date picker shows.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: `verify/langfuse.ts`, the `off-topic-answer` job's `goal` and its comment only.

**Out of scope**: `values`, `doneWhen`, `check`, `passes`, other jobs, `src/`. Do not run `verify:langfuse` or touch the
Chrome on port 9333 (your reviewer measures it).

## Git workflow

- Commit on the branch your reviewer gave you: `test: widen off-topic-answer's time range so its trace stays findable`.
  No AI attribution. Do NOT push.

## Steps

### Step 1: The goal

Change the goal to: `Go to Tracing, set the time range to the past 30 days, search the traces for the text in
search_query, and open the trace whose input asks about the weather in Berlin. ${READ_ONLY}` — using the date picker's
own wording for the 30-day option if other jobs show it differently (e.g. "Past 30 days"). Add one line to the job's
comment: the demo's matching trace ages out of the default "Past 1 day" range.

**Verify**: `pnpm typecheck` → 0.

## Test plan

Your reviewer runs the job ×10 on desktop and ×3 on the phone layout after merging.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `git diff --stat 2c693dc..HEAD` lists only `verify/langfuse.ts`

## STOP conditions

- None beyond scope.

## Maintenance notes

- The 30-day range keeps this trace findable until about 2026-11-14. If the demo stops producing an off-topic trace,
  pick another off-topic question that recurs in the demo data rather than widening further.
