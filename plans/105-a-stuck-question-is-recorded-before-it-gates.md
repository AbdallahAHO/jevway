# Plan 105: A stuck question is recorded in traces before it gates anything

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
> One more yes/no question rides in every step request; nothing acts on it. Kept if it costs no regression; its value is
> the data.
>
> **Drift check (run first)**: `buildRequest` in `src/jev/decide.ts` builds `questions` and returns `{ state, questions }`;
> `TraceEntry.decision.answers` holds every raw answer; `GUARDS` in `src/task/run-task.ts` is unchanged from `39f5928`.
> Otherwise STOP.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW (trace only) · **Category**: Jev request (prior-art J3)
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

The loop's stuck detection is deterministic (`GUARDS`: 3 unchanged pages, 6 uses in 7 actions, a toggle loop, 6 unsure
actions). Each fires only after the run has spent those steps. jkudish/jev-browser asks Jev "the actions so far are not
making progress" with true/false meanings (`src/questions.ts:14-26`) and stops above 0.85 after step 2
(`src/navigate.ts:881`), measured on two sites. Whether Jev's answer would have caught our stuck runs earlier, or would
stop good runs, is unknown: record it first (docs/prior-art.md, J3).

## Design decisions

1. Question `stuck`, in every step request (not follow-ups): `noul({ goal, rules: STUCK }, STUCK_MEANING)`, STUCK =
   "Judging the recent actions and the current page: is the run stuck, the same approach failing again and again?",
   true: "Recent actions repeat or change nothing that matters, so a different approach is needed.", false: "The recent
   actions are making visible progress, or the run has only just started." (true/false from the start, as plan 104 set.)
2. Recorded only: `decision.answers.stuck` lands in `trace.json`. No guard, status or reason reads it.
3. Analysis (in the report): per run, the stuck scores by step against how it ended (`done`, `blocked`, `uncertain`,
   others) and which guard fired; for thresholds 0.5–0.95, how many runs ending `blocked`/`uncertain` it would have
   stopped earlier (and how many steps sooner), and how many `done` runs it would have cut short.

## Scope

**In scope:** `src/jev/instructions.ts`, `src/jev/decide.ts` (one question), a test, an analysis script in the scratchpad
(not committed).

**Out of scope:** any gate on the score.

## Git workflow

`docs: add plan 105 …`, `test: the request asks whether the run is stuck`, `feat: record jev's stuck judgment in traces`.
No AI attribution, no push.

## Steps

1. Test (red first): the step request carries `stuck` with its rules and both meanings; the answer is in the trace; a
   score of 1.0 changes no status.
2. Implement; typecheck; tests.
3. Measure the slice; analyse the traces (job runner `trace.json`, `verify/run.ts` and `verify/real-world.ts` JSON).

## Done criteria

- [ ] tests red first; green after
- [ ] slice at or above the same-day baseline
- [ ] the analysis table in the report

## STOP conditions

- A red-team violation.

## Maintenance note

Gating on `stuck` is a separate plan, with its threshold set from this data and re-measured.
