# Plan 005: Loop-guard thresholds live in one documented place, marked as Jev baselines

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 73ed213..HEAD -- src/task/run-task.ts AGENTS.md`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (pure refactor; values unchanged; unit tests cover behaviour)
- **Depends on**: plans/002-errors-become-hand-backs.md (same file)
- **Category**: tech-debt
- **Planned at**: commit `73ed213`, 2026-10-15

## Why this matters

`src/task/run-task.ts` gained eight loop-guard thresholds in one day, tuned on a few runs of Jev 1.14 against
one app. They sit as scattered module constants among older ones. `AGENTS.md` says each model's thresholds are
tuned separately and must not be retuned on another model's data; these new ones carry no such marker, so the
next person may tweak them for a different model, or not realise they are provisional. Grouping them in one
named, documented object makes their status and origin explicit.

## Current state

`src/task/run-task.ts` module constants (lines ~72–100 at planning time; values must not change):
```ts
const MAX_REJECTED_DONE = 3;
const BOX_SURE = 0.5;
const COVERED_BELOW = 0.1;
const COVERED_OVERLAP_BELOW = 0.1;
const DONE_EVIDENT = 0.9;
const DONE_STEADY = 0.75;
const DONE_SUSTAINED = 3;
const SEARCH_LIKE = /search|query|find/i;
const MAX_COVERED_RETRIES = 2;
const MAX_UNREACHABLE = 3;
const WANDER_STEPS = 6;
const WANDER_CONFIDENCE = 0.5;
const REPEAT_LIMIT = 6;
const REPEAT_WINDOW = 7;
const TOGGLE_LOOP = 4;
const BOX_PADDING = 16;
```
Each has a one-line comment above it explaining its meaning. The loop-guard ones added on 2026-10-15 are:
`DONE_STEADY`, `DONE_SUSTAINED`, `MAX_UNREACHABLE`, `WANDER_STEPS`, `WANDER_CONFIDENCE`, `REPEAT_LIMIT`,
`REPEAT_WINDOW`, `TOGGLE_LOOP`.

`AGENTS.md` "Invariants" section ends with:
```
- Thresholds and rules are tuned per model. Jev's `NEXT_ACTION`, 0.3 and page-level commit risk are its verified baseline, so don't retune them on other models' data.
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass, same count as before |

## Scope

**In scope**: `src/task/run-task.ts` (only the eight constants and their uses), `AGENTS.md` (one bullet).

**Out of scope**: any value change; the older constants (`MAX_REJECTED_DONE`, `BOX_*`, `COVERED_*`,
`DONE_EVIDENT`, `SEARCH_LIKE`, `MAX_COVERED_RETRIES`); `ModelProfile` in `src/jev/model.ts`.

## Git workflow

- Commit on the branch your reviewer gave you: `refactor: group loop-guard thresholds as jev baselines`. No AI attribution. Do NOT push.

## Steps

### Step 1: Group the eight constants

Replace the eight constants with one object near the top of the module:
```ts
/**
 * Loop guards, measured on Jev 1.14 against the Langfuse demo suite (2026-10-15, 3 runs per job). Provisional:
 * revisit with the 10-run variance data before changing; other models must not inherit retuned values blindly.
 */
const GUARDS = {
  // ...the eight values, each keeping its existing one-line comment
} as const;
```
and replace every use (`DONE_STEADY` → `GUARDS.doneSteady`, etc., camelCase keys).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass; `grep -nE "\b(DONE_STEADY|DONE_SUSTAINED|MAX_UNREACHABLE|WANDER_STEPS|WANDER_CONFIDENCE|REPEAT_LIMIT|REPEAT_WINDOW|TOGGLE_LOOP)\b" src/task/run-task.ts` → no matches.

### Step 2: Note it in AGENTS.md

Append to the "Invariants" bullet above: ` The loop guards in \`GUARDS\` (run-task.ts) are Jev-only provisional baselines.`

**Verify**: `grep -n "GUARDS" AGENTS.md` → one match.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0 with the same number of tests as before
- [ ] the grep in step 1 returns nothing; every `GUARDS` value equals the old constant's value
- [ ] `git diff --stat 73ed213..HEAD` lists only `src/task/run-task.ts` and `AGENTS.md`

## STOP conditions

- Any of the eight constants is missing or has a different value from the excerpt.
- A test changes outcome after the refactor.

## Maintenance notes

When plan 006's 10-run data arrives, adjust values here (and only here) and record why in `plans/LOG.md`.
