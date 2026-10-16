# Plan 013: Every jobs-suite run starts from clean browser storage, and Grafana is re-measured

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 38d7ae1..HEAD -- verify/jobs/runner.ts verify/grafana.ts`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (verify-only)
- **Depends on**: plans/011 (DONE), plans/012-hover-revealed-controls.md (re-measure after it lands)
- **Category**: tests
- **Planned at**: commit `38d7ae1`, 2026-10-15

## Why this matters

The shared jobs runner (`verify/jobs/runner.ts`, used by `verify:langfuse` and `verify:grafana`) tries to start each
run with the app's local and session storage cleared, because apps remember choices (date ranges, sort orders) in
storage and one run's choice leaked into the next. On a launched headless Chrome the browser-level call
`Storage.clearDataForOrigin` fails with `Internal error`, and the runner swallows the error, so the reset silently does
nothing. Measured on Grafana: a Z–A sort chosen in run 1 was already applied in runs 2 and 3, so the model correctly saw
it as done but the URL check (`sort=-name_sort`) failed. Also, the `explore-6h` job had 2 false DONEs: its `doneWhen`
("Explore is open with the last 6 hours selected.") was accepted on the Home dashboard, which also showed "Last 6 hours".

## Current state

- `verify/jobs/runner.ts:81-86`:
  ```ts
        // Each run starts clean: apps remember date ranges and views in browser storage, which leaked one run's
        // choices into the next (a 30-day range set on Home made the next run "done" with no action). Login cookies stay.
        await chrome.cdp
          .send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,session_storage' })
          .catch(() => undefined);
        const tab = await Tab.open(chrome.cdp, startUrl, { device });
  ```
- `Tab` (`src/browser/tab.ts`): `Tab.open(cdp, url, { device })`, `tab.evaluate(expr)`, `tab.navigate(url)`.
- `verify/grafana.ts` job `explore-6h`: `goal: \`Go to Explore and set its time range to the last 6 hours. ${READ_ONLY}\``,
  `doneWhen: 'Explore is open with the last 6 hours selected.'`.
- Login must survive (Langfuse runs use a signed-in Chrome on :9333): clear storage only, never cookies.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Grafana | `pnpm verify:grafana` (`JEV_GRAFANA_RUNS`, `JEV_GRAFANA_ONLY`) | per-run lines, report path |
| Langfuse smoke (:9333) | `CI=1 JEV_LANGFUSE_RUNS=1 JEV_LANGFUSE_ONLY=prompt-version,monthly-cost pnpm verify:langfuse` | 2/2 |

## Scope

**In scope**: `verify/jobs/runner.ts`, `verify/grafana.ts` (only the `explore-6h` job's `doneWhen` and the `home-7d` job, step 2b).
**Out of scope**: `src/`, other jobs' goals/checks, `verify/jobs/report.ts`.

## Git workflow

- Commit on the branch your reviewer gave you: `test: clear app storage inside each run's tab`,
  `test: name what only explore shows in the explore job`. No AI attribution. Do NOT push.

## Steps

### Step 1: Clear storage from inside the page

Replace the browser-level call with a reset that works on any Chrome: open the tab at `startUrl`, then
`await tab.evaluate('localStorage.clear(); sessionStorage.clear()')`, then `await tab.navigate(startUrl)` so the app
reloads without its remembered state. Keep a one-line comment saying why (the browser-level `Storage.clearDataForOrigin`
fails with "Internal error" on launched headless Chrome). If `evaluate` throws (e.g. a cross-origin redirect), fail
the run with that error instead of swallowing it.

**Verify**: `pnpm typecheck` → exit 0. Then a check of the reset itself: `JEV_GRAFANA_RUNS=3 JEV_GRAFANA_ONLY=sort-dashboards pnpm verify:grafana`
→ in each run's recording the first screenshot shows the default sort (not Z–A); report the per-run results.

### Step 2: Explore's done evidence

Change `explore-6h` `doneWhen` to: `'The Explore page is open (its title and breadcrumb read Explore, with a query editor), and its time range reads "Last 6 hours".'`

### Step 2b: Fix the home-7d job (it asked for something the page doesn't have)

Measured after plan 011: home-7d 0/3. The Grafana Play Home dashboard has **no dashboard-level time picker** (its
toolbar shows only Share and Edit; the only range control is per-panel "Last 30 days"), so the job was ill-posed.
Replace it with the same intent on a dashboard that has a picker:
- id `kubelet-7d`, title "Last week on the Kubelet dashboard", goal
  `Open the "Kubernetes / Kubelet" dashboard and set its time range to the last 7 days. ${READ_ONLY}`,
  `values: { query: 'kubelet' }`, doneWhen `The Kubernetes / Kubelet dashboard shows the last 7 days.`,
  passes: path starts `/d/3138fa155d5915769fbded898ac09fd9/` and `from=now-7d`.
Remove `home-7d`. Commit as `test: move the 7-day job to a dashboard with a time picker`.

### Step 3: Re-measure

1. `pnpm verify:grafana` (all 8 jobs × 3; foreground, split with `JEV_GRAFANA_ONLY` if a call would exceed 10 minutes).
   Before (plan 007, without plan 011's fix): 9/24.
2. Langfuse smoke on :9333 → 2/2 (login survived the new reset).

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] sort-dashboards runs start from the default sort (screenshots), reported
- [ ] Grafana 24-run result reported per job with each failure's status and reason
- [ ] Langfuse smoke 2/2
- [ ] `git diff --stat 38d7ae1..HEAD` lists only in-scope paths

## STOP conditions

- The Langfuse smoke shows "Not signed in" after the change (the reset touched login) — STOP immediately.
- `tab.evaluate` of the clear fails on every run.

## Maintenance notes

- If an app keeps state server-side per account (Langfuse's saved date range), clearing storage can't reset it; the
  report labels such runs "already met at start".
