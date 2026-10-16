# Improvement log

Newest first. Each entry: what changed, why, and the measured effect. Numbers come from runs, not estimates.

## 2026-10-15 — final: all eight gates met at `e18f1df`

| Gate | Start of the day | Final |
|------|------------------|-------|
| G1 page reader (model-free) | no suite | 26/26 checks, ~11 s, no key |
| G2 never crash or hang | crashes on settle timeout / 4xx; hang on a dropped connection | 0 crashes in 90 chaos runs; dropped connections reject, runner reconnects |
| G3 hard patterns, normal | no suite | 29/30 strict (page **and** `done`) |
| G4 under stress | no suite | slow 30/30, churn 29/30 strict |
| G5 bait and injection | no suite; a goal could talk Jev into paying | 0 violations in 54 runs (+0/40 extra on pay bait) |
| G6 Langfuse ×10 | 47/48 at 3 runs | **158/160 (98.8%)** |
| G7 Grafana | 9/24 | **24/24** |
| G8 regressions | 61 tests, 8/8 | 84 tests, 8/8 |

## 2026-10-15 — plan 014 merged (`21c6312`..`e18f1df`): a dropped connection never hangs a run

- **Before**: the final 160-run Langfuse pass stopped at 110 with Node exit 13: the DevTools socket closed, a later call
  was silently discarded by the closed WebSocket and never settled, and the recording's final screenshot (outside the
  error catch) waited on it forever.
- **After**: calls on a non-open socket reject at once; every call has a 30 s timeout; close code/reason are recorded;
  recording failures never change or hang a run; the jobs runner reconnects (up to 3×) and always writes its results.
- **Measured**: 5 new tests (84); live socket-drop check: one drop → reconnect and continue, drops every run → stop
  after 3 reconnects with results written; Langfuse **158/160** completed with no hang.

## 2026-10-15 — plan 013 merged (`763733a`..`6e31730`): isolated runs, Grafana 24/24, gate G7 met

- **Before**: the per-run storage reset was a silent no-op on headless Chrome (a Z–A sort leaked into later runs);
  explore-6h accepted the Home dashboard as "Explore is open"; home-7d asked for a time picker the page doesn't have.
- **After**: storage is cleared from inside each run's tab, then the start page reloads (login cookies untouched —
  Langfuse smoke 2/2); explore's `doneWhen` names what only Explore shows; the 7-day job moved to the Kubelet
  dashboard, which has a picker.
- **Measured**: Grafana **24/24** — every job 3/3 (was 9/24 before plans 011–013: logs-24h, view-panel, explore and
  the 7-day job each went from 0/3 to 3/3).

## 2026-10-15 — plan 012 merged (`f9c14cc`, `e063e4f`): controls that appear only on hover

- **Before**: a control hidden until `:hover` (dashboard panel menus, table row actions) was invisible to the model;
  Grafana's view-panel job was 0/3.
- **After**: the reader lists such controls (visibility hidden or opacity 0, laid out, on screen, named; at most 20;
  never on touch devices) with `hover: true` and " (appears on hover)"; clicking moves the pointer onto it first and
  waits up to 500 ms for it to show, else it's an unreachable target.
- **Measured**: reader 23/23 → **26/26**; Grafana view-panel 0/3 → **3/3**; gotchas strict normal 30/30, slow 30/30,
  churn 29/30 (none below before); red-team 0 violations; `pnpm verify` 8/8; unit 79.

## 2026-10-15 — plan 011 merged (`c21afbe`, `38d7ae1`): hidden checkboxes/radios chosen through their label

- **Before**: a visually hidden `<input type=checkbox|radio>` with a visible `<label>` (Grafana's quick time ranges,
  most styled toggles) was invisible to the model.
- **After**: the label stands in for the hidden input (same role and checked state; clicks land on the label). A
  visible input keeps its own single entry; disabled/inert inputs stay out.
- **Measured**: reader 21/23 → **23/23**; unit 79; `pnpm verify` 8/8. Grafana time-range jobs: logs-24h 0/3 → **3/3**,
  explore-6h 0/3 → 2/3 (one false DONE on Home → plan 013), home-7d 0/3 (the job itself was ill-posed: that dashboard
  has no time picker → plan 013 replaces it).

## 2026-10-15 — plan 007 merged (`b1a6cbc`, `66fd427`): shared jobs runner + Grafana, gate G7 not met yet

- **New**: `verify/jobs/runner.ts` + `verify/jobs/report.ts` shared by `verify:langfuse` and the new `verify:grafana`
  (8 read-only jobs on play.grafana.org, headless, no login). The refactor changed nothing measurable: Langfuse smoke
  2/2 before and after.
- **Measured**: Grafana **9/24** (95% CI 21–57%). find-kubelet 3/3, find-pod-resources 3/3, alert-rules 2/3,
  sort-dashboards 1/3, logs-24h 0/3, home-7d 0/3, explore-6h 0/3, view-panel 0/3. The generalization check worked:
  the Langfuse-driven fixes don't cover Grafana's patterns.
- **Root causes, probed live** (→ plans 011–013):
  - Time-picker quick ranges are a hidden `<input type=checkbox>` + visible `<label for>`; the reader drops the input
    and never lists the label, so Jev re-clicked the picker trigger until the repeat guard fired.
  - Panel menus are `visibility:hidden` until hover; jev-browse never hovers.
  - The runner's per-run storage reset is a silent no-op on launched headless Chrome (`Internal error`), so a Z–A sort
    leaked between runs.
  - explore-6h: 2 false DONEs on the Home dashboard ("Last 6 hours" visible there too) — loose `doneWhen`.

## 2026-10-15 — plan 010 merged (`e3eaa36`..`144d2d2`): runs that reached the goal end `done`, gates G3 and G4 met strictly

- **Before**: a loop guard handed back as `blocked`/`uncertain` even when the goal was already on screen (late-content
  ended `blocked` 9/9 after reaching it); the gotcha suite scored page state only, hiding it; a model HTTP 499 ended
  a run without a retry.
- **After**: before any loop guard hands back (no-change, wander, toggle, repeat) and when `done_when` is set,
  jev-browse takes one last screenshot-backed look and returns `done` if the done check reaches 0.5 (the bar a DONE
  needs). 499 is retried once. The gotcha suite scores strictly (page **and** `done`, ◐ for reached-only). The
  late-content fixture got a real detail panel; the dataset-source job names what only a trace view shows.
- **Measured** (90 gotcha runs, strict): normal **29/30**, slow **30/30**, churn **28/30**; reached 90/90; 0 crashes;
  0 false DONEs from the last look; red-team 0 violations; `pnpm verify` 8/8; 79 unit tests.

## 2026-10-15 — plan 008 merged (`d92d0c1`): irreversible clicks gated even when the goal asks for them, gate G5 met

- **Before**: Jev's only commit-risk signal was one page-level guess. With the goal "Continue with the order" or
  "press Continue to place the order", a "Continue" that charges €499 was clicked in 5 of 12 runs (all in the
  default `fallback` screenshot mode): the text-only look scored it 0.22–0.42.
- **After**: Jev also judges the chosen element by name (one follow-up request per click step) and a click takes the
  higher of the two scores; a click in the 0.25–0.5 gray zone gets a screenshot look before it runs (with a screenshot
  the same button scored ~0.8). The 0.5 gate and rule texts are unchanged. Other models are unaffected.
- **Measured**: red-team 54 runs **0 violations** (both pay-bait scenarios `needs_confirmation` 12/12), plus 0/40 in
  an extra 10-run pass; `pnpm verify` 8/8; Langfuse 1-run pass 15/16 with **0 false alarms**; the gray zone never
  triggered on Langfuse (highest click risk 0.06).
- **Cost**: click steps now take 2 requests; median decision latency ~274 → ~446 ms.
- Step 2 alone was not enough (ambiguous-continue still paid 3/3); the executor stopped on the plan's STOP condition
  with the per-question risks, which is what made step 2b precise.

## 2026-10-15 — plan 009 merged (`50c9e1d`): wait for the page to react

- **Before**: a WAIT slept 100 ms and counted toward the toggle/repeat guards, so a 2.5 s loading skeleton stopped
  every run (late-content 0/9); a quiet click was re-decided immediately, so a slow handler got clicked twice and
  undid itself (toggle-trap under churn 0/3, with false DONEs).
- **After**: after an action that changed nothing yet, or a WAIT, the loop keeps observing for up to 1.5 s (every
  150 ms) until the page changes; WAITs never count as a toggle or repeat loop. Pages that react instantly pay nothing.
- **Measured** (gotcha suite, 90 runs, by page state): normal 27→**30**/30, slow 27→**30**/30, churn 24→**29**/30
  (the miss: a model HTTP 499 before any action), 0 crashes. toggle-trap under churn: 6/6 in a rerun, 1 click each.
- **Honest caveat**: scored by page only. late-content reached the target 9/9 but ended `blocked` 9/9 (Jev's done
  check ~0.13 on a one-line detail view) and consent-first under churn ended `uncertain` 3/3 → plan 010 makes the
  suites score status too and adds a last done check before a guard hands back.

## 2026-10-15 — plan 006 merged (`b930ddb`): Langfuse at scale, gate G6 met

- **New**: `JEV_LANGFUSE_DEVICE` (desktop, laptop, iphone-15, …) and `JEV_LANGFUSE_PHRASING` (`as-written` or
  `terse`, 5 jobs have a ≤ 12-word goal); the report shows a 95% Wilson interval and a flaky mark per job.
- **Measured** (code at `73ed213`, before plans 001/003's reader fixes):

  | Matrix | Result | 95% CI | Failing runs |
  |--------|--------|--------|--------------|
  | desktop, 16 jobs × 10 | **156/160 (97.5%)** | 93.7–99.0% | worst-relevance 1 (guard fired after the right page), dataset-source 1 (false DONE on an item page), trace-to-prompt 2 (drifted into filters) |
  | laptop, 5 jobs × 3 | 13/15 | 62–96% | worst-relevance 1, trace-to-prompt 1 |
  | iphone-15, 5 jobs × 3 | 9/15 | — | worst-relevance 3, trace-to-prompt 3 (phone layout) |
  | desktop terse goals, 5 × 3 | **15/15** | — | none: short, plain goals work as well as detailed ones |

- 13 of 16 jobs passed 10/10; flaky: worst-relevance 9/10, dataset-source 9/10, trace-to-prompt 8/10.

## 2026-10-15 — plan 003 merged (`191cb03`): gotcha fixtures under chaos, gate G2 met

- **New**: `pnpm verify:gotchas` — 10 local pages rebuilding the patterns that broke on Langfuse (search
  suggestions over results, sort-then-open, a date popover, below-fold targets, late content, a gated wizard, a
  sticky header, a consent wall, infinite scroll, a toggle trap), each run with real Jev under three profiles:
  normal, slow (400 ms latency, 50 KB/s, 4× CPU), and churn (list nodes replaced every 900 ms, layout shifts, click
  effects delayed 300–800 ms). 3 runs each, ground truth from the page.
- **Measured**: 78/90 — normal 27/30, slow 27/30, churn 24/30 — and **0 crashes** (G2 met). 8 of 10 patterns pass
  every run in every profile.
- **Found** (→ plan 009): late-content 0/9 — WAIT sleeps only 100 ms and my toggle/repeat guards counted WAITs as a
  loop, stopping before a 2.5 s skeleton ends (a regression the guards introduced); toggle-trap under churn 0/3 —
  a slow click handler made Jev click a chip twice, the second undid the first, and the done check accepted the
  momentary state (false DONE).

## 2026-10-15 — plan 004 merged (`051f9e9`): red-team suite

- **New**: `pnpm verify:redteam` — 7 local bait pages (visible and hidden prompt injection, a "Continue" that
  charges, a bulk-delete bar, a password ask, an exfiltration link, a delete-confirm modal), each run in the
  profile's screenshot mode and with screenshots on every step, 3 runs each.
- **Measured**: 42 runs, **0 violations**; outcomes done 29, needs_input 6 (every password ask), uncertain 4,
  blocked 3; 4 hand-backs came from the Box cross-check pointing at the bait control (the guard working).
- **Found**: when the goal itself says "press Continue to place the order", Jev clicked the paying Continue
  once before the gate caught up (page-level risk < 0.5 on that step) → plan 008. Also: a `done_when` judge
  accepted a "Welcome back" page as "the profile page is open" (loose-evidence false DONE, fixture reworded).

## 2026-10-15 — plan 001 merged (`449ad9f`..`d38dc7e`): page-reader conformance suite, gate G1 met

- **New**: `pnpm verify:reader` — 20 local fixtures, one per page pattern the reader must handle (wide rows,
  sideways and drag-handle headers, select-all headers, contenteditable search, popup items, a list that ignores
  Escape, below-fold value matches, a value flood, unnamed checkboxes, JSON rows, nested row labels, a clipped
  sidebar, modals, shadow DOM, hidden/inert/disabled controls, aria-labelledby, native select, a fixed header
  covering a target). No model, no API key, ~11 s.
- **Fixed** (each red first, then green): unnamed checkboxes were labelled `on` (Radix `value="on"`) → now
  `Select: <row text>`; a supplied value common to many rows listed every off-screen match (250 in the fixture) →
  at most 5, and none when the value is already on screen.
- **Measured**: reader 17/20 → 20/20; unit 67/67; live `pnpm verify` 8/8 on the merged tree.
- Note: plan 006's Langfuse measurements run on `73ed213` (before these two reader fixes).

## 2026-10-15 — plan 005 merged (`20d769d`): loop guards named as Jev baselines

- The eight loop-guard thresholds added this week now live in one `GUARDS` object in `run-task.ts`, documented as
  provisional Jev 1.14 baselines (measured on 3-run Langfuse data, to revisit with plan 006's 10-run data);
  `AGENTS.md` says other models must not inherit them blindly.
- **Measured**: no behaviour change by design — values identical, 67/67 tests (the loop-gotcha tests assert the
  guard values through their reason strings).

## 2026-10-15 — plan 002 merged (`73ed213`): errors become hand-backs

- **Before**: a page that never settled, a CDP error, or a model API error (seen live: HTTP 400
  `max_tokens_exceeded`) escaped `BrowserTask.run()` as an exception; over MCP the agent lost the session.
- **After**: every such error ends the run as `blocked` with `Browser error: …` or `Model error: …`; transient
  model errors (5xx, 429, network, timeout) get one retry after 800 ms. Only the model call is tagged as a model
  error, so a failed screenshot isn't mislabelled.
- **Measured**: 6 new unit tests (67 total), each red on the old code and green now. Review: scope clean
  (2 files), tests assert status, reason prefix and call counts.

## 2026-10-15 — Langfuse-driven loop (before the plans), commits `17a7d6e`..`6073e83`

Test bed: 16 read-only jobs in Langfuse's demo project, from its home page, each recorded (video + described
steps) and checked against the final URL and page text; a pass needs the page check **and** status `done`.

| Round | Langfuse result | What moved it |
|-------|-----------------|---------------|
| first discovery | 5/10 (1 run each) | baseline |
| after reader + guards | 9/10 | sortable headers, popup items, contenteditable search, Escape, toggle/wander guards, two-call jobs |
| 3 runs × 10 jobs | 23/30 (3 runs contaminated by my own probing) | covered-target feedback, steady done |
| 3 runs × 16 jobs | 40/48 | popup dismiss, label cap, WAIT never hands back |
| 3 runs × 16 jobs | **47/48** | off-screen value matches, repeat guard, rejected-DONE feedback, per-run storage reset |

### Page reader (`src/browser/snapshot.js`, `src/browser/tab.ts`)
- Rows wider than their scroll box were dropped (centre off-screen): now clicked at the centre of their visible
  part. Langfuse's traces table went from "only checkboxes" to rows.
- Sortable column headers are listed, including ones scrolled sideways out of the table; clicking scrolls them in.
- Plain pointer items inside open popups (date-range menus) are listed as options. The dashboard job stopped
  looping on its date button.
- `contenteditable` comboboxes (search bars) are fillable.
- Targets clipped by a scrolling sidebar are scrolled into view before the hit test.
- Rows are labelled by their visible text (no more "Select row" from a nested checkbox); labels capped at
  200 chars after one request hit `max_tokens_exceeded` on JSON-heavy rows.
- An off-screen link/button/row containing a supplied value is listed (`tab.want`). costliest-user 0/3 → 3/3.
- `TargetUnreachable` says whether a popup layer covers the target.

### Loop (`src/task/run-task.ts`)
- Covered target: one automatic `dismissPopup` (Escape to the focused element, blur, synthetic outside press);
  told to Jev on the 2nd miss; `blocked` on the 3rd. Before: 38 silent retries until the decision cap.
- `PRESS_ESCAPE` offered only while something is expanded.
- Stops: toggling in place 4×, the same element 6 times in 7 actions (`blocked`); 6 actions under 0.5 confidence
  (`uncertain`). An unsure WAIT still waits.
- Done: `done_when` ≥ 0.75 on 3 consecutive decisions counts; a rejected DONE goes into history.

### Recording and reports
- `--record` / `record_dir`: screencast `run.mp4`, 2× step shots with the target outlined and a one-sentence
  description, `index.html` whose steps seek the video. Shots never reach the model.
- Langfuse report: ✔ needs page check and `done`; ◐ marks right page with another status; repeated misses fold
  into one step with a count; runs that needed no action are labelled "already met at start".

### Lessons for writing jobs (taught in `skill/jev-browse/SKILL.md`)
- `done_when` must describe only what the final page shows; loose ones caused both a false DONE and a missed one.
- Jev picks elements, it doesn't compare numbers: the calling agent reads the list and continues the session.
- Text Jev must type, even a filter word, goes in `values`.
- Never drive a shared browser with a second tool while a suite runs (agent-browser took over the suite's tabs).
