# Plan 120: long `jevway_task` calls as MCP tasks, once the SDK ships them

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Never push, never `npm publish`.
>
> **Drift check (run first)**:
> - `typescript-sdk#2189` (the `io.modelcontextprotocol/tasks` extension, SEP-2663) is closed as shipped, and the
>   installed `@modelcontextprotocol/server` exports a tasks API (`rg -n "tasks/get" node_modules/@modelcontextprotocol/server/dist/*.d.mts`
>   finds a typed handler or helper, not only the request schema).
> - The SDK's conformance baseline no longer marks the tasks scenarios as expected failures.
> - At least one MCP client the owner cares about (Claude Code, Codex, Cursor, OpenCode) advertises the tasks extension
>   in its client capabilities.
> - `src/mcp/task-tools.ts` still sends `notifications/progress` per step (plan 116).
>
> Any of the first three missing: the plan stays blocked. Otherwise go on.

## Status

- **Status**: planned, **blocked** on the SDK (`typescript-sdk#2189`)
- **Priority**: P2 · **Effort**: M · **Risk**: MEDIUM (a second result path for `jevway_task`; the run loop is
  untouched) · **Category**: agent experience
- **Planned at**: plan 116, 2026-11-02

## Why this matters

A `jevway_task` call runs 10–300 s (`max_seconds`, default 300). Today the client holds one request open for all of it;
plan 116's progress notifications keep Claude Code's idle timeout from firing, but a client that drops the connection,
or one with a hard request timeout, loses the result even though the run finished and its folder holds it. Protocol
2026-07-28 has tasks for this: the call returns a task handle at once, the client polls `tasks/get`, and the result
outlives the request. The owner decided "progress now, tasks later" (round 13 brief).

Evidence (plan 114, checked against SDK 2.4.0): the SDK roadmap lists tasks as an open extension (`#2189`); its
conformance baseline marks every tasks scenario as an expected failure; v2 removed the 2025-11 experimental tasks; the
official client matrix lists no client with tasks support; the v2 `Client` throws "Unsupported result type 'task'".

## Current state (after plan 116)

- `jevway_task` (`src/mcp/task-tools.ts`) awaits `service.task(…)`, sends one `notifications/progress` per step, and
  returns the presented result (JSON text, `structuredContent`, image, `resource_link`s; `src/mcp/results.ts`
  `taskResult`).
- Cancellation is `ctx.mcpReq.signal`, passed to the service; a session's next call waits for a cancelled one.

## The hand-rolled shape (from plan 114's probe; switch to the SDK's API when it exists)

1. **Advertise**: `new McpServer(info, { instructions, capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } })`.
2. **Opt-in per call**: read the client's opt-in from
   `ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities']?.extensions` (2026-07-28 era only). Without it
   (every 2025-era client), keep plan 116's path unchanged.
3. **Start**: the handler starts `service.task(…)` without awaiting it, keeps the promise in a module-level
   `Map<taskId, { promise, status, result?, statusMessage?, controller, expiresAt }>` (outside `createMcpServer`'s
   per-connection servers, like the sessions), and returns
   `{ resultType: 'task', content: [], task: { taskId, status: 'working', ttlMs, pollIntervalMs: 1000 } }`.
   `content: []` is required: the SDK rejects a result without it. `taskId` is a `randomUUID()`.
4. **Status**: each `step` event updates `statusMessage` with the story line (`Step 3: Clicked "Search".`), the same
   text progress carries.
5. **Serve** `tasks/get`, `tasks/cancel` and `tasks/update` with the 3-argument
   `server.server.setRequestHandler('tasks/get', { params: zodSchema, result: zodSchema }, handler)`. `tasks/get` returns
   the status, `statusMessage`, and when finished the exact plan-116 result (`taskResult`), so a tasks client reads the
   same JSON, image and links. In the 2026 era the SDK stamps `resultType: 'complete'` on that result.
6. **Cancel**: `tasks/cancel` aborts the task's own `AbortController` (the service's `signal`), so a cancelled task
   stops before its next step exactly as a cancelled request does today.
7. **Expiry**: a finished task's result is kept for `ttlMs` (say 1 h) after it ends, then dropped; the run folder keeps
   `summary.json` regardless.

## Scope

**In scope:** `src/mcp/task-tools.ts` (the second path), a `src/mcp/tasks.ts` for the task map and the three handlers,
`src/mcp/server.ts` (capability), `test/mcp/`, the MCP section of `docs/reference.md`, `docs/how-it-works.md` 1.1,
`skill/jevway/SKILL.md` (one line: results may arrive through a task handle).

**Out of scope:** tasks for journeys (autopilot can be long too; a follow-up once this one has run in a real client);
elicitation (owner: no); the CLI daemon (it has its own sessions and NDJSON).

## Decisions to make when unblocked

1. Use the SDK's helper instead of steps 3–5 wherever it has one; hand-roll nothing it provides.
2. Whether `jevway_task` returns a task only above an expected duration, or always for a client that opts in (start:
   always; the handle costs one round trip).
3. Whether progress notifications continue alongside the task status (start: no; the status message carries the story).

## Steps

1. Tests first (`test/mcp/tasks.test.ts`): a client that opts in gets a task handle at once; `tasks/get` reports
   `working` with the latest story line, then `completed` with the same result plan 116 returns (schema, image rule,
   links); `tasks/cancel` ends the run `blocked` "Cancelled by the caller" and the session's next call works; a
   2025-era client and a 2026 client that does not opt in still get the direct result.
2. Implement with the SDK's API.
3. Docs and the skill line.
4. `pnpm release:check`; one `pnpm verify` under a `live-1`/`live-2` lock, adding a tasks client to the 2026-07-28
   scenario only if `verify/run.ts`'s owner agrees.

## Done criteria

- [ ] A tasks client's `jevway_task` returns a handle in under 100 ms and its `tasks/get` result equals the direct
      result for the same run.
- [ ] Clients without the extension see no change (plan 116's tests pass unchanged).
- [ ] Cancelling a task stops the run before its next step.
- [ ] `pnpm release:check` passes.

## STOP conditions

- The SDK still lacks typed tasks support: do not ship the hand-rolled shape (unsupported, and the v2 client cannot
  read it).
- Serving tasks would change a result's shape for clients that do not opt in.

## Maintenance note

Delete any hand-rolled `tasks/*` handlers the moment the SDK provides them. The task result must stay byte-identical to
the direct result: one presenter (`taskResult`), two delivery paths.
