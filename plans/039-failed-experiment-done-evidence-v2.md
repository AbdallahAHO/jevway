# Plan 039: failed-experiment's done evidence names what both layouts' results pages always show

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 2c693dc..HEAD -- verify/langfuse.ts` — only plan 036's off-topic change
> may appear; anything touching `failed-experiment`, STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (one job's `doneWhen`) · **Category**: tests
- **Planned at**: commit `2c693dc`, 2026-10-16

## Why this matters

Plan 029 reworded `failed-experiment`'s `doneWhen` so the phone layout could meet it: "An experiment run's results page
is open: a table of its dataset item inputs with the run's summary and scores." On desktop that cost 3 of 10 runs
(7/10, was 10/10): the agent opens the errored run with an ERROR filter applied, so the results table's Input column
shows "—" — "a table of its dataset item inputs" is not visible, the done check wobbles (0.2 → 0.86) and the run ends
`uncertain` on the right page. Both layouts' results pages always show **the run's name as a column heading with its
SUMMARY and SCORES** (desktop: "sdk-integration-questions-prompt-production-… / SUMMARY · this page (1 items) /
SCORES"; phone: the same column heading, SUMMARY and SCORES).

## Current state

`verify/langfuse.ts`, job `failed-experiment`:
`doneWhen: "An experiment run's results page is open: a table of its dataset item inputs with the run's summary and scores.",`

## Scope

**In scope**: that one `doneWhen` line. **Out of scope**: everything else. Do not run `verify:langfuse` or touch the Chrome
on port 9333.

## Git workflow

Commit: `test: name the run heading in failed-experiment's done evidence`. No AI attribution. Do NOT push.

## Steps

1. Set `doneWhen` to exactly: `"An experiment run's results page is open, showing the run's name as a column heading with its SUMMARY and SCORES."`
2. `pnpm install`, `pnpm typecheck` → 0. Commit.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `git diff --stat 2c693dc..HEAD` (on your branch) lists only `verify/langfuse.ts`

## Maintenance notes

- A `doneWhen` must name what the final page shows under every filter the agent may apply and on every layout.
