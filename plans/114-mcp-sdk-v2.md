# Plan 114: jevway runs on MCP SDK v2

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
> Never push, never `npm publish`. Other executors own `src/task/`, `src/recording/`, `src/journeys/`, `src/session/`
> and `src/setup/` this round: don't touch them.
>
> **Drift check (run first)**:
> - `package.json` depends on `@modelcontextprotocol/sdk` 1.x and nothing else from `@modelcontextprotocol/`.
> - `src/mcp.ts` ends with `await server.connect(new StdioServerTransport());` and registers exactly 8 `jevway_*` tools.
> - `rg -l "@modelcontextprotocol" src test verify` lists only `src/mcp.ts`, `test/mcp.test.ts`,
>   `test/task/keyless.test.ts`, `verify/run.ts` and `verify/journeys.ts`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MEDIUM (every MCP client goes through the new entry; no tool changes)
  · **Category**: dependencies
- **Planned at**: commit `e755f59`, 2026-11-02

## Why this matters

The owner decided this round moves to SDK v2 and protocol 2026-07-28 (round 13 brief). Phase 2 (plan 116: tasks,
`outputSchema`, `instructions`, progress, resource links) builds on it, so this plan swaps the foundation with no
feature change and writes down how each phase-2 feature is done in v2, checked against the installed 2.4.0 source.

Evidence, from the installed packages and the docs:
- `@modelcontextprotocol/sdk` is replaced by `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0
  (`npm view`); the v2 README says it implements the 2026-07-28 spec.
- The migration guide: "a server that still calls `server.connect(new StdioServerTransport())` serves only 2025-era
  clients"; to serve both, use `serveStdio(() => createServer())`.
- `node_modules/@modelcontextprotocol/server/dist/stdio.mjs` (`serveStdio`): the opening message picks the era. An
  `initialize` without a modern `_meta` claim, or any claim-less message, pins a 2025-era instance from the factory
  (`legacy: 'serve'` is the default); a `server/discover` or a request with a valid
  `io.modelcontextprotocol/protocolVersion` claim pins a modern one. A discover probe instance is discarded when the
  client falls back to `initialize`, so the factory can run twice on one connection.
- `SUPPORTED_PROTOCOL_VERSIONS` (legacy handshake) is `2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07`;
  the modern list is `2026-07-28`. So Codex, Cursor, OpenCode and older Claude Code keep working: no STOP.
- `Client` defaults to `versionNegotiation: 'legacy'` (plain `initialize`); `{ mode: { pin: '2026-07-28' } }` or
  `'auto'` speaks the new protocol.

## Current state

- `src/mcp.ts` builds one module-level `McpServer`, registers 8 tools with raw-shape `inputSchema`s, reads the
  cancel signal as the handler's second argument (`{ signal }`), and connects with `server.connect(new
  StdioServerTransport())`.
- `test/mcp.test.ts` and `test/task/keyless.test.ts` mock `@modelcontextprotocol/sdk/server/stdio.js` so the class
  returns an in-memory transport, then use the v1 `Client`.
- `verify/run.ts` (two MCP scenarios) and `verify/journeys.ts` (one) spawn `src/mcp.ts` with `StdioClientTransport`;
  `callTool(params, undefined, { signal })` uses the v1 three-argument form.

## Scope

**In scope:** `package.json` dependencies, `pnpm-lock.yaml`, `src/mcp.ts` (SDK API only), `test/mcp.test.ts`,
`test/task/keyless.test.ts`, `verify/run.ts`, `verify/journeys.ts`, the one AGENTS.md invariant line about the MCP
entry.

**Out of scope:** any tool, input, result or annotation change; `outputSchema`, `instructions`, progress, tasks and
resource links (plan 116); `src/task/` and the other executors' folders; README.

## Decisions

1. **Packages.** `@modelcontextprotocol/server@^2.4.0` replaces `@modelcontextprotocol/sdk` in `dependencies`.
   `@modelcontextprotocol/client@^2.4.0` goes in `devDependencies`: only tests and `verify/` use a client, and the
   published package must not pull it in. `zod` 4.6 already meets v2's `^4.2.0`.
2. **Entry: `serveStdio(createServer)`.** The `McpServer` construction and the 8 `registerTool` calls move into a
   `createServer()` factory, unchanged in content. The runner, the `sessions` and `journeys` maps, the env-file load,
   the keyless warning and the shutdown handlers stay at module level: the factory may run twice per connection (probe
   then legacy), so it builds a server and nothing else, and both instances see the same sessions. Errors serveStdio
   reports out of band go to stderr (`jevway-mcp: …`), never stdout.
3. **API renames only.** `{ signal }` becomes `ctx.mcpReq.signal`. Each `inputSchema` is wrapped in `z.object({…})`
   (the raw-shape overload is deprecated; v1 wrapped it the same way, so validation is unchanged). Results keep their
   exact shape.
4. **What clients see change** (protocol, not features): a 2026-07-28 client gets `_meta.io.modelcontextprotocol/
   serverInfo` on results and `resultType`, `ttlMs`, `cacheScope` on lists, all added by the SDK; the advertised JSON
   Schema of each input may differ in idiom (2020-12, `additionalProperties`). Names, descriptions, annotations and the
   fields a tool accepts are the same; the tests pin that.
5. **Tests drive the server through the real era router.** The test mocks `@modelcontextprotocol/server/stdio` so the
   module's own `serveStdio` call only captures the factory (it must not read vitest's stdin); each test client then
   gets a fresh connection from the real `serveStdio(factory, { transport })` over an `InMemoryTransport` pair (both
   halves from `@modelcontextprotocol/client`). So one test file can open a legacy and a modern connection.
6. **Backward compatibility is tested on the real binary.** `test/task/keyless.test.ts` spawns `node src/mcp.ts` with no
   key and an empty config folder, writes a raw JSON-RPC `initialize` at `2025-06-18`, `notifications/initialized`,
   `tools/list` and one `tools/call`, and reads stdout lines. It also connects a v2 `Client` with
   `versionNegotiation: { mode: 'auto' }` over `StdioClientTransport` to the same binary, which must pick 2026-07-28.
7. **`verify/`** keeps the default (legacy) client on the cancel and journeys scenarios, so they still check what most
   clients speak today; the "tools list + jevway_task + jevway_end" scenario uses `mode: 'auto'`, so the live suite
   also proves the modern era over real stdio.

## v2 cookbook for plan 116 (checked with a probe script against 2.4.0, both eras)

- Imports: `import { McpServer } from '@modelcontextprotocol/server'`, `import { serveStdio } from
  '@modelcontextprotocol/server/stdio'`.
- `outputSchema` + `structuredContent`: `registerTool(name, { inputSchema: z.object(…), outputSchema: z.object(…) },
  handler)`; return `{ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }`. Works on both
  eras.
- `instructions`: `new McpServer(info, { instructions })`. A 2025 client reads it from `initialize`, a 2026 client from
  `server/discover` (`client.getInstructions()` returns it in both).
- Progress: no helper. `const token = ctx.mcpReq._meta?.progressToken; if (token !== undefined) await
  ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } })`.
  Delivered on a plain (non-task) `tools/call` in both eras (client: `callTool(p, { onprogress })`). `progress` must
  increase.
- Resource links: a content block `{ type: 'resource_link', uri, name, mimeType?, description? }`; passes both eras.
- Cancellation: `ctx.mcpReq.signal` (aborted on `notifications/cancelled` and when the transport closes).
- Errors: return `{ isError: true, content: [...] }`; a thrown handler error also becomes an `isError` result.
- Tasks (`io.modelcontextprotocol/tasks`, SEP-2663): **SDK 2.4.0 does not implement them.** The SDK roadmap lists it as
  an open extension (typescript-sdk#2189), its conformance baseline marks every tasks scenario as an expected failure,
  v2 removed the 2025-11 experimental tasks, and the official client matrix lists no client with Tasks support.
  Hand-rolling is possible but unsupported: advertise `new McpServer(info, { capabilities: { extensions:
  { 'io.modelcontextprotocol/tasks': {} } } })`; read the client's opt-in from
  `ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities']?.extensions` (2026 era only); a tool handler
  may return `{ resultType: 'task', content: [], task: { taskId, status, ttlMs, pollIntervalMs } }` (the server sends
  it as is; without `content` the SDK rejects it, and the v2 `Client` itself throws "Unsupported result type 'task'");
  serve `tasks/get`, `tasks/cancel` and `tasks/update` with the 3-argument `server.server.setRequestHandler('tasks/get',
  { params: zodSchema, result: zodSchema }, handler)` (a `statusMessage` field passes through; the SDK stamps
  `resultType: 'complete'` on that result in the 2026 era). Recommendation: progress notifications now, tasks when the
  SDK ships them.

## Git workflow

1. `docs: add plan 114 mcp sdk v2`
2. `test: serve legacy and 2026-07-28 mcp clients` (red: the server does not use the v2 entry)
3. `build: move to mcp sdk v2 and serve both protocol eras`

Lowercase conventional commits, no AI attribution, no push.

## Steps

1. Swap the dependencies (`pnpm remove @modelcontextprotocol/sdk`, `pnpm add @modelcontextprotocol/server@^2.4.0`,
   `pnpm add -D @modelcontextprotocol/client@^2.4.0`).
2. Rewrite the two test files' harness (decision 5), add the modern-client test in `test/mcp.test.ts` and the two
   real-binary tests in `test/task/keyless.test.ts`; see them fail against the v1 entry.
3. `src/mcp.ts`: imports, factory, `serveStdio`, `ctx.mcpReq.signal`, `z.object` wrappers.
4. `verify/run.ts`, `verify/journeys.ts`: v2 imports and `callTool(params, { signal })`; `mode: 'auto'` on one scenario.
5. `pnpm typecheck && pnpm test`, `pnpm release:check`; then one `pnpm verify` under a `live-1`/`live-2` lock.

## Done criteria

- [ ] A raw 2025-06-18 `initialize` on the real `src/mcp.ts` answers `protocolVersion: "2025-06-18"`, lists the 8 tools,
      and a `tools/call` answers (keyless: `isError` with the fix).
- [ ] A v2 client pinned to 2026-07-28 (in memory) and one on `auto` over real stdio negotiate `2026-07-28`, list the 8
      tools with the same annotations and call one.
- [ ] `test/mcp.test.ts` (annotations, cancel ordering) and `test/task/keyless.test.ts` pass.
- [ ] `verify/run.ts` and `verify/journeys.ts` typecheck; `pnpm verify` passes its MCP scenarios live.
- [ ] `pnpm release:check` passes; `package.json` `files` and `bin` unchanged; `.claude-plugin/plugin.json` still runs
      `npx -y -p jevway jevway-mcp`.
- [ ] `rg "@modelcontextprotocol/sdk" src test verify package.json` finds nothing.

## STOP conditions

- v2 cannot answer an `initialize` at 2025-06-18 or 2025-11-25 (a server only new clients can use).
- A tool's name, inputs, annotations or result would have to change to make the move.
- The move needs an edit inside `src/task/` or another executor's folder.

## Maintenance note

v2 is split per role: server code imports `@modelcontextprotocol/server`, tests and `verify/` import
`@modelcontextprotocol/client`; keep the client a dev dependency. Both packages bundle their own copy of shared
classes, so an `InMemoryTransport` pair must come from one package. When the SDK ships the tasks extension, replace any
hand-rolled `tasks/*` handlers with it.
