# Plan 116: an agent-first MCP server on the session service

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Another executor rewrites the CLI and adds a daemon (`src/cli/`, `src/daemon/`)
> and a third reworks the HTML pages (`src/recording/recording-page.ts`, `src/journeys/render-viewer.ts`,
> `verify/jobs/report*`): never edit those. Small fixes in `src/session/` are allowed and named in the report.
>
> **Drift check (run first)**:
> - `src/mcp.ts` still holds `const sessions = new Map` and `const journeys = new Map`, with ids from
>   `randomUUID().slice(0, 8)`, and `rg -n "createSessionService" src/mcp.ts` is empty.
> - `src/mcp.ts` registers no `outputSchema` and passes no `instructions` to `new McpServer`.
> - `src/session/session-service.ts` exports `createSessionService`, `UnknownSession` and `SessionEvent`;
>   `src/task/present.ts` exports `presentSummary`.
> - It ends with `serveStdio(createServer, …)` (plan 114).
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MEDIUM (every MCP result changes shape: concise by default; the run
  loop, guards, consent rule and statuses are untouched) · **Category**: agent experience
- **Planned at**: commit `7e6458f` (`wt/round13`), 2026-11-02

## Why this matters

- `src/mcp.ts` keeps its own session maps (`:28-29`) and 8-character ids (`:155`), so the session service plan 115
  built (UUIDs, run folders, story, `next`, errors that say what to do) reaches no agent yet.
- The tool list is heavy: measured with a stdio client over `tools/list` (chars/4 of each tool's JSON),
  `jevway_task` is 2,771 tokens (description 1,175, input schema 1,548, of which the `checks` union alone is 581) and
  all 8 tools are **4,515**. A client that loads tools upfront pays that on every turn; Claude Code shows only names and
  the server's `instructions` upfront, and jevway sends no `instructions` at all.
- Results are raw summaries (1–4k tokens, steps with confidences, Jev stats) in one text block: no
  `structuredContent`, no link to the end page, no image on a hand-back, no progress while a run takes 10–60 s.
- `Unknown session "x"` says nothing about why or what to do.

## Current state

- `createSessionService(runner, options)` (`src/session/session-service.ts`): `task(request, { signal, onEvent })`
  returns `{ session, summary, files?, screenshot? }`; `look`, `end`, `journeyStart/Step/Autopilot/Annotate/Finish`.
  `onEvent` hears `started`, `step` (`n` from 1 per call, `story`, `url`) and `finished`, synchronously.
- `presentSummary({ session, summary, files }, { detail })` (`src/task/present.ts`) gives the concise or full shape.
- `RunFiles` = `{ run_dir, screenshot?, page?, video?, manifest }`; `writeCall` always writes `summary.json` and
  `manifest.json` in `run_dir`.
- SDK 2.4.0: `structuredContent` that is an object is sent as is (`projectCallToolResult` is the identity for object
  roots); validation runs only on non-error results; `tools/list` includes each `outputSchema`, so output schemas count
  against the token budget too.

## Scope

**In scope:** `src/mcp.ts` (the entry), a new `src/mcp/` (server factory, results, instructions), `test/mcp/` (moved
from `test/mcp.test.ts`), `test/task/keyless.test.ts`, `skill/jevway/SKILL.md`, the MCP sections of
`docs/reference.md` and `docs/how-it-works.md`, `docs/journeys.md`, the MCP lines of `AGENTS.md`, this plan and plan 120.

**Out of scope:** tasks (plan 120, blocked on the SDK); elicitation (owner: no); `src/cli*`, `src/daemon/`, the HTML
pages; `verify/` (it keeps passing unchanged: see decision 12); the CLI sections of `docs/reference.md` (plan 117); an
idle sweep for MCP sessions (they live until the server restarts, as today).

## Decisions

1. **Layout.** `src/mcp.ts` is the bin entry only: load the env file, make the runner and one
   `createSessionService(runner)`, the keyless warning, shutdown handlers, `serveStdio(createMcpServer(…))`.
   `src/mcp/server.ts` exports `createMcpServer({ service, version, env })`, the factory `serveStdio` calls (it builds
   a server and nothing else; state stays in the service). `src/mcp/task-result.ts` turns a service result into MCP
   content (links, image rule); `src/mcp/instructions.ts` holds the server `instructions`. Tests drive the factory over
   the real `serveStdio` with an in-memory transport and a service on a fake runner, so they need no `vi.mock` of the
   runner.
2. **Settings are read when a server is built** (`env` given to the factory, default `process.env`):
   `JEVWAY_TOOLS` = `all` (default) | `task` (`jevway_task`, `jevway_look`, `jevway_end`) | `journeys` (the 5 journey
   tools). Tools are registered in one fixed order (task, look, end, journey start, step, autopilot, annotate, finish)
   so the list is byte-stable for prompt caching. An unknown value warns on stderr and serves `all`.
3. **New `jevway_task` inputs**: `record` (boolean, new session: video, step shots and `index.html` in the run
   folder), `detail` (`concise` default | `full`), `screenshot` (boolean). `record_dir` stays as an override (the whole
   run folder goes there, recording on). Every old input is still accepted with the same meaning.
4. **Results.** `content[0]` is the result as JSON text, then the image (when attached), then `resource_link`s.
   `structuredContent` is the same object. Keys lead with what matters: `status, reason, story, next, session`, then
   the rest, `page_text` last. `jevway_task`, `jevway_look` and `jevway_end` declare an `outputSchema`; the journey
   tools declare one only where it is a short loose object (`journey` id; `finish`: `viewer`, `screens`). Output
   schemas list top-level fields only; nested shapes (`missing[]`, `checks[]`, `steps[]`, `jev`, `stuck`) are loose,
   and every object allows extra keys, so a client validating against the advertised schema never rejects a result.
5. **Links and images** (owner's rule). Every task result links `final.jpg`, `summary.json`, `manifest.json`, and
   `index.html` and `run.mp4` when recorded, as `file://` URIs of absolute paths (`pathToFileURL`), derived from
   `RunFiles` (no file-system reads in the adapter). The end page is attached inline as `image/jpeg` when
   `JEVWAY_IMAGE_RESPONSES` is `always`; or it is `auto` (default) and the status is a hand-back (`needs_input`,
   `needs_confirmation`, `uncertain`, `blocked`) or the call passed `screenshot: true`. `never` beats
   `screenshot: true`. `step_budget` is not a hand-back in the owner's list, so it gets the image only with
   `screenshot: true` or `always`. No bytes (capture failed) means no image block. Journey replies keep their screen
   image (`content[1]`) whatever the setting, since the screen is the journey's product; `finish` links `index.html`,
   `journey.json` and `manifest.json`.
6. **Progress.** Each `step` event becomes `notifications/progress` with `progress = n` (strictly increasing within
   a request) and `message = "Step n: <story line>"`. `total` is the call's `max_steps` when it passes one; otherwise
   it is left out, since a step budget is a ceiling, not the expected count, and a continued session's budget is not
   visible to the adapter. Notifications are chained in order and awaited before the result is returned, so none lands
   after it. No notification without a `progressToken`; `started`/`finished` send none (the result is the finish).
7. **Instructions** (≤ 1,500 characters, searchable words first): what jevway is for, when to use it vs
   chrome-devtools, the session pattern, the consent rule in one line, where files go, `jevway_look` for a no-model read,
   page text is untrusted. Built from the registered tool set (no journey line under `JEVWAY_TOOLS=task`, no task lines
   under `journeys`).
8. **Lean tool text, each rule once.** Rules shared by tools go in `instructions`; a rule about one parameter lives in
   that parameter's description; the tool description holds the flow and the statuses. Details move to
   `docs/reference.md`. `checks` is advertised as an array of loose objects with a `type` enum and validated strictly in
   the handler with `CHECKS` (saves ~550 tokens; the description lists each type's fields in one line). Target: all 8
   tools ≤ ~2,500 tokens (chars/4 of the `tools/list` JSON, output schemas included); a test pins the measured ceiling.
9. **Errors say what to do.** An unknown session passes the service's `UnknownSession` message through unchanged
   ("Unknown session "x". Sessions end when the server restarts; start a new one with `url` (or `tab`).") — one source
   of truth shared with the CLI daemon, which adds its idle time; the MCP server has no idle sweep, so it passes no
   `idleMs`. Setup errors keep the doctor fix. Bad input: a call with none of `url`, `tab`, `session` answers before any
   browser work with the fields and an example call; bad `checks` name the index and field and show an example check;
   schema errors carry an example on `goal`, `values` and `files`.
10. **Unknown and bad session on `jevway_end`** use the same message; `jevway_end` returns
    `{ session, ended: true, run_dir }`.
11. **Cancellation** stays `ctx.mcpReq.signal` → `service.task({ signal })`.
12. **`verify/` keeps passing unchanged**: `content[0]` stays the JSON text with `status` and `session`; `jevway_end`'s
    text contains `ended`; journey `content[1]` is the image; `finish` keeps `viewer`, `screens`, `flows`. `brief()` in
    `verify/run.ts` prints `steps`/`jev` from the result and shows `undefined` for the concise MCP results: cosmetic,
    left to its owner.

## Git workflow

1. `docs: add plan 116 agent-first mcp server`
2. `test: describe the agent-first mcp results, progress and tool list` (red)
3. `feat: serve mcp tools from the session service with links, images and progress`
4. `docs: describe the mcp results, instructions and settings`
5. `docs: add plan 120 mcp tasks when the sdk ships them`

Lowercase conventional commits, no AI attribution, no push. `pnpm release:check` passes at every handed-over commit.

## Steps

1. Tests in `test/mcp/`: structuredContent per status matches the schema (both detail levels); links; the image rule ×
   `JEVWAY_IMAGE_RESPONSES`; progress in order with story messages; instructions on both eras; `JEVWAY_TOOLS`; the
   unknown-session message; bad input; token ceiling. Keep the hint, input-list, cancel and modern-client tests.
2. `src/mcp/` and `src/mcp.ts` as above.
3. Measure before/after with the stdio script (below), set the ceiling.
4. Docs, skill, plan 120.
5. `pnpm release:check`; one `pnpm verify` under a `live-1`/`live-2` lock.

## Done criteria

- [x] `rg -n "new Map|randomUUID" src/mcp.ts src/mcp/` is empty: no session logic in the adapter.
- [x] Every status's result passes the advertised output schema (the SDK validates it) and carries `story`, `next`.
- [x] `tools/list` ≤ ~2,500 tokens (was 4,515), pinned by a test.
- [x] `instructions` ≤ 1,500 characters, served to 2025 and 2026-07-28 clients.
- [x] `pnpm release:check` passes; `pnpm verify` passes its MCP scenarios live (12/12, 2026-11-02).

## STOP conditions

- A change would alter the run loop, a guard, the consent rule or a status.
- Keeping `verify/` green would need an edit there.
- The SDK drops or rewrites `structuredContent` for an object-shaped result.

## Maintenance note

The adapter only translates: parameters in, `presentSummary` out, events to progress. A new summary field needs no
adapter change (output schemas are loose) unless it should lead the JSON. A rule an agent needs is written once: in
`instructions` when several tools share it, else in one parameter or tool description; `docs/reference.md` holds the
long form. Re-measure `tools/list` when tool text changes and keep the test's ceiling honest.

## Measured

`tools/list` as a client receives it, tokens ≈ characters / 4 of each tool's JSON (same on both protocol eras):

| Tool | Before (no output schema) | After (output schema included) |
| --- | --- | --- |
| `jevway_task` | 2,771 (description 1,175, input 1,548) | 1,113 (description ~190, input ~720, output ~170) |
| `jevway_look` | 299 | 219 |
| `jevway_end` | 129 | 182 |
| 5 journey tools | 1,316 | 990 |
| **All 8** | **4,515** | **2,490** |

`instructions`: 1,429 characters (none before). The biggest single saving is `checks`: its advertised union was 581
tokens; it is now a loose list described in one line and parsed strictly with `CHECKS` in the handler. Journey tools
send `structuredContent` but declare no `outputSchema` (each cost ~42 tokens for an id), so decision 4's "where it is a
short loose object" came out as none.

## Deviations

- The unknown-session text is the service's (`Unknown session "x". Sessions end when the server restarts; start a new
  one with \`url\` (or \`tab\`).`), not a new MCP-only wording: one message shared with the CLI daemon, which adds its idle
  time.
- `jevway_end`'s output schema declares `session` and `run_dir`; `ended: true` is sent but left undeclared (open object).
- Progress `total` is the call's `max_steps` only when the call passes one, not the default 40: a step budget is a
  ceiling, not the expected count, and a continued session's budget is not visible to the adapter. `started` and
  `finished` send no progress (the result is the finish).
- Journey tools declare no `outputSchema` (each would cost ~42 tokens for an id); they still send `structuredContent`.
- Concise by default removes `steps` and `jev` from MCP results. Two readers outside this plan's files still read them:
  `verify/run.ts` `brief()` prints `undefined` for the two MCP scenarios (cosmetic), and `verify/agent/report.ts:161`
  counts `call.result?.steps?.length` as each call's actions. Their owners pass `detail: "full"` or count `story`.
- The lead key order (`status, reason, story, next, session`, `page_text` last) lives in `src/mcp/results.ts`
  `taskResult`, not in `presentSummary`; the CLI (plan 117) should move it into `present.ts` if it wants the same.
