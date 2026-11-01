# Plan 093: The MCP tools carry destructive and open-world hints

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/mcp.ts` registers `browser_task`, `browser_task_end` and `journey_{start,step,autopilot,annotate,finish}` with
>   `server.registerTool(name, { title, description, inputSchema }, handler)` and no `annotations`.
> - `node_modules/@modelcontextprotocol/sdk/package.json` is 1.30.x and its `registerTool` config accepts
>   `annotations?: ToolAnnotations` (`dist/esm/server/mcp.d.ts`).
>
> Otherwise STOP.

## Status

- **Priority**: P3 · **Effort**: XS · **Risk**: LOW (metadata only; no behaviour changes) · **Category**: agent-facing (prior-art K7)
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

MCP clients use tool annotations to decide when to ask the user before a call and how to describe a tool. jiawei686
(`jev_ultrafast_mcp/server.py:95-103`, `docs/prior-art.md` K7) marks its browser tool destructive and open-world. Ours
carry none (`src/mcp.ts`), so a client treats `browser_task`, which can delete a repository after a confirmation, the
same as `browser_task_end`, which only forgets a session.

## Current state

Seven `server.registerTool` calls in `src/mcp.ts`, none with `annotations`. SDK 1.30.0's `ToolAnnotations` has
`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (`dist/esm/types.d.ts:2363-2366`).

## Design decisions

| Tool | readOnly | destructive | idempotent | openWorld | Why |
| --- | --- | --- | --- | --- | --- |
| `browser_task` | false | true | false | true | drives any website; can submit, pay or delete after a confirmation |
| `browser_task_end` | false | false | true | false | forgets a session, closes the tab jev-browse opened; ending twice changes nothing more |
| `journey_start` | false | false | false | true | opens a new tab on any URL; changes no site state |
| `journey_step` | false | true | false | true | taps what the caller names, including a submit, on any site |
| `journey_autopilot` | false | false | false | true | Jev taps on the site, but skips irreversible taps and stops at auth and payment |
| `journey_annotate` | false | false | true | false | edits the local journey record only |
| `journey_finish` | false | false | true | false | writes local files and closes the tab |

`journey_autopilot` is not destructive by its own rule (it skips irreversible taps); `journey_step` is, because it
taps whatever the caller names.

## Scope

**In:** `src/mcp.ts` (an `annotations` object per tool, nothing else), `test/mcp.test.ts` (new).
**Out:** tool names, descriptions, schemas, handlers.

## Git workflow

1. `docs: add plan 093 mcp tools carry hints`
2. `test: tools/list returns each tool's hints`
3. `feat: annotate the mcp tools with destructive and open-world hints`

No AI attribution. Do NOT push.

## Steps

1. **Test first:** `test/mcp.test.ts` starts `src/mcp.ts` over stdio with the SDK's `Client` and
   `StdioClientTransport` (Chrome is connected lazily, so no browser starts), calls `listTools()` and expects the
   table above. Red.
2. **Implement:** add the annotations. `pnpm typecheck` and `pnpm test` pass.

## Done criteria

- [ ] `tools/list` returns the table above; test red first
- [ ] `git diff --stat main` lists only `src/mcp.ts`, `test/mcp.test.ts` and this plan

## STOP conditions

- Starting `src/mcp.ts` in the test launches or connects a browser, or needs a real key.

## Maintenance note

A new tool gets annotations when it is added; the test lists every tool, so a missing one fails it.
