# Plan 025: worst-relevance's done evidence names the trace view, and missing follow-ups keep the rows read

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat be13f06..HEAD -- verify/langfuse.ts verify/jobs/`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (verify suite only; no `src/` change)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `be13f06`, 2026-10-16

## Why this matters

The Langfuse suite (`pnpm verify:langfuse`) scores jev-browse on 16 real jobs. Each job gives jev-browse a `doneWhen`:
visible evidence that the job is finished, which the model's done check judges on every step. A `doneWhen` must
describe only what the **final** page shows, and nothing an earlier page also shows — otherwise a correct model will
end `done` too early. (This lesson already fixed `dataset-source`, whose `doneWhen` became "A trace's own view is open:
a trace ID heading with its tree of observations (not a dataset item page)".)

`worst-relevance`'s `doneWhen` is "A trace is open next to or after its answer_relevance score." The unfiltered Scores
list *also* shows trace links next to answer_relevance scores, so the done check scores that list high. Measured:
3 false DONEs in 8 runs on the Scores list on 2026-10-16 (single spikes at 0.90), and in the 160-run pass at
`76aa054` run #4 ended `done` on `/scores` through three consecutive high scores (0.89, 0.87, 0.77) while the next step
was still "type answer_relevance into Search". The job's own ground truth already says what "done" means: a trace is
open (`traceId`/`peek` in the URL, or a `/traces/` page) and the page shows answer_relevance — a passing run ends with
the trace's peek panel open over the Scores list (`…/scores?…&peek=<trace id>`).

Second, small: when a two-call job's table has no row for the second call, the run is labelled `followUpMissing`
(plan 023) and the console says how many rows were read, but not what they were; failed-experiment #3 read 8 rows and
we can't tell why none had an error. Keep a few of those rows in `results.json`.

## Current state

- `verify/langfuse.ts`, the job:
  ```ts
  {
    id: 'worst-relevance',
    title: 'Read the worst-rated answer',
    job: 'When answer quality dips, I want to open the answer with the lowest relevance score, so I can read what went wrong.',
    goal: `Go to Scores, show only scores named answer_relevance (filter by the name in score_name), sort them by Value with the lowest first, and open the trace of the lowest one. ${READ_ONLY}`,
    values: { score_name: 'answer_relevance' },
    doneWhen: 'A trace is open next to or after its answer_relevance score.',
    check: 'A trace is open (traceId/peek in the URL or a /traces/ page) and the page shows answer_relevance',
    passes: (url, text) => openTrace(url) && /answer_relevance/.test(text),
  },
  ```
  The `dataset-source` job's `doneWhen` (quoted above) is the wording pattern to follow.
- `verify/jobs/runner.ts` (from plan 023):
  ```ts
  const readFollowUp = async (tab: Tab, followUp: NonNullable<Job['followUp']>, firstCallDone: boolean) => {
    const deadline = Date.now() + (firstCallDone ? FOLLOW_UP_WAIT_MS : 0);
    for (;;) {
      const rows = await readTable(tab);
      const next = followUp(rows);
      if (next || Date.now() >= deadline) return { next, rowCount: rows.length };
      await sleep(FOLLOW_UP_POLL_MS);
    }
  };
  ...
          const { next, rowCount } = (job.followUp && (await readFollowUp(tab, job.followUp, firstCallDone))) || {};
          const followUpMissing = Boolean(job.followUp && firstCallDone && !next);
          ...
          result.runs.push({ run, dir, passed, reached, url: url.href, summaries, ...(next && { followUp: next.values }), ...(followUpMissing && { followUpMissing }) });
  ```
- `verify/jobs/report.ts` — `RunResult` has `followUpMissing?: boolean` with a one-line doc comment.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Grafana smoke (runner still works) | `JEV_GRAFANA_RUNS=1 pnpm verify:grafana` | `8/8` |

## Scope

**In scope**: `verify/langfuse.ts` (the `worst-relevance` job's `doneWhen` only), `verify/jobs/runner.ts`,
`verify/jobs/report.ts` (the `RunResult` type only).

**Out of scope**: `src/`, every other job, `passes`/`check`/`goal` of worst-relevance, the report's HTML. Do **not** run
`verify:langfuse` or touch the Chrome on port 9333: your reviewer measures Langfuse after merging.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: name the trace view in worst-relevance's done evidence`
  2. `test: keep the rows read when a two-call job finds no match`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: The done evidence

Change worst-relevance's `doneWhen` to exactly:
`"A trace is open in its own view or side panel: a trace ID heading with its tree of observations (not just the Scores list)."`
Change nothing else in the job.

**Verify**: `pnpm typecheck` → exit 0. Commit 1.

### Step 2: Keep the rows read

- `readFollowUp` also returns the last `rows` it read.
- When `followUpMissing`, add `rowsRead` to the run record: the first 10 rows, each value cut to 120 characters
  (rows can hold long text).
- In `report.ts`, add `rowsRead?: Record<string, string>[]` to `RunResult` with a one-line doc ("Two-call jobs with no
  matching row: the first rows the table showed, to see why none matched"). No HTML change.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass; `JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → `8/8`
(headless, launches its own Chrome; the model key is in the gitignored `.env`, loaded by the npm script — never read or
print it). Commit 2.

## Test plan

No unit-testable logic. Your reviewer measures worst-relevance ×10 on Langfuse after merging (before: 3 false DONEs in
8 runs on 2026-10-16 and 1 in 10 at `76aa054`).

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; Grafana smoke 8/8
- [ ] `git diff --stat be13f06..HEAD` lists only the three in-scope paths
- [ ] NOTES quote the new `doneWhen` line

## STOP conditions

- You are about to change any other job, or worst-relevance's goal, check or `passes`.

## Maintenance notes

- A `doneWhen` should name what only the final page shows (here: the trace's own heading and observation tree), never
  something an intermediate list also shows.
