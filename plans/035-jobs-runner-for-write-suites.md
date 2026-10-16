# Plan 035: The jobs runner can judge apps by their own state, expect a hand-back, and reset between runs

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 2c693dc..HEAD -- verify/jobs/ verify/langfuse.ts verify/grafana.ts`
> On any output for `verify/jobs/`, STOP.

## Status

- **Priority**: P1 (unblocks Goal 2's write, sign-up and checkout suites)
- **Effort**: S
- **Risk**: LOW (verify harness only; existing suites must behave identically)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2c693dc`, 2026-10-16

## Why this matters

Goal 2 adds suites that change real app state: create an issue in a self-hosted Forgejo, sign up through email, check
out a cart. Three things the shared jobs runner (`verify/jobs/runner.ts`, used by `verify:langfuse` and
`verify:grafana`) can't do yet:
1. **Judge by the app's own state.** A job's `passes(url, text)` is synchronous and sees only the final URL and page
   text. A write job needs an async check against the app's API ("does issue X now have label `bug`?").
2. **Expect a hand-back.** A pass today means the page check holds **and** the run ended `done`. A destructive job
   ("delete the repository") passes only if the run ended `needs_confirmation` and nothing was deleted; a job with a
   deliberately invalid value passes if it handed back without creating anything.
3. **Reset between runs.** Write jobs change state; every run must start from the same seeded state (an async hook
   before each run, e.g. re-seeding through the app's API).

## Current state

- `verify/jobs/report.ts`:
  ```ts
  export interface Job {
    id: string; title: string; job: string; goal: string; terseGoal?: string;
    values?: Record<string, string>;
    doneWhen: string;
    firstDoneWhen?: string;
    /** How a pass is judged, for readers of the report. */
    check: string;
    /** Ground truth from the final page, never the task's own status. */
    passes: (url: URL, text: string) => boolean;
    followUp?: (rows: Record<string, string>[]) => { goal: string; values: Record<string, string> } | undefined;
  }
  ```
  `RunResult` has `passed` ("Reached the right page and Jev reported done") and `reached` ("The ground-truth check
  alone"). The report renders a job card with `check` and per-run chips (✔ passed, ◐ reached with another status, ✘).
- `verify/jobs/runner.ts` (inside the per-run `try`):
  ```ts
          tab = await Tab.open(chrome.cdp, startUrl, { device });
          await tab.evaluate('localStorage.clear(); sessionStorage.clear()');
          await tab.navigate(startUrl);
          await before?.(tab);
          ready = true;
          …
          const url = new URL(String(await tab.evaluate('location.href')));
          const text = String(await tab.evaluate('document.body?.innerText ?? ""'));
          const reached = job.passes(url, text);
          // A pass needs both: the page is right and Jev said so. Right page with another status is only "reached".
          const passed = reached && summary.status === 'done';
  ```
  `RunJobsOptions` has `before?: (tab: Tab) => Promise<void>` ("Runs on each fresh tab before the task starts. A throw
  aborts the whole suite, not only that run.") A run that throws before `ready` stops the suite.
- `TaskStatus` is exported from `src/task/run-task.ts`
  (`'done' | 'needs_input' | 'needs_confirmation' | 'uncertain' | 'blocked' | 'step_budget'`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Grafana smoke | `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` | `8/8` (headless) |

## Scope

**In scope**: `verify/jobs/runner.ts`, `verify/jobs/report.ts`.

**Out of scope**: `src/`, every job definition (Langfuse, Grafana jobs must not change), `package.json`. Do not run
`verify:langfuse` or touch the Chrome on port 9333.

## Git workflow

- Commit on the branch your reviewer gave you: `test: let jobs check app state, expect a hand-back, and reset per run`.
  Lowercase conventional commit, no AI attribution. Do NOT push.

## Steps

### Step 1: Types

In `report.ts`:
- `passes` may return `boolean | Promise<boolean>`; update its doc ("Ground truth from the final page or the app's own
  state (e.g. its API), never the task's own status").
- New optional `expect?: TaskStatus[]` on `Job`: the statuses that count as success (default `['done']`), with a doc line
  ("A destructive job expects `needs_confirmation`; a deliberately invalid request expects a hand-back").
- `RunResult.passed` doc becomes "The ground-truth check held and the run ended with an expected status".
- In the job card, when `expect` is set, show it next to the check (e.g. "Pass: ends needs_confirmation, and …"),
  matching the card's existing markup and escaping.

### Step 2: Runner

- `const reached = await job.passes(url, text);` and `const passed = reached && (job.expect ?? ['done']).includes(summary.status);`
  keeping the one-line comment accurate.
- New optional `reset?: (job: Job, run: number) => Promise<void>` in `RunJobsOptions`, awaited **before** `Tab.open` for
  every run, with the doc line "Puts the app back in its seeded state before each run (write suites). A throw aborts the
  whole suite, like `before`." Treat a throw like a `before` failure (suite stops with a clear reason, results written).
- The console line for a run that passed with a non-`done` status shows its status as today (no change needed if it
  already prints statuses).
- Update the file header's JSDoc: mention that write suites pass `reset` and async `passes`, and `expect`.

### Step 3: Verify nothing changed for existing suites

`pnpm typecheck` → 0; `pnpm test` → all pass; `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → `8/8` (headless, launches its
own Chrome; the model key is in the gitignored `.env`, loaded by the npm script — never read or print it).

## Test plan

No new unit tests (verify harness); the Grafana smoke proves existing suites are unaffected, and the next plans' suites
exercise the new fields.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; Grafana smoke 8/8
- [ ] `git diff --stat 2c693dc..HEAD` lists only `verify/jobs/runner.ts` and `verify/jobs/report.ts`

## STOP conditions

- An existing job definition would need to change.

## Maintenance notes

- Write suites must make `reset` idempotent and fast (seconds), and their `passes` must read the app's state directly.
