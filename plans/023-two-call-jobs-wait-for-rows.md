# Plan 023: Two-call jobs wait for the table, and a missing follow-up is reported as such

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 5822f71..HEAD -- verify/jobs/ verify/langfuse.ts verify/grafana.ts`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (verify harness only; no `src/` change)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `5822f71`, 2026-10-16

## Why this matters

The Langfuse suite (`pnpm verify:langfuse`) measures jev-browse on real jobs in Langfuse's demo project. Three jobs
are **two-call**: like a calling agent, the harness lets jev-browse reach a list, reads the list's table itself, picks
a row (e.g. the experiment run with an error), and continues the same session with that row's value. If the table read
finds no matching row, the second call never happens and the run fails as if jev-browse had stopped on the wrong page.

Measured 2026-10-16: `failed-experiment` run 8 ended its first call correctly (`done` on the Experiments list after
1.9 s, the other nine took 4–8 s) but the table read found no errored row — most likely the table had not finished
loading — so it scored as a false DONE. That mislabels a harness timing gap as an agent failure and pollutes the
false-DONE count used to judge done-check changes. The harness should wait briefly for a matching row, and when there
truly is none, say so separately.

Also, the shared runner still declares an `origin` option nothing reads (left over from an earlier change); remove it.

## Current state

- `verify/jobs/runner.ts`:
  ```ts
  const readTable = async (tab: Tab): Promise<Record<string, string>[]> =>
    tab.evaluate(`(() => {
      const table = document.querySelector('table');
      if (!table) return [];
      const headers = [...table.querySelectorAll('thead th')].map((th) => th.innerText.split('\\n')[0].trim());
      return [...table.querySelectorAll('tbody tr')].map((tr) =>
        Object.fromEntries([...tr.children].map((td, i) => [headers[i] ?? String(i), td.innerText.trim()])));
    })()`);
  ...
  export interface RunJobsOptions {
    ...
    /** The app's origin. Storage is now cleared from inside each run's tab, so the runner no longer reads this. */
    origin: string;
    ...
  }
  ...
          const summaries = [await task.run()];
          // Two-call jobs: like a calling agent, read the page's table and continue the same session with a value.
          const next = job.followUp?.(await readTable(tab));
          if (next) {
            task.update({ ...next, doneWhen: job.doneWhen });
            summaries.push(await task.run());
          }
          const summary = summaries.at(-1)!;
          ...
          const passed = reached && summary.status === 'done';
          writeFileSync(new URL(`${dir}trace.json`, outDir), JSON.stringify(task.trace, null, 1));
          result.runs.push({ run, dir, passed, reached, url: url.href, summaries, ...(next && { followUp: next.values }) });
          process.stdout.write(
            `${passed ? '✔' : reached ? '◐' : '✘'} ${job.id} #${run} — ${summaries.map((s) => s.status).join(' → ')} in …${passed ? '' : ` · ${summary.reason} · ${url.href}`}\n`,
          );
  ```
  The file header's usage example (line ~15) also shows `origin: 'https://play.grafana.org',`.
- `verify/jobs/report.ts` — `RunResult` has `followUp?: Record<string, string>` ("The values the calling agent passed in
  its second call") and `error?: string`; `renderReport` shows per-run cards and a job description line
  `Second call` for jobs with `followUp`.
- Callers passing `origin`: `verify/langfuse.ts` (`origin: new URL(PROJECT).origin,`, line ~217) and
  `verify/grafana.ts` (`origin: ORIGIN,`, line ~107; `ORIGIN` is still used for `startUrl`).
- Two-call jobs in `verify/langfuse.ts`: `costliest-user`, `failed-experiment`, `power-user-sessions` (each has
  `followUp: (rows) => …` returning `undefined` when no row qualifies).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Two-call jobs (port 9333) | `CI=1 JEV_LANGFUSE_RUNS=5 JEV_LANGFUSE_ONLY=costliest-user,failed-experiment,power-user-sessions pnpm verify:langfuse` | `N/15 runs passed` and a report path |
| Grafana (no two-call jobs; checks the runner still works) | `JEV_GRAFANA_RUNS=1 pnpm verify:grafana` | `8/8` |

## Scope

**In scope**: `verify/jobs/runner.ts`, `verify/jobs/report.ts`, `verify/langfuse.ts` and `verify/grafana.ts` (only the
removed `origin:` lines).

**Out of scope**: `src/`, job goals, `doneWhen`, `passes`, `followUp` functions.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: wait for a matching row before a two-call job's second call`
  2. `refactor: drop the jobs runner's unused origin option`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Wait for a matching row; label a missing one

In `runner.ts`, for a job with `followUp`, after the first `task.run()`:
- Poll: read the table and call `job.followUp(rows)` every 250 ms until it returns a value or 5 s have passed
  (`FOLLOW_UP_WAIT_MS = 5_000`, one-line comment: a list's rows can arrive after the first call reports the list).
  Only poll when the first call ended `done` (if it didn't, there is no list to read; keep today's behaviour).
- If it still returns `undefined`: record the run with a new optional `RunResult` field
  `followUpMissing: true` and keep `passed`/`reached` computed as today (it still counts as a failure). Print the
  run line with ` · no matching row for the second call (read N rows)` instead of the summary reason, where N is the
  last read's row count.
- In `report.ts`: add `followUpMissing?: boolean` to `RunResult` with a one-line doc ("Two-call jobs: the first call
  ended done but the table had no row to continue with, so the second call never ran"), and show that sentence on the
  run's card in place of the usual failure reason. Match the existing card markup and escaping (`escape(…)`).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass. Commit 1.

### Step 2: Remove the unused option

Delete `origin` from `RunJobsOptions` (and its doc line), from the header usage example, and the `origin:` lines in
`verify/langfuse.ts` and `verify/grafana.ts`. If `PROJECT`'s origin or `ORIGIN` becomes unused anywhere, remove that
too; otherwise leave them.

**Verify**: `pnpm typecheck` → exit 0; `JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → `8/8` (headless, launches its own
Chrome). Commit 2.

### Step 3: Measure the two-call jobs

The Langfuse suite needs a Chrome signed in to cloud.langfuse.com on `http://127.0.0.1:9333`. Your reviewer starts it;
check with `curl -s -m 3 http://127.0.0.1:9333/json/version`. If it does not answer, **wait** — re-check once a minute
for up to 10 minutes — and then STOP and report if it is still down. Use that Chrome **only** through the suite; never
open it with another tool, never sign in or out.

Run `CI=1 JEV_LANGFUSE_RUNS=5 JEV_LANGFUSE_ONLY=costliest-user,failed-experiment,power-user-sessions pnpm verify:langfuse`
(foreground). Report per job: passes, runs with `followUpMissing`, and for those the row count read. Before: these jobs
were 10/10, 9/10 (one missing follow-up), 10/10 on 10-run passes.

## Test plan

No unit-testable logic beyond the types; the measurement is the evidence: a missing follow-up is labelled, and the
wait does not slow passing runs noticeably (report the median elapsed time of passing runs if the report shows it).

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0
- [ ] Grafana 1-run smoke 8/8 after removing `origin`
- [ ] Two-call jobs measured: per-job passes and `followUpMissing` counts reported
- [ ] `git diff --stat 5822f71..HEAD` lists only the four in-scope paths

## STOP conditions

- The Chrome on port 9333 is not reachable after 10 minutes of waiting, or the suite reports "not signed in".
- The change seems to need edits in `src/` or to a job's `followUp`.

## Maintenance notes

- `followUpMissing` runs are harness/data outcomes, not agent decisions; analyses of false DONEs should exclude them.
