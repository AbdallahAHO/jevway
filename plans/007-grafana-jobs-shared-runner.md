# Plan 007: jev-browse is proven on a second real app (Grafana) through a shared jobs runner

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat d92d0c1..HEAD -- verify/langfuse.ts verify/langfuse-report.ts package.json`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (refactors the Langfuse suite's runner; guarded by a before/after smoke run)
- **Depends on**: plans/006-langfuse-variance-at-scale.md
- **Category**: tests
- **Planned at**: commit `d92d0c1`, 2026-10-15

## Why this matters

Every jev-browse page-reader and loop fix of the last day was driven by one app, Langfuse. To know the fixes
are general and not tuned to one UI, we need a second, very different real app. Grafana's public sandbox
(https://play.grafana.org) needs no login, loads in headless Chrome, and is dense (dashboards, time pickers,
query editors, tables). The Langfuse suite's runner (run jobs, record each run, two-call follow-ups, page
check + `done`, HTML report) is generic but lives inside `verify/langfuse.ts`; this plan extracts it so both
apps share it, then adds 8 Grafana jobs.

## Current state

- `verify/langfuse.ts` — job list (16 `Job` objects) **and** the runner: storage reset per run, `Tab.open`,
  `BrowserTask` with `recordDir`, optional `followUp(rows)` second call using `readTable(tab)`, ground truth
  `job.passes(url, text)`, `passed = reached && status === 'done'`, `results.json`, `report.html`, `open` on macOS.
- `verify/langfuse-report.ts` — `Job`, `RunResult`, `JobResult` types and `renderReport(...)` (+ the `wilson`
  helper and device/phrasing header from plan 006). Its page title and heading say "Langfuse".
- Grafana facts (probed 2026-10-15 in headless Chrome; the page reader lists 30–56 controls per page):
  - `/` redirects to the "Grafana Play Home" dashboard: `/d/to6j8mh/grafana-play-home?from=now-6h&to=now&timezone=utc`
  - `/dashboards` has a "Search for dashboards and folders" textbox, "Tag filter", "Sort" comboboxes
  - Searching `kubernetes` lists e.g. "Kubernetes / Kubelet" → `/d/3138fa155d5915769fbded898ac09fd9/kubernetes-kubelet`,
    "Kubernetes / Compute Resources / Pod" → `/d/6581e46e4e5c7ba40a07646395ef7b23/kubernetes-compute-resources-pod`
  - Searching `logs` lists "Logs Demo Dashboard" → `/d/fdkz6t5tcm7lse/logs-demo-dashboard`
  - `/explore` has a time picker button "Time range selected: Last 1 hour" and puts the range in the `panes` URL param
  - `/alerting/list` has a "Search" textbox and "Filter by name..." textbox
  - Dashboard time ranges live in `from`/`to` URL params (`now-24h`, `now-7d`); a single-panel view adds `viewPanel=`

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Langfuse smoke (needs Chrome on :9333) | `JEV_LANGFUSE_RUNS=1 JEV_LANGFUSE_ONLY=prompt-version,costliest-user pnpm verify:langfuse` | 2/2 passed |
| Grafana | `pnpm verify:grafana` | per-run lines, report path, exit 0/1 |

## Scope

**In scope**: `verify/jobs/runner.ts` (create), `verify/jobs/report.ts` (create, moved from
`verify/langfuse-report.ts` with `git mv`), `verify/langfuse.ts`, `verify/grafana.ts` (create), `package.json`
(add `"verify:grafana": "node --env-file-if-exists=.env verify/grafana.ts"` only).

**Out of scope**: `src/` (failures are findings), Langfuse job definitions (goals, checks), `verify/run.ts`.

## Git workflow

- Commit on the branch your reviewer gave you, in this order: (1) `refactor: share the jobs runner and report`,
  (2) `test: add grafana play jobs suite`. Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Baseline the Langfuse suite before refactoring

Run the Langfuse smoke command above and note the result (expected 2/2). If Chrome on :9333 is not reachable
(`curl -s http://127.0.0.1:9333/json/version` fails), skip this step and step 3's smoke, and say so in NOTES.

### Step 2: Extract the runner and report

- `git mv verify/langfuse-report.ts verify/jobs/report.ts`; make the report's title and `<h1>` come from a
  `title` parameter (Langfuse passes "Langfuse demo: N jobs with jev-browse").
- Create `verify/jobs/runner.ts` exporting `runJobs({ name, startUrl, jobs, browser, origin, before? })` that
  contains the loop now in `verify/langfuse.ts` (storage reset for `origin`, `Tab.open`, `BrowserTask` with
  `recordDir`, follow-up via `readTable`, ground truth, `results.json`, `report.html`, macOS `open`) and the
  env knobs `JEV_<NAME>_RUNS`, `JEV_<NAME>_ONLY`, `JEV_<NAME>_DEVICE`, `JEV_<NAME>_PHRASING` (NAME uppercased,
  e.g. `LANGFUSE`, `GRAFANA`). Langfuse's "not signed in" check becomes the optional `before(tab)` hook.
- `verify/langfuse.ts` keeps only its jobs, constants and a `runJobs(...)` call. Same env names and same output as before.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass.

### Step 3: Prove the refactor changed nothing

Re-run the Langfuse smoke (if reachable). **Expected**: same result as step 1.

### Step 4: Grafana jobs

`verify/grafana.ts`: browser `JEV_GRAFANA_BROWSER` default `launch-headless`, start URL `https://play.grafana.org/`,
origin `https://play.grafana.org`. Jobs (each goal ends with "Do not sign in, create, edit, save or delete anything."):

| id | Goal | `values` | `doneWhen` | `passes(url, text)` |
|----|------|----------|-----------|---------------------|
| find-kubelet | Search the dashboards for the text in query and open the "Kubernetes / Kubelet" dashboard. | `{ query: 'kubelet' }` | The "Kubernetes / Kubelet" dashboard is open. | path starts `/d/3138fa155d5915769fbded898ac09fd9/` |
| find-pod-resources | Search the dashboards for the text in query and open "Kubernetes / Compute Resources / Pod". | `{ query: 'pod' }` | That dashboard is open. | path starts `/d/6581e46e4e5c7ba40a07646395ef7b23/` |
| logs-24h | Open the "Logs Demo Dashboard" and set its time range to the last 24 hours. | `{ query: 'logs demo' }` | The Logs Demo Dashboard shows the last 24 hours. | path starts `/d/fdkz6t5tcm7lse/` and `from=now-24h` |
| home-7d | On the Grafana Play Home dashboard, set the time range to the last 7 days. | — | The home dashboard shows the last 7 days. | path starts `/d/to6j8mh/` and `from=now-7d` |
| explore-6h | Go to Explore and set its time range to the last 6 hours. | — | Explore is open with the last 6 hours selected. | path `/explore` and decoded URL contains `now-6h` |
| view-panel | Open the "Logs Demo Dashboard" and view one of its panels on its own. | `{ query: 'logs demo' }` | A single panel is shown full-size. | path starts `/d/fdkz6t5tcm7lse/` and `viewPanel=` in the URL |
| sort-dashboards | Go to the dashboards list and sort it alphabetically from Z to A. | — | The list is sorted Z–A. | path `/dashboards` and `sort=alpha-desc` in the URL |
| alert-rules | Go to the alert rules list and search the rules for the text in query. | `{ query: 'cpu' }` | Alert rules matching cpu are listed. | path `/alerting/list` and decoded URL or page text contains `cpu` |

Run `JEV_GRAFANA_RUNS=1 pnpm verify:grafana` first. If a job fails **because its `passes` check is wrong**
(the final page clearly meets the goal on screen — check the run's last screenshot — but the URL shape
differs from the table), fix only that `passes` check and say so in NOTES with the observed URL. Never change a
goal or `doneWhen` to make a job pass. Then run `pnpm verify:grafana` (3 runs each, 24 runs).

**Verify**: both invocations finish and print `N/M runs passed` and a report path.

## Test plan

Before/after Langfuse smoke for the refactor (steps 1, 3); the Grafana runs are the measurement.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `verify/langfuse-report.ts` no longer exists; `verify/jobs/report.ts` and `verify/jobs/runner.ts` do
- [ ] Langfuse smoke result after the refactor equals the baseline (or both skipped, stated in NOTES)
- [ ] `pnpm verify:grafana` completed 24 runs; NOTES list the pass rate, each failing run's job, status and
      reason, and any `passes` check you corrected with the observed URL
- [ ] `git diff --stat d92d0c1..HEAD` lists only in-scope paths

## STOP conditions

- play.grafana.org shows a bot wall, captcha or sign-in requirement in headless Chrome — STOP (report the page text).
- The refactor changes the Langfuse smoke result (pass → fail) and you can't find why in two attempts.
- You are about to change a goal or `doneWhen`, or edit `src/`.
- Any job would need signing in, creating, saving or deleting.

## Maintenance notes

- New apps should only need a jobs file plus a `runJobs` call.
- Grafana changes its sandbox content; if a dashboard UID disappears, update that job's target, not the runner.
