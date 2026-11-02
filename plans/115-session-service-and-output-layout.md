# Plan 115: one session service, a readable output layout, and summaries rich in context

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Another executor is migrating `src/mcp.ts` to SDK v2 at the same time, and phase 2
> (plans 116 and 117) wires this service into the MCP server and a CLI daemon, so never edit `src/mcp.ts`,
> `src/cli.ts`, `src/setup/` or `package.json` dependencies here.
>
> **Drift check (run first)**:
> - `src/mcp.ts` holds the session maps itself: `const sessions = new Map` and `const journeys = new Map`, with ids from
>   `randomUUID().slice(0, 8)`.
> - `TaskOptions.recordDir` exists in `src/task/run-task.ts`, and `Recording.step` names its shots `NN.jpg` in the
>   record folder's root.
> - Journeys default to `join(process.env.JEVWAY_JOURNEYS_DIR ?? 'journeys', host, stamp)` in `src/mcp.ts`, and
>   `JourneySession` writes `screens/<id>.png`.
> - `fakeTab` in `test/fakes.ts` has `markedScreenshot` but no `screenshot`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: L · **Risk**: MEDIUM (new module the adapters will call; the run loop, guards, consent
  rules and statuses are untouched) · **Category**: agent experience
- **Planned at**: commit `e755f59`, 2026-11-02

## Why this matters

- Session handling lives in `src/mcp.ts:20-21` (`sessions`, `journeys`) and the tool handlers (`src/mcp.ts:155-205`,
  `:230-240`, `:262-272`, `:297-330`). The CLI (`src/cli.ts:85-115`) can't continue a session at all. Phase 2 needs
  one transport-free core so the MCP server and a CLI daemon behave the same.
- Session ids are 8 hex characters (`randomUUID().slice(0, 8)`): guessable enough to collide with another client's
  session on a shared daemon. The 2026-07-28 stateful-tools guidance asks for opaque, high-entropy ids.
- `Unknown session "x"` (`src/mcp.ts:159`) says nothing about why or what to do; an agent retries the same id.
- Output is scattered: recordings go wherever `record_dir` points with `01.jpg …` names, journeys go to
  `./journeys/<host>/<ISO timestamp>/screens/s01.png`, and a run without `record_dir` leaves nothing behind, not even
  the final page. Nobody can tell which folder belongs to which goal, or what a file is, without opening it.
- A summary is 1–4k tokens of raw steps, `jev` stats and stuck candidates whatever the agent needs. The brief settles
  concise-by-default with a `story`, files and a `next` instruction.

## Current state

- `BrowserTask.run({ signal })` returns a scrubbed `TaskSummary`; `task.look()` returns the masked page;
  `task.closeTabs({ keepFirst })` closes followed tabs. `Recording` (only with `recordDir`) writes `NN.jpg`,
  `summary.json` (`{ summaries, video, steps, viewport }`), `index.html` and `run.mp4`.
- `describeStep` (`src/recording/recording.ts`) is the one sentence per step people read on the run page.
- `verify/run.ts` reads `summary.json`'s `summaries[1]` in a `record_dir`; `verify/jobs/rerender.ts` rebuilds
  `index.html` from `summary.json` steps (`step.file` joined to the folder).

## Scope

**In scope:**
- New `src/output/` (layout, names, slugs, manifest) with tests in `test/output/`.
- New `src/session/` (the session service) with tests in `test/session/`.
- `src/task/run-task.ts`: an `output` option (run folder: final shot, summary, manifest), per-step callback, a final
  JPEG; `src/task/present.ts`: `story`, `next`, `presentSummary`. `src/task/start-task.ts`: export `Runner`.
- `src/recording/recording.ts`: step shots under `steps/` with readable names, a manifest; past-tense step wording.
- `src/journeys/journey-session.ts`: `screens/s01-home.png` names and a manifest.
- `docs/reference.md`, `docs/how-it-works.md`, `AGENTS.md`; `test/fakes.ts` gains `screenshot`/`evaluate`.

**Out of scope:**
- `src/mcp.ts`, `src/cli.ts` (adapters, plans 116/117), `src/setup/`, dependencies, `skill/jevway/SKILL.md` wording for
  tools that don't exist yet, README.
- The daemon's idle sweep and `sessions.json` (plan 117); the service only reports `last_used_at` and names the idle
  time in its error.
- Cancelling a journey autopilot (`JourneySession` has no stop signal; changing that is journey logic, not paths).

## Decisions

1. **The service owns sessions, the task owns its folder.** `createSessionService(runner, options)` keeps the session
   and journey maps, makes ids, computes each folder and passes it down as `output: { dir, record }` through
   `runner.start` to `BrowserTask`. A `BrowserTask` with no `output` writes nothing (today's behaviour: the many
   `new BrowserTask(tab, ask, { goal })` tests stay hermetic and nothing litters the working directory).
   `recordDir` stays accepted and means `output: { dir: recordDir, record: true }`, so the untouched `cli.ts --record`,
   `mcp.ts record_dir`, `verify/run.ts` and `verify/capabilities.ts` keep working, now with readable names.
2. **Every session gets a run folder; the recording stays opt-in.** `runs/<YYYY-MM-DD_HHMM>_<goal-slug>_<id4>/` always
   holds `final.jpg` (the latest call's end page), `calls/NN-<status>.jpg` (each call's end page; `final.jpg` is a
   copy of the newest), `summary.json` (`{ summaries }`, or the recording's `{ summaries, steps, video, viewport }`) and
   `manifest.json`. `record: true` adds `run.mp4`, `steps/NN-<what>.jpg` and `index.html` in the same folder;
   `recordDir` (today's `record_dir`) is an override that puts the whole folder there instead.
3. **Ids.** Session and journey ids are a full `randomUUID()` (122 random bits). `id4` in a folder name is its first 4
   characters, so a folder maps back to its session at a glance.
4. **Paths are absolute** in `files` and every report: an MCP resource link and a daemon whose working directory
   differs from the client's both need them.
5. **Folder stamps use local time** (`2026-11-02_1430`): people browse these folders; `id4` keeps two runs in the same
   minute apart. `now` and `newId` are injectable for tests.
6. **Output root.** `JEVWAY_OUT_DIR`, else `./.jevway` resolved against the working directory. On first use the root
   gets `.gitignore` with `*` (written only when absent). `JEVWAY_JOURNEYS_DIR` replaces `<root>/journeys` as the
   journeys root (new folder names inside); a journey's `out_dir` is the exact folder, as today.
7. **Slugs**: lowercase ASCII (accents dropped), runs of anything else become one hyphen, at most 40 characters cut at
   a hyphen, `run` when nothing is left. A goal or step text is scrubbed of secret values before slugging, and the slug
   is scrubbed and slugged once more, so a secret never names a folder or file (`[secret:token]` → `secret-token`).
8. **Manifest** = a walk of the folder after each write, each file described from its name (and, for step shots, the
   step's sentence from `summary.json`): `{ kind: 'run' | 'journey', files: [{ path, kind, description }] }`, paths
   relative to the folder. Walking instead of tracking means nothing written is ever missing from it.
9. **Story and events are per call**, like `steps`. `story[i]` is one past-tense sentence for `steps[i]`, reusing
   `describeStep`'s wording plus what happened (a new tab, a dialog, a scroll that moved nothing, a field that did not
   keep its text, a step not done and why). Built from the scrubbed steps, so a secret shows only as its marker.
   `onEvent` gets `{ type: 'started', session }`, `{ type: 'step', session, n, story, url }` for each step as the loop
   reaches its next decision (so tab and dialog notes are on it), and `{ type: 'finished', session, status }`.
10. **Concise by default.** `presentSummary({ session, summary, files }, { detail })`: concise carries `session`,
    `status`, `reason`, `story`, `url`, `title`, `page_text`, `missing`, `wall`, `checks`, `evidence`, `files`,
    `next`; full adds `steps`, `jev`, `stuck`, `elapsed_ms`, `done_probability`, `confirm_ignored`. `next` is one
    short instruction per status (and per wall kind for `blocked`), in the tools' parameter names.
11. **Final screenshot** on every call with an output folder: the viewport as JPEG, quality 70, at most 1280 px wide
    (scale from `devicePixelRatio` and the CSS width), taken after the recording's final shot. A failure leaves it out
    and never changes the outcome. The bytes come back in the service's result for adapters to inline.
12. **Unknown session errors** are `SessionNotFound` (`code: 'unknown_session'`): `Unknown session "x". Sessions end
    when the server restarts[ or after 1 h idle]; start a new one with \`url\` (or \`tab\`).` Journeys the same, with
    `jevway_journey_start`'s `url`.
13. **Faithful port** of `src/mcp.ts`: a continue awaits the session's still-running call, then `update()`s; `ownsTab =
    Boolean(url)`; `end` closes `{ keepFirst: !ownsTab }` unless `keepTab`; `look` takes exactly one of
    `session`/`tab`/`url` and reads a session's tab through the masked `task.look()`; host refusals stay in
    `runner.start`/`runner.look`.

## Git workflow

1. `docs: add plan 115 session service and output layout`
2. `feat: add the output layout, slugs and manifests`
3. `feat: tell each step as a sentence and present concise summaries`
4. `feat: give a task a run folder with its end page and named step shots`
5. `feat: name journey screens by type and list a journey's files`
6. `feat: add the transport-free session service`
7. `docs: describe the output layout and the session service`
8. `fix: keep a summary in the run folder when the recording fails`

Tests first in each (red for the right reason). `pnpm release:check` passes at every handed-over commit.

## Steps

1. `src/output/layout.ts` + `manifest.ts`, tests: names, slugs with a secret, `.gitignore` once, manifest walk.
2. `src/task/present.ts` (`storyOf`, `nextFor`, `presentSummary`) + past-tense `narrateStep` beside `describeStep`;
   tests incl. a secret value and both detail levels; measure chars/4 on 3 fixture summaries.
3. `BrowserTask`: `output`, `onStep`, `lastCall` (files + JPEG); `recordDir` alias. Tests with `fakeTab`.
4. `Recording`: `steps/NN-<slug>.jpg`, removes the shot of a step that never ran, writes the manifest. Journey screens
   `screens/s01-<type>.png` + manifest.
5. `src/session/session-service.ts`: the API below, tested with a fake runner (no `vi.mock`).
6. Docs.

## Done criteria

- [x] typecheck, test, build, `npm pack --dry-run` pass (`pnpm release:check`); new tests were red first
- [x] `test/mcp.test.ts` and every existing suite pass unchanged except the recorded file names
- [x] concise vs full token counts (chars/4) measured on 3 fixture summaries and written below
- [x] `git diff --stat main` lists only in-scope paths

## STOP conditions

- Any change would alter the run loop's decisions, a guard, the consent rule or a status.
- Keeping `verify/` working would need a change to a suite's judgement rather than a path.

## Maintenance note

New output files must be described in `src/output/manifest.ts` (`describeFile`), or the manifest calls them "file".
The adapters (116, 117) should only translate: parameters in, `presentSummary` out, events to progress/NDJSON.

## Measured

Tokens as chars/4 of `JSON.stringify(…, null, 1)`, on the three fixture summaries in `test/task/present.test.ts`
(session id and absolute `files` included in both forms):

| Fixture | Today's raw summary | Concise | Full |
|---|---|---|---|
| `done` (stays search, 4 steps, evidence, a check) | 642 | 608 | 788 |
| `needs_input` (checkout form, stuck candidates) | 613 | 529 | 738 |
| `needs_confirmation` (repo delete, 3 steps with notes) | 743 | 690 | 920 |

`page_text` (about 1300–1900 characters here) is half of every form; without it, concise is about 40 % smaller than
full. Concise is smaller than today's raw summary although it adds `story`, `next` and `files`.
