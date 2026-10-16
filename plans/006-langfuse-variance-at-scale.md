# Plan 006: The Langfuse suite measures pass rates with error bars across devices and phrasings

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 73ed213..HEAD -- verify/langfuse.ts verify/langfuse-report.ts`
> If either changed, compare the excerpts below with the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (verify-only changes) — but runs cost API credits and use a shared, signed-in browser
- **Depends on**: plans/002-errors-become-hand-backs.md
- **Category**: tests
- **Planned at**: commit `73ed213`, 2026-10-15

## Why this matters

`pnpm verify:langfuse` runs 16 read-only jobs (an AI engineer's typical flows) in Langfuse's public demo
project and writes a recorded `report.html`. The last full run passed 47/48 at 3 runs per job — too few runs to
tell a 95%-reliable job from a 70% one, and every run used one viewport and one wording per goal. This plan
adds repeat counts, device and phrasing variants, and a 95% confidence interval per job, so the report says how
reliable each flow really is and which ones are fragile.

## Current state

- `verify/langfuse.ts` — the suite. Knobs today (lines ~222–224):
  ```ts
  const runs = Number(process.env.JEV_LANGFUSE_RUNS ?? 3);
  const only = process.env.JEV_LANGFUSE_ONLY?.split(',');
  const source = process.env.JEV_LANGFUSE_BROWSER ?? 'http://127.0.0.1:9333';
  ```
  Each run opens a tab with the default device (`desktop`, 1120×780) at line ~242:
  ```ts
      const tab = await Tab.open(chrome.cdp, PROJECT);
  ```
  Jobs are `Job` objects (type in `verify/langfuse-report.ts`): `{ id, title, job, goal, values?, doneWhen,
  firstDoneWhen?, followUp?, check, passes(url, text) }`.
- `verify/langfuse-report.ts` — `renderReport({ results, model, screenshots, readRecording })` builds the HTML;
  `JobResult = { job, runs: RunResult[] }`; `RunResult = { run, dir, passed, reached, url, summaries, followUp?, error? }`.
  A pass needs the page check **and** status `done`.
- `src/browser/devices.ts` — `DEVICES` has `desktop` (1120×780), `laptop` (1440×900), `iphone-15` (393×852,
  mobile, touch), `pixel-8`. `Tab.open(cdp, url, { device })` applies one.
- Browser: a Chrome already signed in to cloud.langfuse.com listens on `http://127.0.0.1:9333`. Only one suite
  may use it at a time. Do not open other tools against it while the suite runs.
- The model key comes from the gitignored `.env` via `node --env-file-if-exists=.env`. **Never read or print it.**

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Browser up? | `curl -s http://127.0.0.1:9333/json/version` | JSON with `"Browser"` |
| Smoke | `JEV_LANGFUSE_RUNS=1 JEV_LANGFUSE_ONLY=prompt-version pnpm verify:langfuse` | `✔ prompt-version #1`, report path printed |

## Scope

**In scope**: `verify/langfuse.ts`, `verify/langfuse-report.ts`.

**Out of scope**: `src/` (fragile jobs are findings), the job goals/checks themselves (do not reword a job to
make it pass — only add the `terseGoal` variants described below), `verify/run.ts`.

## Git workflow

- Commit on the branch your reviewer gave you. Conventional commits, lowercase, e.g.
  `test: measure langfuse pass rates across devices and phrasings`. No AI attribution. Do NOT push.

## Steps

### Step 1: Device and phrasing knobs

- `JEV_LANGFUSE_DEVICE` (default `desktop`): a key of `DEVICES`; pass `{ device: DEVICES[name] }` to `Tab.open`.
  Unknown names throw before any run starts.
- `JEV_LANGFUSE_PHRASING` (default `as-written`; or `terse`): add an optional `terseGoal` to `Job` and write one
  for **these 5 jobs only**: `longest-session`, `prompt-version`, `annotation-backlog`, `dataset-source`,
  `slowest-trace`. A terse goal is how a busy engineer would type it, ≤ 12 words, same intent and the same
  read-only suffix (e.g. `longest-session`: "Open the longest session. " + READ_ONLY). With `terse`, run only jobs
  that have a `terseGoal` and use it as the first call's goal.
- Put device and phrasing in the report header and in `results.json`.

**Verify**: `pnpm typecheck` → exit 0; `JEV_LANGFUSE_RUNS=1 JEV_LANGFUSE_ONLY=prompt-version JEV_LANGFUSE_DEVICE=laptop pnpm verify:langfuse` → passes and the report header says `laptop`.

### Step 2: Confidence intervals and flakiness in the report

In `verify/langfuse-report.ts`, add a pure helper `wilson(passed: number, total: number)` returning the 95%
Wilson score interval `{ low, high }` (z = 1.96) with a JSDoc `@example` (`wilson(9, 10)` → about
`{ low: 0.596, high: 0.982 }`). Show per job: `passed/total · 95% CI low–high`, and mark a job **flaky** when
`0 < passed < total`. Add totals: overall pass rate with its interval and the number of flaky jobs.

**Verify**: `pnpm typecheck` → exit 0; add unit tests for `wilson` in `test/jev-browse.test.ts`? **No** —
that file is out of scope; instead run `node -e` with a one-line import check:
`node --input-type=module -e "import('./verify/langfuse-report.ts').then(m => console.log(m.wilson(9,10)))"`
→ prints low ≈ 0.596, high ≈ 0.982. (Export `wilson`.)

### Step 3: Run the measurement matrix

Run, in this order, each as its own invocation (each writes its own report directory):
1. `JEV_LANGFUSE_RUNS=10 pnpm verify:langfuse` — all 16 jobs, desktop, as written (160 runs).
2. `JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_DEVICE=laptop JEV_LANGFUSE_ONLY=longest-session,prompt-version,worst-relevance,trace-to-prompt,error-observations pnpm verify:langfuse`
3. `JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_ONLY=longest-session,prompt-version,worst-relevance,trace-to-prompt,error-observations pnpm verify:langfuse`
4. `JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_PHRASING=terse pnpm verify:langfuse`

Expect run 1 to take 20–30 minutes. Run them in the background if your environment supports it and wait for
completion; do not start two at once.

**Verify**: each prints `N/M runs passed` and a report path.

## Test plan

The matrix in step 3 is the measurement; `wilson` is checked by the one-liner in step 2.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] All four invocations in step 3 completed; your report lists, for each: pass rate with 95% CI, flaky jobs,
      and every failing run's job, final status and reason
- [ ] The phone (iphone-15) result is reported separately and not mixed into the desktop headline
- [ ] `git diff --stat 73ed213..HEAD` lists only `verify/langfuse.ts` and `verify/langfuse-report.ts`

## STOP conditions

- `curl -s http://127.0.0.1:9333/json/version` fails, or the first run reports "Not signed in to Langfuse" — STOP;
  do not try to sign in.
- A smoke run fails on a job that passed in the last full run (`prompt-version`) twice in a row — STOP and
  report the reason; something in the environment changed.
- You are about to edit a job's `goal`, `doneWhen` or `passes` to make it pass.

## Maintenance notes

- Use these numbers to judge loop-guard thresholds in `src/task/run-task.ts` (they were tuned on 3-run data).
- Phone layouts collapse Langfuse's sidebar; a lower phone rate is expected and is a separate finding.
