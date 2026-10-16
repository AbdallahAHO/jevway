# Plan 003: Hard page patterns are proven with real Jev, normally and under chaos

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat d38dc7e..HEAD -- verify/ package.json`
> (`d38dc7e` is the SHA in the Status block.) This plan only adds files, so drift elsewhere is fine; if
> `verify/reader.ts` or `src/task/run-task.ts` no longer exist, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: LOW (new test suite only; no source changes)
- **Depends on**: plans/001-reader-conformance-suite.md, plans/002-errors-become-hand-backs.md
- **Category**: tests
- **Planned at**: commit `d38dc7e`, 2026-10-15

## Why this matters

jev-browse runs a browser task by letting a model (TypeSafe Jev) choose one observed element per step, with
guards in `src/task/run-task.ts` that hand control back when something goes wrong. The page patterns that
broke it on a real app (search suggestions that cover the results and ignore Escape, sortable tables, date
pickers built from plain divs, targets below the fold, late-loading content) are only tested on that live
app. This plan rebuilds each pattern as a small local page with known ground truth and runs real Jev tasks
on it, first normally and then under stress (slow network, CPU throttling, DOM churn, layout shifts), so we
measure: does it reach the goal, and does it ever crash. The output is a pass-rate table, not fixes — failures
become new plans.

## Current state

- `verify/run.ts` — the existing live suite; copy its structure. Key parts:
  ```ts
  import { connectChrome, type BrowserSource } from '../src/browser/chrome.ts';
  import { Tab } from '../src/browser/tab.ts';
  import { createAsk, profileOptions, resolveModel } from '../src/jev/model.ts';
  import { BrowserTask, type TaskSummary } from '../src/task/run-task.ts';
  const { profile, screenshots } = resolveModel();
  const ask = createAsk(profile);
  ...
  const task = new BrowserTask(tab, ask, { goal, values, doneWhen, screenshots, ...profileOptions(profile), maxSteps });
  const summary = await task.run();
  ```
  Ground truth is read with a separate CDP session, never from the task's own status:
  ```ts
  const groundTruth = async (targetId: string, expression: string) => {
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const { result } = await chrome.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    return result.value;
  };
  ```
- `verify/reader.ts` (from plan 001) — serves `verify/fixture/reader/*.html` from a local `node:http` server;
  reuse that serving pattern for `verify/fixture/gotchas/`.
- `BrowserTask` options you will use: `goal`, `values` (only these strings can ever be typed), `doneWhen`
  (visible evidence of success), `maxSteps`, `screenshots`, `recordDir` (writes `run.mp4` + step shots +
  `index.html` for a run). `run()` resolves with `TaskSummary { status, reason, steps, jev: { requests } }`;
  after plan 002 it never rejects.
- `Tab` (`src/browser/tab.ts`): `Tab.open(cdp, url)`, `tab.send(method, params)` (raw CDP on the tab),
  `tab.targetId`, `tab.close()`.
- The model needs `TYPESAFE_API_KEY`. The worktree has a gitignored `.env`; scripts load it with
  `node --env-file-if-exists=.env`. **Never print or read that file's contents.** Each run costs a few cents.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| New suite (quick) | `JEV_GOTCHAS_RUNS=1 JEV_GOTCHAS_PROFILES=normal pnpm verify:gotchas` | one line per run, a summary table, exit 0 or 1 |
| New suite (full) | `pnpm verify:gotchas` | same, all profiles × 3 runs |

## Scope

**In scope**: `verify/gotchas.ts` (create), `verify/fixture/gotchas/*.html` (create), `package.json`
(add `"verify:gotchas": "node --env-file-if-exists=.env verify/gotchas.ts"` only).

**Out of scope**: everything under `src/` (failures are findings to report, not to fix), `verify/run.ts`,
`verify/reader.ts`, `verify/langfuse*.ts`.

## Git workflow

- Commit on the branch your reviewer gave you. Conventional commits, lowercase, e.g.
  `test: add gotcha fixtures with chaos profiles`. No AI attribution. Do NOT push.

## Steps

### Step 1: Fixtures (one HTML page per scenario, ground truth in `window.__fixture`)

Each page reads `new URLSearchParams(location.search).get('chaos') === '1'` and, when set, enables the chaos
behaviour listed in step 2. Keep each page under ~120 lines, plain HTML/JS.

| id | File | Page | Goal given to Jev | `values` | `doneWhen` | Pass when |
|----|------|------|-------------------|----------|-----------|-----------|
| search-suggestions | `search-suggestions.html` | `div[role=combobox][contenteditable]` search; typing shows a `role=listbox` suggestion list over the results table that closes only on an outside `pointerdown` (not Escape); pressing Enter filters 20 trace rows | Search the traces for the text in query and open the trace whose input asks about the weather in Berlin. | `{ query: 'weather' }` | A trace detail panel about the weather in Berlin is open. | `__fixture.opened === 'trace-berlin'` |
| sort-then-open | `sort-then-open.html` | 12 rows with a sortable `th` "Total cost" (click toggles none→desc→asc) | Sort the sessions by total cost, highest first, and open the most expensive session. | — | A session detail is open. | `__fixture.opened === 'session-07'` (the max-cost row) |
| date-range | `date-range.html` | a "Past 1 day" button opening a non-modal `role=dialog` with plain `div` items (cursor:pointer) | Set the dashboard's date range to the past 7 days. | — | The range button reads "Past 7 days" and the menu is closed. | `__fixture.range === '7d'` |
| below-fold | `below-fold.html` | 60 user rows (`u-0001`…`u-0060`), viewport shows ~15 | Open the user whose ID is in user_id. | `{ user_id: 'u-0047' }` | The detail page for user u-0047 is open. | `__fixture.opened === 'u-0047'` |
| late-content | `late-content.html` | skeleton rows for 2.5 s, then real rows | Open the run named "nightly-eval". | — | The run "nightly-eval" is open. | `__fixture.opened === 'nightly-eval'` |
| wizard | `wizard.html` | 2-step form: Next is `disabled` until "I agree" is ticked; step 2 has a Name field and Finish | Complete the setup wizard with the name in name. | `{ name: 'Ada' }` | "Setup complete" is shown. | `__fixture.done === true && __fixture.name === 'Ada'` |
| sticky-header | `sticky-header.html` | 40px `position:fixed` header; long list; target item "Item 23" | Open Item 23. | — | Item 23 is open. | `__fixture.opened === 'item-23'` |
| consent-first | `consent-first.html` | a cookie banner (`role=dialog aria-modal=true`, Accept/Reject) over a search box | Search for the text in query and open the first result. | `{ query: 'latency' }` | A search result for latency is open. | `__fixture.opened === 'result-1'` |
| infinite-scroll | `infinite-scroll.html` | 20 items; 20 more load each time you scroll near the bottom; "Item 55" exists after 2 loads | Open Item 55. | — | Item 55 is open. | `__fixture.opened === 'item-55'` |
| toggle-trap | `toggle-trap.html` | a "Filters" button that toggles an empty panel; the real control is a "Status: failed" chip | Show only failed runs. | — | Only failed runs are listed. | `__fixture.filter === 'failed'` |

### Step 2: Chaos profiles

`verify/gotchas.ts` runs every scenario under each profile in `JEV_GOTCHAS_PROFILES` (comma list, default
`normal,slow,churn`):

- **normal** — plain page.
- **slow** — before navigating: `tab.send('Network.enable')`, then
  `tab.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50000, uploadThroughput: 20000 })`
  and `tab.send('Emulation.setCPUThrottlingRate', { rate: 4 })`. (Open the tab on `about:blank`, apply, then
  navigate — use `Tab.open(cdp, 'about:blank')` and `tab.navigate(url)`.)
- **churn** — load the page with `?chaos=1`. Every fixture's chaos mode does all three:
  1. every 900 ms, replace the main list container's children with freshly created, identical nodes;
  2. every 1.3 s, insert or remove a 40px banner at the top (layout shift);
  3. delay each click handler's effect by a random 300–800 ms.

Runs per scenario × profile: `JEV_GOTCHAS_RUNS` (default 3). Each run: fresh tab, `maxSteps: 15`,
`recordDir` = `verify/out/gotchas-<timestamp>/<scenario>/<profile>-<run>/`. Ground truth via `groundTruth`
(above). Count a **crash** if `task.run()` rejects (it should not after plan 002) — catch it, record
`crashed: true`, continue.

### Step 3: Report

Print one line per run: `✔|✘ <scenario> <profile> #<n> — <status> in <ms>ms · <actions> actions · <reason if failed>`.
Then a table (scenario × profile → passed/total) and totals per profile, and write
`verify/out/gotchas-<timestamp>/report.json` with every run's `{ scenario, profile, run, passed, crashed, summary }`.
Exit code 1 if any run failed or crashed.

**Verify**: `JEV_GOTCHAS_RUNS=1 JEV_GOTCHAS_PROFILES=normal pnpm verify:gotchas` completes and prints the table.
Then run the full suite once: `pnpm verify:gotchas`.

## Test plan

The suite is the test. Before the full run, sanity-check each fixture by hand-driving it once with `Tab`
(open, observe, act) in a scratch script **outside the repo** to confirm its ground truth flips when the right
element is used; do not commit that script.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `pnpm verify:gotchas` runs to completion for all 10 scenarios × 3 profiles × 3 runs (90 runs) and writes `report.json`
- [ ] 0 crashes in `report.json` (`crashed: true` count is 0) — if not, report it as a finding
- [ ] Your report's NOTES contain the per-profile pass rates and every failing scenario with its final `reason`
- [ ] `git diff --stat d38dc7e..HEAD` lists only in-scope paths

The gates (normal ≥ 95%, chaos ≥ 90%) are **not** done criteria for this plan: report the numbers honestly.

## STOP conditions

- `verify/reader.ts` does not exist or `task.run()` still rejects on a thrown `observe()` (plan 002 missing).
- A fixture's ground truth can't be made to flip by hand-driving it (the fixture is wrong — fix the fixture;
  if you can't in two attempts, STOP).
- You find yourself editing anything under `src/` to make a scenario pass.
- The API key is missing (`Set TYPESAFE_API_KEY to use jev.`) — STOP; do not try to find a key.

## Maintenance notes

- Each scenario mirrors a failure seen on Langfuse's demo; when a new real-app failure is found, add its
  pattern here first.
- Chaos timings (900 ms churn, 1.3 s shifts, 300–800 ms delays) are deliberately harsher than typical apps.
- Runs cost API credits (~90 runs × ~10 requests); keep `JEV_GOTCHAS_RUNS` low while iterating.
