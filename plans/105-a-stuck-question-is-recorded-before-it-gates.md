# Plan 105: A stuck question is recorded in traces before it gates anything

> **Result: KEPT (2026-11-01), trace only.** Code `6a1573e` (test), `65935e1` (feat), on top of plan 103 (kept) with
> plan 104 rejected, so `stuck` is the only question carrying true/false meanings. Same day as the baseline at `39f5928`:
>
> | Suite | Baseline | 103 | 105 |
> | --- | --- | --- | --- |
> | `pnpm verify` | 8/8 | 8/8 | 8/8 (`verify/out/2026-11-01T17-31-30-658Z`) |
> | red-team | 0 violations, 39/78 | 0, 38/78 | 0, 41/78 (`redteam-…T17-32-04-065Z`) |
> | gotchas | 88/90 | 90/90 | 89/90 (`gotchas-…T17-31-31-612Z`; wizard churn stale, the 078 flake) |
> | real ×3 | 18/21 | 17/21 | 18/21 (`real-…T17-31-32-603Z`) |
> | Forgejo ×3 | 33/33 | 32/33 | 31/33, re-run 32/33 (`forgejo-…T17-31-33-651Z`, `…T17-38-43-300Z`) |
>
> - Forgejo's losses are wiki-off (DONE ×3 after the toggle note) and protect-main ("Save rule" at 0.24). wiki-off
>   flakes on the baseline too: 7/10 on `39f5928` (`exec-d-jev-base/verify/out/forgejo-2026-11-01T17-43-29-350Z`),
>   4/5 on 103, and 5/5 on 105 (`…T17-42-34-587Z`).
> - Cost: Forgejo 8496 input tokens per request (103: 8482), red-team 5348 (5185, +3%).
>
> **What the scores say** (99 runs with traces: Forgejo ×3 twice, wiki-off ×5, real ×3, `pnpm verify`; gotchas and
> red-team keep no traces). The gate tested is jkudish's: from the 3rd decision on, at or above the threshold.
>
> | Threshold | `blocked`/`uncertain`/`step_budget` runs it stops (decisions earlier) | `done` runs it cuts short (of 75) |
> | --- | --- | --- |
> | 0.5 | 11/12 (1, 0, 1, 2, 1, 0, 0, 2, 22, 22, 22) | 12 |
> | 0.6–0.8 | 5/12 (2, 2, 22, 22, 22) | 6 at 0.6, 2 at 0.7, 1 at 0.75–0.8 |
> | 0.85 | 5/12 (2, 1, 22, 21, 21) | 1 (booking-1, a false `done` on the city page, 0.85) |
> | **0.9** | **5/12 (0, 0, 21, 21, 21)** | **0** |
> | 0.95 | 3/12 (17, 17, 16) | 0 |
>
> - **What it sees**: npm's Cloudflare challenge (`step_budget` after 25 decisions) scores 0.82–0.85 from the 3rd
>   decision and 0.90–0.96 after that; a gate at 0.9 would have handed it back 21 decisions sooner, the only real
>   saving. wiki-off's DONE loop climbs to 0.83–0.90, but only at the last decisions, where the loop guard already
>   stops it. Jev's rejected forms (bad-name) sit at 0.52–0.59: the error stop (plan 103) already handles them.
> - **What it misses**: protect-main's `uncertain` (≤ 0.20), and the runs ended by the no-change and repeat guards. The
>   deterministic guards stay necessary.
> - **Threshold, if one is ever wanted**: 0.9 after the 2nd decision stops no run that ended `done` here, and its one
>   gain is a bot wall, which S5's DOM check (another plan) targets directly. So no gate is recommended now; collect
>   Langfuse and checkout traces (not run here) before reconsidering.

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
