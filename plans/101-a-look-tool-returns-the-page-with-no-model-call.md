# Plan 101: A look tool returns the page with no model call

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/browser/tab.ts` has `async observe(): Promise<PageState>`, `static async open(cdp, url, …)` and
>   `static async find(cdp, urlPart)`.
> - Plan 099 is in: `src/task/checks.ts` exports `listedElements(page)`.
> - `src/mcp.ts` keeps `sessions: Map<string, { task: BrowserTask; ownsTab: boolean }>`.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (read-only; no Jev request; no input to the page) · **Category**: caller contract
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

After a hand-back, or before deciding the next call, the calling agent often only needs to see the page again: what
it shows now, which controls are listed, whether a field kept its value. Today the page only comes back at the end of
a `browser_task`, which costs Jev requests and may act, and `verify:agent` gives the agent no other way to look
(`docs/prior-art.md` K6: "page text only comes back at the end of a `browser_task`"). jiawei686 has a read-only look
(`jev_ultrafast_mcp/server.py:246`, `:264`). The reader already does all the work: `tab.observe()`
(`src/browser/tab.ts:337`) returns the URL, title, visible text, listed controls and password fields as filled/empty.

## Current state

- `src/mcp.ts` registers `browser_task`, `browser_task_end` and the journey tools; none returns the page without a
  model call.
- `src/task/start-task.ts` `createRunner` opens (`Tab.open`) or finds (`Tab.find`) a tab only inside `start()`.
- `TaskSummary.page_text` is cut at 2500 characters with a marker (`pageTextFor`, `src/task/run-task.ts`).

## Design decisions (made here, before code)

1. **Tool `browser_look`**, one of `session` (that session's tab), `tab` (an open tab whose URL contains this text) or
   `url` (a new background tab, read, then closed again: a look leaves nothing open and starts no session).
2. **Returns** `{url, title, page_text, elements, elements_not_listed?, password_fields?}`:
   - `page_text`: the same cut and marker as `browser_task`'s, so both read alike;
   - `elements`: the listed controls once per control (`listedElements` from plan 099): `label`, `role`, and
     `value`, `checked`, `selected`, `expanded` when present. No node ids, action ids or rects: nothing the caller could
     act on, and nothing that could be passed back as a target;
   - `elements_not_listed`: the reader's `omitted_actions` count, when over 0;
   - `password_fields`: `{name, filled}` only, as the reader gives them. A password's value is never read.
3. **No Jev call, no input.** Only `observe()`: no click, scroll or key. A `url` look loads that URL, which is the only
   outside effect.
4. **Annotations** on this tool only: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
   `openWorldHint: true` (a `url` loads any site). `browser_task`'s annotations are round A's K7, not this plan's.
5. **Not added to `verify/agent.ts`'s allowed tools**: that would change gate R4's conditions. Follow-up.

## Scope

**In scope:** `src/task/look.ts` (new, the pure `PageState` → look mapping), `src/task/start-task.ts` (an additive
`look({url, tab})` on the runner), `src/mcp.ts` (the tool), `src/task/run-task.ts` (export `pageTextFor`), tests,
`README.md`, `skill/jev-browse/SKILL.md`, `AGENTS.md`, `verify/run.ts` (the MCP scenario lists and calls it).

**Out of scope:** a CLI `--look`; screenshots; `verify/agent.ts`.

## Git workflow

1. `docs: add plan 101 a look tool returns the page with no model call`
2. `test: a look returns the page without ids or password values`
3. `feat: add browser_look, a read-only look at a page`

Lowercase conventional commits, no AI attribution, no push.

## Steps

### 1. Tests first
`test/look.test.ts`: the look carries url, title, the cut page text, one element per control with its state; no
`node`, `id` or `rect` anywhere in it; password fields filled/empty only; `elements_not_listed` only when the reader
omitted some. `test/jev-browse.test.ts` (runner): a `url` look opens a tab, observes it, closes it, and sends no Jev
request. Red first.

### 2. Implement
`pnpm typecheck`, `pnpm test`.

### 3. Measure
`pnpm verify`: the MCP scenario lists `browser_look` with its read-only annotation, and a look at the session after
`browser_task` returns the fixture's results with no Jev request.

## Done criteria

- [ ] tests red first, then green; typecheck clean
- [ ] `pnpm verify` MCP scenario passes with the look

## STOP conditions

- The look returns an id, selector or rect, or any password value.

## Maintenance note

When the reader learns more (frames, C4), the look shows it too. If agents start polling with it, consider a `since`
form that returns only what changed (agent-browser's `snapshot --delta`).
