# Plan 112: The agent suite's report and each run's page in the report's layout, deep links to a step, phone frames

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `verify/jobs/report.ts` must export `renderReport`, and `verify/jobs/report-page.ts` must export `STYLE`, `SCRIPT`,
>   `HEAD_SCRIPT` and `FONT_LINK` (plan 106).
> - `verify/agent.ts` must have its own `const renderReport = (rows: ChoreRun[], totals: Totals)` and write
>   `results.json` as `{ model, runsPerChore, ...totals, rows }`; each run folder must hold `stream.jsonl`.
> - `src/task/recording.ts` must export `renderSteps(steps, summaries, video)` and write `index.html` with it.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW (pages people read; an additive `viewport` in `summary.json`; no
  change to a run or a judgement) · **Category**: developer experience (verify reports)
- **Planned at**: commit `1401906`, 2026-11-01

## Why this matters

Plan 106 rebuilt the jobs report (`verify/jobs/report.ts`) in the Prima Persona layout and listed what it left out: the
real-agent suite's page, the per-run `index.html`, deep links to a step, and phone recordings.

- **The agent page** (`verify/agent.ts:632`) is still a table plus one card per run. It lists only the `jevway_task`
  calls (`readStream` skips `jevway_look` and `jevway_end`, `verify/agent.ts:428`), so a reader can't see that the agent
  looked at a page before acting, or that a call was denied. In `verify/out/…/agent-2026-11-01T18-52-14-603Z` both
  chores opened with a look that the page shows only as "other tools".
- **The run page** (`src/task/recording.ts:228`) is a stack of bordered figures under a full-width video, in
  `system-ui` and its own colours. It's what `record_dir` hands a CLI or MCP user, and what every report's "Files" row
  links to.
- **Deep links:** an overview shot links to `#<job>`. The view then opens on the featured run's first step, not the
  one clicked.
- **Phone frames:** an `iphone-15` recording (`verify/out/langfuse-2026-10-16T11-04-48-842Z`: video 738×1600) sits in a
  frame as wide as the grid, `height: min(80svh, 52rem)`, with wide empty bands on both sides. The strip crops each
  portrait shot to a landscape slice (`aspect-ratio: 1120 / 780`).

## Current state

- `verify/jobs/report-page.ts`: one `STYLE` string (tokens, grid, type, overview, strip, player, facts) and one
  `SCRIPT` (router, filters, player sync, run switcher). `report.ts` holds the markup: `shotCard`, `player`, `fact`,
  `figure`, `marks`.
- `src/` can't import from `verify/`: `tsconfig.build.json` builds only `src/` into `dist/`.
- `verify/agent.ts` runs the suite at import time (top-level `await`), so nothing can import its report from it.
- No agent run records a browser video. The agent never passes `record_dir`, and the MCP server has no default.
- `summary.json` doesn't record the viewport. The screencast's frame metadata carries it (`deviceWidth`,
  `deviceHeight`).

## Scope

**In scope:**
- `src/task/recording-page.ts` (new): the design system all three pages share. That's the tokens and base CSS, the
  player's markup (frame, timeline, step strip, shot card), the player script, `escapeHtml` and the fact row.
- `src/task/recording.ts`: `renderSteps` in the new layout, plus `viewport` in `summary.json` (additive).
- `verify/jobs/report-page.ts`: keeps only the overview and router CSS and script, built on the shared base.
- `verify/jobs/report.ts`: uses the shared player; deep-link shots; frames shaped by the recording.
- `verify/agent-report.ts` (new): `renderAgentReport`, the transcript reader, and the agent row types.
- `verify/agent.ts`: imports the report and types from there, writes the out-folder name, and drops its old page.
- `verify/jobs/rerender.ts`: learns the agent folder (`results.json` with `rows`) and a run folder (`summary.json`).
- Tests: `test/report.test.ts`, plus `test/agent-report.test.ts` and `test/run-page.test.ts` (new).
- `AGENTS.md`, `README.md`: the lines on `report.html`, `index.html` and `report:render`.

**Out of scope:**
- How the agent suite runs or judges; `verify/agent-confirms.ts` (the harness executor's file).
- Recording a browser video in the agent suite. That needs a server-side default `record_dir` (see Maintenance).
- The journeys viewer, any job, any live suite.

## Design decisions

1. **Shared design system, in `src/`.** Three pages use it now, and one of them (`recording.ts`) ships in `dist/`. The
   tokens, base CSS, player CSS, the player markup (`screenFrame`, `playerMarkup`, `shotCard`), `PLAYER_SCRIPT`,
   `escapeHtml` and `fact` move to `src/task/recording-page.ts`. `recording.ts` re-exports `escapeHtml` so existing
   imports keep working. `report-page.ts` adds the overview, nav, job-head and router pieces on top.
2. **The agent report is a pure module.** `renderAgentReport({ rows, totals, model, outFolder, readRun })` uses the
   same views as the jobs report:
   - **Overview** (`#overview`): the hero sentence, then figures (pass rate with its Wilson CI, total cost with the
     runs of unknown cost, hand-backs with unusable and re-plan counts, confirm calls with honoured and ignored). Then a
     "stopped early" notice, then one hairline row per chore: marks per run, verdict counts, the status chain, cost,
     time, and the prompt.
   - **Chore view** (`#<chore>`): every run switchable. The player comes first if the run folder has a recording
     (`summary.json` with steps), else the transcript does. Then come the final answer and the judgement.
   - **Old anchors** `#<chore>-<run>` resolve to that chore's view.
3. **The transcript.** It's read from each run's `stream.jsonl`, on both the live run and a re-render, so both show
   the same thing. Every tool call is in order, with its arguments (goal first, then url, values, done_when, session
   and the rest). A call with `confirm_irreversible` carries a line with its `confirm_target` and the matching
   `describeConfirmTarget` verdict (honoured or ignored; words from the prompt or not; matched or refused). The status
   each call returned sits right-aligned: a look shows "read" and the page title; an end shows "ended"; a refused call
   shows "denied". The reason sits under it. When `stream.jsonl` is missing, the `jevway_task` calls come from
   `results.json` `calls`. Tool names show as recorded (`browser_task` in folders from before plan 108).
4. **Deep links.**
   - An overview shot links to `#<job>-r<run>-s<step>` (step counted from 1).
   - The router tries the whole hash as an id first (`#<job>` keeps working, and a job id that ends in `-r1-s2` still
     wins), then `^(.+)-r(\d+)-s(\d+)$`.
   - It shows that run's panel, seeks the video to the step without playing, and marks the step's tick and shot.
   - A reader's own seek writes the hash back with `history.replaceState`, so the address can be shared.
   - The parser is a plain-JS source string inside `SCRIPT`; the tests run it in `vm`.
5. **Frames take the recording's aspect.**
   - `summary.json` gains `viewport: { width, height }` from the first screencast frame.
   - The report uses the recording's viewport, else the suite's device (`DEVICES`).
   - The frame's `aspect-ratio` is the viewport's. A portrait frame is capped at `min(80svh, 52rem)` high, `width:
     auto`, centred with `margin-inline: auto`.
   - Strip cards use the same aspect through `--shot-aspect`, and portrait cards are half as wide.
   - The run page without a viewport (an old folder) lets the video take its poster's size.
6. **The run page** (`index.html`, one per run folder, self-contained, readable without JS):
   - A header line names the run's end ("Finished: done") with the final reason.
   - The video frame comes first, then the timeline, the clock and the step strip (the same markup and script as a
     job view).
   - Then the facts: each call's status and reason, the final address and title, Jev requests, input tokens, time and
     estimated cost, and the files.
   - `renderSteps(steps, summaries, video, viewport?)` keeps its first three parameters.
7. **`report:render`.**
   - `results.json` with `rows` → the agent report.
   - A folder with `summary.json` and no `results.json` → its `index.html`.
   - Otherwise → the jobs report, as today.

## Git workflow

Branch `wt/exec-report2` from `main` (`1401906`). Commits:
1. `docs: add plan 112 the agent and run pages in the report layout`
2. `test: describe the agent report, the run page and step deep links`
3. `refactor: share the report's design system with the run page` (the move, no visible change)
4. `feat: show the agent suite's transcript in the report layout`
5. `feat: give each run's index.html the report layout`
6. `feat: link overview shots to their step and frame phone recordings`
7. `docs: describe the agent report, run pages and step links`

Lowercase conventional commits. **No AI attribution of any kind.** Do NOT push or merge.

## Steps

### 1. Tests first
- **Agent report.** Each tool call (task, look, end, a denied one) is listed with its arguments and the status it
  returned. Confirm flags show the target and the verdict, and come before the final answer and judgement. Every fact
  the old page showed is kept (prompt, passes when, judge saw, expected hand-back, hand-backs, invented values, confirm
  calls, warnings, other tools and denials, answer, run folder, cost, turns, outcome, stopped early). Also: escaping;
  the inline script parses; a run with a recording opens on its video.
- **Run page.** The video comes before the facts. The ticks follow `video_at`. A step is marked unreachable. Escaping
  holds; the scripts parse; the page works without JS (no `.js`-gated hiding).
- **Report.** Overview shots link to `#job-rN-sM`. The hash parser maps `#flaky-r3-s2` to job `flaky`, run 3, step 2,
  and maps `#flaky` to the job alone. The panel of that run carries the step's `data-at`. The phone frame uses the
  recording's aspect (`393 / 852`), and so do its strip cards.

Run red. Commit 2.

### 2. Refactor, then the features
Steps 3 to 6 above, each with `pnpm typecheck` and `pnpm test` green.

### 3. Look at it
- Work on scratch copies under the scratchpad's `report2-check/`: `agent-2026-11-01T18-39-09-098Z`, a Forgejo folder,
  one Forgejo run folder, and the phone Langfuse folder `langfuse-2026-10-16T11-42-46-181Z`.
- Re-render each with `pnpm report:render`.
- Screenshot at 1440×900 and at 390 px through DevTools emulation, in light and dark.
- Fix what's wrong, in at most two rounds.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` exit 0, the new tests red first
- [ ] The agent page shows every fact the old one did, plus the look and end calls
- [ ] `#<job>-r<run>-s<step>` opens that run at that step; `#<job>` still works
- [ ] A phone recording's frame is as wide as its aspect needs, centred; no view scrolls sideways at 390 px
- [ ] `git diff --stat main` lists only the in-scope paths

## STOP conditions

- A secret value shows anywhere in a rendered jobs report or run page.
- Keeping `results.json` or `summary.json` readable by older code would need a field removed or renamed.

## Maintenance note

- The agent page shows a player only when a run folder has a recording. Agent runs will have one only when the MCP
  server gets a default record folder (e.g. a `JEVWAY_RECORD_DIR` the agent suite sets per run).
- A new tool in the MCP server shows up in the transcript under its own name. It needs a status line in
  `agent-report.ts` if its result has no `status`.
