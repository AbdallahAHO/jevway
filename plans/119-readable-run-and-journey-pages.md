# Plan 119: Run and journey pages a person reads in 10 seconds and an agent parses without scraping

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Other executors are rewiring `src/mcp.ts` and building `src/cli/` and
> `src/daemon/`: never edit those.
>
> **Drift check (run first)**:
> - `src/recording/recording.ts` must export `renderSteps(steps, summaries, video, viewport?)` and `describeStep`, and
>   `Recording.finish(tab, summary)` must write `summary.json` as `{ summaries, video, steps, viewport? }`.
> - `src/task/present.ts` must export `storyLine(step)`.
> - `src/journeys/render-viewer.ts` must export `renderViewer(doc)` that renders from an embedded JSON blob with
>   `innerHTML`.
> - `src/output/layout.ts` must name step shots `steps/NN-<slug>.jpg` and journey screens `screens/<id>-<type>.png`.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW (pages people read; an additive `asked` in a recorded
  `summary.json`; no change to a run, a guard or a status) · **Category**: agent and developer experience
- **Planned at**: commit `7e6458f` (`wt/round13`), 2026-11-02

## Why this matters

- The run page (`index.html` in a recorded run folder, `src/recording/recording.ts:300`) opens on "Finished: done"
  and the reason. It never says what was asked: the goal is in no file of the folder (`TaskSummary` has no goal;
  `summary.json` is `{ summaries, video, steps, viewport }`). A reader has to guess it from the folder slug.
- Its steps read as instructions ("Click "Register account"") in the next tense, on 220 px cards in a horizontal
  strip. The summary an agent gets tells the same steps as past-tense sentences (`storyLine`, plan 115) with what
  happened ("; a new tab opened: …", "Did not finish yet: …"). The page and the result disagree in wording, and steps
  that never got a shot (a rejected DONE, a covered target) are missing from the page.
- `#s3` does nothing on the run page: the player writes a step hash only inside a report's job view.
- The journey viewer (`src/journeys/render-viewer.ts`) is a blank `<div>` tree filled by `innerHTML` from a JSON blob:
  without JS it shows nothing, screens have no ids to link, QA findings open a modal that a keyboard user can't reach
  (the "links" are `<a href="#">` with a click handler), screens are named "s04" with the type as a grey chip, and the
  palette is its own (`#f5f4f1`, 14 px system font), unlike every other jevway page.
- Neither page tells an agent what it is: no generator, no machine-readable summary, no link to `manifest.json`. An
  agent fetching a folder has to scrape markup or know the file names.
- Every page loads Switzer with a render-blocking `<link>` and `preconnect` to Fontshare: opened offline from
  `file://`, the first paint waits on a request that cannot succeed.
- Light-mode `--reached` (`oklch(0.64 0.14 70)`) on white is about 3:1, under the 4.5:1 text contrast it is used at
  ("not reached ×2: covered" uses `--missed`, about 4.2:1).

## Current state

- `src/recording/recording-page.ts`: `BASE_STYLE` (tokens, 4-column grid, type, strip, player, facts), `shotCard`,
  `playerMarkup`, `PLAYER_SCRIPT`, `FONT_LINK`, `escapeHtml`. Used by the run page and both suite reports.
- `src/recording/recording.ts`: `Recording` writes `steps/NN-<what>.jpg`, `summary.json`, `index.html` via
  `renderSteps`; `describeStep` gives the next-tense sentence stored as a step's `description` (scrubbed).
- `src/task/present.ts`: `storyLine(step)` (imports `describeStep` from `recording.ts`).
- `src/journeys/render-viewer.ts`: client-rendered viewer; `JourneySession` writes it with `writeManifest(dir, 'journey')`.
- `verify/jobs/report.ts`, `report-page.ts`, `verify/agent/report.ts`: the suite reports on the shared design.
- `verify/jobs/rerender.ts` (`pnpm report:render`): rebuilds a run folder's `index.html` from `summary.json`.

## Scope

**In scope:**
- `src/recording/run-page.ts` (new): the run page (`renderRunPage(record)`, taking the `summary.json` record);
  `recording.ts` keeps `Recording` and calls it. `renderSteps` goes: its only callers were `Recording.finish`,
  `verify/jobs/rerender.ts` and its test, all updated.
- `src/recording/recording-page.ts`: shared head pieces (non-blocking font link, generator meta, embedded JSON),
  print styles, contrast-safe tokens, the story of recorded steps, step ids and file names on cards.
- `src/recording/recording.ts`: `finish(tab, summary, asked?)` records `asked` (scrubbed) in `summary.json`.
- `src/journeys/render-viewer.ts`: server-rendered on the shared design.
- `verify/jobs/report.ts`, `verify/jobs/report-page.ts`, `verify/agent/report.ts`: the shared head pieces and
  embedded summary; captions from the same story.
- `verify/jobs/rerender.ts`: pass the whole `summary.json` record; write `manifest.json` for a run folder.
- Tests: `test/recording/run-page.test.ts`, `test/journeys/viewer.test.ts` (new), `test/verify/*report*.test.ts`.
- `AGENTS.md`, `docs/reference.md`: the lines on `index.html`.

**Out of scope:**
- `src/mcp.ts`, `src/cli*`, `src/daemon/`, `src/session/`, `src/output/` (names and manifests stay as plan 115 made
  them), the run loop, any suite or job, README.

**Deviations:**
- Approved by the reviewer: one line in `src/task/run-task.ts`, the `this.#recording?.finish(…)` call in `run()`,
  gains `{ goal, doneWhen }` so the recording can name what was asked. Nothing else in that file changes.
- `src/journeys/journey-doc.ts`: `describeAction` is exported (unchanged), so a screen says how it was reached in the
  flows' own words.
- One import line in `src/task/present.ts`: `describeStep` from `../recording/describe-step.ts` instead of
  `../recording/recording.ts` (same function), to keep the page modules free of an import cycle.

## Decisions

1. **What was asked is recorded.** `Recording.finish(tab, summary, asked?)` pushes `{ goal, done_when? }`, both run
   through the session's scrubber, and `summary.json` gains `asked: [...]`, one per call, aligned with `summaries`.
   Additive: every reader of `summary.json` ignores it. Old folders have none: the page says "Goal not recorded" and
   never reconstructs it from the slug.
2. **Steps read as the agent's story.** `storyOfRecording(steps, summaries)` (in `recording-page.ts`, so reports use
   it too) splits the recorded steps at each Finished shot; segment *i* belongs to `summaries[i]`. Within a segment,
   each recorded step is matched in order to the next summary step of the same operation whose `storyLine` starts with
   the recorded description in the past tense (a covered target: "Did not <description>"; an Escape: any Escape).
   A match takes that `storyLine`; summary steps with no shot (a rejected DONE, a covered target fed back) come in as
   entries without a shot, at their place; a recorded step with no match falls back to its description with the first
   verb in the past tense (`VERBS` is a closed set). `describeStep` moves with `VERBS` to
   `src/recording/describe-step.ts` and `recording.ts` re-exports it; `present.ts` imports it from there, so
   `recording.ts` → `run-page.ts` → `recording-page.ts` → `present.ts` has no cycle back to `recording.ts`.
3. **The run page, top to bottom** (one 4-column grid, label in column 1, content from column 2):
   - Top bar: "jevway · run" and in-page links (Steps, Details, Files).
   - `<header>`: label "Asked"; `<h1>` the goal (first call's; later different goals are listed with their call);
     "Done when" under it when given. Label "Outcome": a status chip (a coloured dot + the plain word: Done, Needs
     input, Needs confirmation, Uncertain, Blocked, Out of budget) and the reason. A glance row of four figures:
     started (UTC), took, est. cost, steps; then start page and end page as addresses.
   - `<section id="recording">`: the video (or, without one, the first shot and "No video: it needs ffmpeg"), its
     timeline, the clock, the strip of shots. Each card's link names its file (`01-type-email.jpg`).
   - `<section id="steps">`: `<h2>Steps</h2>`, one `<ol>` per call (`<h3>` "Call 2 · needs confirmation" when there
     are several). Each `<li id="sN">` (N = the shot's number, the same as its file) has the sentence, a link to its
     shot file, and a link to its video time (`#sN`). Entries without a shot have no id and no links. The call's end is
     its own entry ("Ended: needs confirmation. <reason>").
   - `<section id="details">`: calls, final page (title, address), cost line, model, viewport.
   - `<section id="files">`: `summary.json`, `manifest.json`, `run.mp4`, `steps/` with one line each.
   - `<footer>`: "Recorded by jevway <version>"; the shots are for people and never reach the model.
4. **Deep links.** `#sN` without JS scrolls to step N in the list. With JS it also seeks the player to that step
   without playing. Choosing a step (tick, card or time link) plays from there and writes `#sN` back with
   `history.replaceState`. The reports keep `#<job>-r<run>-s<step>`.
5. **Machine-friendly.** Every page has `<meta name="generator" content="jevway <version>">` (version read once from
   `package.json`, `../../package.json` from `src/recording/`, the same depth in `dist/`), a
   `<link rel="alternate" type="application/json">` to its data, and embedded JSON
   (`<script type="application/json">`, `<` written as `<`): the run page's `id="jevway-summary"` is exactly the
   recorded `summary.json`; the viewer's `id="jevway-journey"` is the journey doc; a suite report's
   `id="jevway-summary"` is `{ kind, title, model, jobs: [{ id, title, runs: [{ run, passed, status, dir }] }] }`.
   The run page links `manifest.json`; `report:render` on a run folder writes it when absent.
6. **The journey viewer**, server-rendered on `BASE_STYLE`, no script:
   - Header: label "Journey", `<h1>` the site, the intent, a glance row (screens, flows, QA findings, device), the start
     address and the capture time.
   - `<section id="flows">`: per flow a `<h3>` (its path, "Homes / Searching homes"), an `<ol>` sentence of the sequence
     ("Home (s01) → Tap "Where to?" → Search (s02) → …"), then a strip of `<figure>`s: the shot with the tapped
     hotspot outlined, the caption naming the screen by type and linking to it, and the action taken there.
   - `<section id="screens">`: one `<article id="sNN">` per screen: the shot (primary action dashed), "s04 · Results"
     as `<h3>`, its title, address, description, insight, patterns, its QA findings, and how it was reached.
   - `<section id="qa">`: findings grouped by severity (High, Medium, Low, each a `<h3>` with its count), each naming
     its kind, detail and the screen it is on (a link to the screen's article). None: "No QA findings."
   - Phone journeys frame shots in the device's aspect (`DEVICES`), so nothing shifts as images load.
7. **Design tokens** (`recording-page.ts`, one set for every page):
   - Colours: `--background`, `--foreground`, `--muted` (hairlines, image wells), `--muted-foreground` (labels), and
     `--held`, `--reached`, `--missed` darkened in light mode to L 0.5 (text contrast ≥ 4.5:1 on white); dark mode as
     today, under `prefers-color-scheme` guarded by `:root:not([data-theme="light"])` and on `[data-theme="dark"]`.
     Status: done → held; needs input, needs confirmation, uncertain → reached (the agent's turn); blocked, out of
     budget → missed.
   - Type scale: label 0.75/1 rem uppercase; small 0.875/1.375; body 1/1.5; section title clamp(1.125–1.5 rem);
     page title clamp(1.75–2.5 rem); figure clamp(1.5–1.875 rem). Spacing: 0.5, 0.75, 1, 2, 4 rem.
   - Font: system stack first-class; Switzer is optional, loaded without blocking (`media="print"` swapped to `all`
     on load), no `preconnect`.
   - Print: no video, timeline or buttons; the strip wraps into a grid; links keep their text; nothing breaks inside a
     step or a screen.
   - Focus: every step, tick and card is a link or a button with the shared `:focus-visible` outline.
8. **Secrets.** The run page shows only what the recording wrote, already scrubbed (`asked` included); the jobs report
   scrubs as before. The viewer shows the journey doc as written (journeys have no `secret_keys`).

## Git workflow

Branch `wt/exec-html-pages` from `wt/round13`. Commits:
1. `docs: add plan 119 readable run and journey pages`
2. `test: describe the readable run page and journey viewer`
3. `feat: record what each call was asked`
4. `feat: tell a run's steps as its story on the run page`
5. `feat: server-render the journey viewer on the shared design`
6. `feat: give the suite reports the shared head and summary`
7. `docs: describe the run page and journey viewer`

Lowercase conventional commits. **No AI attribution of any kind.** Do NOT push or merge.

## Steps

1. Tests first (red): run page (headings in order; goal and outcome first; `#sN` items with links to shot files that
   exist in the fixture folder and video times; alt text is the step's sentence; embedded JSON parses and equals the
   record; generator meta; no secret in the page or `summary.json`; works without video; the old record without
   `asked`); journey viewer (no script needed: content in the HTML; screens by type with ids; QA grouped by severity
   linking to the screen; descriptions and insights; embedded doc parses; escaping); reports (generator, embedded
   summary parses).
2. Implement in the commit order above; `pnpm release:check` green at each handed-over commit.
3. Look at it: copies under the scratchpad's `html-pages-check/` (a five-call sign-up run, a phone Langfuse run, a
   run without video, a journey), `pnpm report:render` each, headless Chrome at 1440 and 390 px wide, light and dark
   (`data-theme` on a temp copy). Fix what's wrong; keep 2–4 final screenshots in the report folder.

## Done criteria

- [ ] `pnpm release:check` exits 0; the new tests were red first
- [ ] The run page states goal, outcome and reason, time, cost and start/end address above the video
- [ ] `#s3` opens step 3; every step links its shot file; the embedded JSON equals `summary.json`
- [ ] The journey viewer reads fully without JS; QA findings link to their screen
- [ ] No page scrolls sideways at 390 px; dark mode follows `prefers-color-scheme`
- [ ] `git diff --stat wt/round13` lists only the in-scope paths and the one approved `run-task.ts` line

## STOP conditions

- A secret value appears in a rendered page or in `summary.json`.
- Keeping `summary.json` readable by older code would need a field removed or renamed.
- The story alignment would need a change to how `Recording` names or keeps shots.

## Maintenance note

- A new `not_executed` branch that records a shot (or a new Escape the run presses itself) needs a case in
  `storyOfRecording`'s matcher, or its entry falls back to the recorded description in the past tense.
- A new recorded field shows on the page only once `run-page.ts` reads it; the embedded JSON carries it either way.
