# Plan 106: The verify jobs report in the Prima Persona layout, the video first

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `verify/jobs/report.ts` must export `renderReport`, `wilson`, `isFlaky`, `goalFor` and the types `Job`,
>   `JobResult`, `RunResult`, `Confirmation`, `FollowUp`, `Phrasing`.
> - `verify/jobs/runner.ts` must call `renderReport({ title, results, model, screenshots, device, phrasing, readRecording })`
>   and write `results.json` as `{ device, phrasing, runsPerJob, results }`.
> - `src/task/recording.ts` must export `RecordedStep` with `video_at`, `unreachable` and `attempts`, and write
>   `summary.json` as `{ summaries, video, steps }`.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW (a report page and an additive `results.json`; no change to a run) ·
  **Category**: developer experience (verify reports)
- **Planned at**: commit `7645118` (`wt/exec-integration`), 2026-11-01

## Why this matters

`report.html` is how a person checks a suite: it is the page `pnpm verify:forgejo`, `:signup`, `:checkout`,
`:langfuse` and `:grafana` open when they finish. Today (`verify/jobs/report.ts`) it is a stack of cards, one per job:
the facts first, then chips, then the featured run's video below them, then a vertical list of 220 px shots. To watch
what Jev did, a reader scrolls past every job's facts; only one run per job has a recording on the page, and the step
list and the video are not kept in sync (a click seeks, playing marks nothing).

The approved prototype (Lexington's Prima Persona theme: a strict 4-column grid, monochrome, hairline rows, Switzer)
shows the same data as an index of jobs with a strip of each featured run's real step shots, and a job view that opens
on its screencast with the steps on a timeline under it, every run switchable. The user asked for it built "as in the
prototype nicely", "well aligned", "the video at the first part", and "solid".

The prototype had bugs to avoid: the hero sat in the left half (`grid-column: span 2` reset its start column), step
shots stretched tall (a presentational `height` beat `aspect-ratio`), the video top fell below a 1440×900 fold (12 rem
of intro padding), it rendered everything from a JSON blob with `innerHTML`, and it marked runs only held or missed.

## Current state

- `verify/jobs/report.ts`: the types every suite imports (`Job`, `RunResult`, …), `wilson` (imported by
  `verify/agent.ts`), `isFlaky`, and `renderReport`, which calls `new Date()` for its footer and so is not pure.
- `verify/jobs/runner.ts` renders the report and writes `results.json` as `{ device, phrasing, runsPerJob, results }`.
  `JSON.stringify` drops `passes` and `followUp` (functions) and writes `confirms` (a RegExp) as `{}`. It has no title,
  model, screenshots mode or time.
- `src/task/recording.ts`: each run folder has `summary.json` (`{ summaries, video, steps }`); a step's `video_at` is
  its offset in `run.mp4`, absent without ffmpeg. The last step of each call is the "Finished: <status>. <reason>"
  shot, with the status as its (lowercase) operation. The last frame of the video holds 1.5 s.
- No test covers the report.

## Scope

**In scope:**
- `verify/jobs/report.ts`: the page, rewritten; `wilson`, `isFlaky`, `goalFor` and the job types unchanged.
- `verify/jobs/report-page.ts` (new): the page's CSS and its inline script, as string constants, so `report.ts` stays
  readable.
- `verify/jobs/rerender.ts` (new) and a `report:render` script in `package.json`.
- `verify/jobs/runner.ts`: pass the out-folder name; write `title`, `model`, `screenshots`, `writes` and the `confirms`
  pattern into `results.json` (additive).
- `test/report.test.ts` (new).
- `AGENTS.md`, `README.md`: the lines describing `report.html`.

**Out of scope:**
- `verify/agent.ts`'s own report, the per-run `index.html` from `src/task/recording.ts`, the journeys viewer.
- Any job definition or check, `verify/vikunja.ts`, `verify/apps/vikunja/`.
- Live suites: none is run; the page is checked by re-rendering existing out folders into a scratch copy.

## Design decisions

1. **One file, server-rendered views.** `renderReport` stays a pure function (no clock: the footer time comes from the
   out-folder name, which is the suite's start time, else "time unknown"). Every view is in the HTML in document order:
   the overview (`#overview`, with `#jobs` and `#method` inside), then one `<section class="view job-view" id="<job id>">`
   per job. Without JS the page reads as one long document. With JS (a `js` class set in `<head>`), only the current
   view shows: the job whose id is the hash, else the overview (empty hash, `#jobs`, `#method` or unknown). No JSON
   blob, no `innerHTML`: the script reads `data-` attributes.
2. **Every run is rendered.** Each job view holds one run panel per run (`data-run`), the featured run (the first
   passing one, else the first) shown, the others `hidden` and shown by the run switcher. Every `<video>` has
   `preload="none"`; only the featured run's has `poster` (its first step shot), the others carry `data-poster` that the
   switcher turns into `poster`, so 33 runs don't fetch 33 posters. Shots in hidden views are `loading="lazy"`.
3. **The player.** The video frame spans cols 1–4 (rounded 2 rem). Under it: a timeline with one numbered tick per step at
   `video_at / duration`, the duration estimated as the last `video_at` + 1.5 s and corrected on `loadedmetadata`; then
   the run switcher ("Run 2 ● done") and the clock on one line. Clicking a tick or a shot seeks (and plays, muted); while
   playing, the current step's tick and shot get `aria-current="step"` and the shot scrolls into view inside its strip
   (`scrollLeft`, never `scrollIntoView`, so the page itself does not move). No video (no ffmpeg): the frame shows the
   first shot, there are no ticks, and clicking a shot shows it in the frame. No recording at all (an error, not run):
   a quiet panel with the reason in the frame's place.
4. **Marks.** `●` passed (green), `◐` reached but ended with another status (amber), `○` missed (red); a run that never
   ran is `○` muted with "not run".
5. **The Finished card is the recording's own.** The strip shows the recorded steps as they are; the final shot of each
   call is a "Finished: <status>" card (muted), its reason in the alt text and the facts. No synthetic card: a two-call
   job shows one per call.
6. **Kind.** Hand-back when the job has `expect`; otherwise Write when the suite writes, else Read. A suite writes when
   it resets the app (`reset`) or any of its jobs confirms a click (`confirms`): Forgejo, checkout and Vikunja reset,
   sign-up confirms. The runner records it as `writes`; for older folders the re-render tool infers it from any job
   having a `confirms` key, so an old checkout folder may read as Read.
7. **What the page takes.** `renderReport` accepts a `ReportJob`: `Job` without its functions, `confirms` a RegExp or
   its source string. A two-call job is one with `firstDoneWhen`, a `followUp`, or a run with `followUp` or
   `followUpMissing`. New optional inputs: `outFolder` (footer, nav, start time) and `writes`. The required inputs are
   unchanged, so the runner's call still type-checks.
8. **Secrets.** Values are shown only through `shownValues(values, secretKeys)`, the second call's values too.
9. **Grid.** One `.grid4` (4 equal columns, 1 rem gap at ≥ 64 rem, one column below) inside one `.wrapper`, used by
   every row of both views. Start and span are set together (`grid-column: 2 / span 2`, `3 / span 2`), never a bare
   `span N`. Labels are col 1, primary text starts at col 2, actions sit in col 4, right-aligned, baseline-aligned with
   the row's title. Video, strips and hairlines are direct children of the wrapper, so their edges are the text
   columns' edges. Step shots: `aspect-ratio: 1120/780; height: auto; object-fit: cover; object-position: top`; captions
   clamp to two lines with a fixed height so the cards line up.
10. **Theme.** Four tokens (background, foreground, muted, muted-foreground) plus held/reached/missed, on `:root`, dark
    under `prefers-color-scheme` guarded by `:root:not([data-theme="light"])` and on `:root[data-theme="dark"]`.
    Switzer from Fontshare (400/500) with a system fallback. Reduced motion respected, focus-visible outlined.

## Git workflow

Branch `wt/exec-report` from `wt/exec-integration`. Commits:
1. `docs: add plan 106 a verify report in the prima persona layout`
2. `test: describe the verify report a reader sees`
3. `feat: rebuild the verify report with the video first`
4. `docs: describe the new verify report and report:render`

Lowercase conventional commits. **No AI attribution of any kind.** Do NOT push or merge.

## Steps

### 1. Tests first

`test/report.test.ts`, fixtures in the file, testing what a reader sees:
- The hero says how many runs ended as expected, of how many, and the figures row carries the Wilson interval.
- Filters: Flaky only with a flaky job, Failed only with a job that never passed.
- Every job has a view whose `<video>` comes before its facts; ticks match the steps in `video_at` order; `preload="none"`
  everywhere, `poster` only on the featured run.
- A secret value (also planted in a step description and a reason, as a page might echo it) never appears.
- Escaping: `<script>` and quotes in a title and a reason come out as text.
- Edge cases: an error with no summaries, not run, a recording without video, an unreachable step ("not reached ×2:
  covered"), 0 actions ("already met at start"), reached but not passed (◐), a two-call job (first done when, second
  call values, a missing row with the rows read), confirmations, a job with no values.

Run them red. Commit 2.

### 2. The page

Rewrite `renderReport` as decided above; CSS and script in `report-page.ts`. Runner: pass `outFolder` and `writes`,
write `title`, `model`, `screenshots`, `writes` and `confirms: String(job.confirms)` into `results.json`.
`verify/jobs/rerender.ts <out dir>`: reads `results.json` and each run's `summary.json`, rebuilds `report.html`; title
from the folder name and job count when absent; model and screenshots "unknown" when absent. `pnpm typecheck` and
`pnpm test` pass. Commit 3.

### 3. Look at it

Copy three out folders into the scratchpad (`report-check/`): a Forgejo run with a flaky job, a sign-up run (two-call
jobs, confirmations, a secret), and the Langfuse gate run with a 0/3 job. Re-render each, screenshot with headless
Chrome at 1440×900 (overview, job view), 390×844 (both), and once dark. Fix misalignment, overflow and clipping; at
most two rounds.

### 4. Docs

`AGENTS.md` and `README.md`: the report opens on each job's video with the steps synced under it; `pnpm report:render`.
Commit 4.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, the new tests red first
- [ ] At 1440×900 a job view shows the top of its video without scrolling; no view scrolls horizontally at 390 px
- [ ] Re-rendered old folders show everything the old report showed (statuses, reasons, URLs, values, confirmations,
      second calls, cost, CI, flaky)
- [ ] `git diff --stat wt/exec-integration` lists only the in-scope paths

## STOP conditions

- A secret value appears anywhere in a rendered report.
- Keeping `results.json` readable by older code would need a field removed or renamed.

## Maintenance note

The page trusts `summary.json` for steps and video. A new recorded field (a step kind, a second video) needs a line in
`report.ts` and a fixture in `test/report.test.ts`. Tick positions assume the last frame holds 1.5 s
(`LONGEST_FRAME_S` in `recording.ts`) until the video's metadata arrives.
