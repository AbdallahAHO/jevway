# Plan 108: The product is named jevway

> **Executor instructions**: Follow this plan step by step. The reviewer renames the GitHub repository; the repo folder
> and the git remote stay as they are.
>
> **Drift check (run first)**:
> - `package.json` must have `"name": "jev-browse"` and the bins `jev-browse` and `jev-browse-mcp`.
> - `src/mcp.ts` must have `new McpServer({ name: 'jev-browse', version: '0.1.0' })` and register `browser_task`,
>   `browser_task_end` and `browser_look`.
> - `verify/jobs/runner.ts` must build its knobs with `` `JEV_${name.toUpperCase()}_${suffix}` ``.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (names only; no request, decision, guard or status changes) ·
  **Category**: naming
- **Planned at**: commit `bde396d`, 2026-11-01

## Why this matters

The product gets its own name before it is published to npm (prior art [D1](../docs/prior-art.md#d1): one-liners like
`npx -y <package>-mcp`). "jev-browse" sits one letter away from four other projects that put Jev behind a browser
(`jkudish/jev-browser`, `Ying-Kai-Liao/jev-browser`, `MaciejWiatr/jev-browser`, `wy-coliney/jev-browser-use`, listed in
`docs/prior-art.md`), and its MCP tools are named `browser_*`, the same prefix most browser MCP servers use, so a client
with two of them loaded shows two `browser_task`-like tools side by side. One name, `jevway`, is used for the package,
the commands, the server, its tools, its environment and its skill.

## Decisions (made by the user; final)

- **No aliases, no fallbacks.** The old tool names and the old `JEV_*` variables stop working on this commit. Nothing
  is published yet, so no caller depends on them.
- The model keeps its name: "Jev", "TypeSafe Jev", model ids like `jev-1.14.0` and `typesafe/jev-1.14`, and code names
  like `jevVerify` or `__jevFast` are not the product and do not change. Neither do the vendor keys
  `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY`.
- The journey tools (`journey_start`, `journey_step`, `journey_autopilot`, `journey_annotate`, `journey_finish`) keep
  their names: the mapping below covers the three task tools only.
- History stays as written: old `plans/NNN-*.md`, `plans/LOG.md` and the round history in `plans/README.md` keep the
  names they were written with. So do saved reports under `verify/out/`; the report renderer still reads their old
  suite titles ("… jobs with jev-browse").
- Names of other projects that contain "jev-browser" (prior art) are theirs and stay.

## Mapping

| What | Old | New |
| --- | --- | --- |
| npm package | `jev-browse` | `jevway` (0.1.0, unscoped; `repository` `github:AbdallahAHO/jevway`) |
| CLI command | `jev-browse` | `jevway` |
| MCP server command | `jev-browse-mcp` | `jevway-mcp` |
| MCP server name | `jev-browse` | `jevway` |
| Tool | `browser_task` | `jevway_task` |
| Tool | `browser_look` | `jevway_look` |
| Tool | `browser_task_end` | `jevway_end` |
| Claude Code tool ids (`verify:agent`) | `mcp__jev-browse__browser_task`, … | `mcp__jevway__jevway_task`, … |
| Environment | `JEV_*` (e.g. `JEV_BROWSER`, `JEV_MODEL`, `JEV_ALLOWED_HOSTS`, `JEV_FORGEJO_RUNS`) | `JEVWAY_*` (`JEVWAY_BROWSER`, `JEVWAY_MODEL`, `JEVWAY_ALLOWED_HOSTS`, `JEVWAY_FORGEJO_RUNS`) |
| Suite knobs built by `verify/jobs/runner.ts` | `JEV_<NAME>_RUNS`, `_ONLY`, `_DEVICE`, `_PHRASING` | `JEVWAY_<NAME>_…` |
| Skill | `skill/jev-browse/`, `name: jev-browse` | `skill/jevway/`, `name: jevway` |
| Docker compose projects | `jev-forgejo`, `jev-vikunja` | `jevway-forgejo`, `jevway-vikunja` |
| Prose, CLI help, report and recording titles, MCP client names, temp-dir and profile prefixes, frame world names | jev-browse | jevway |

## Current state

- `package.json`: `name`, `bin` and the four `apps:*` scripts (`docker compose -p jev-forgejo|jev-vikunja`).
- `src/mcp.ts`: server name, the three tool names and descriptions that name each other; `src/cli.ts`: usage and
  error prefixes.
- Environment: `process.env.JEV_*` across `src/` and `verify/`, plus the built key in `verify/jobs/runner.ts:124`.
- `verify/agent.ts`: the generated MCP config (server `jev-browse`, env `JEV_BROWSER`, `JEV_AGENT_MCP_STDERR` inside an
  `sh -c` string), `--allowedTools`/`--disallowedTools` ids and the init check on the server's name.
- `verify/jobs/report.ts:218` parses suite titles ending "with jev-browse"; `verify/jobs/rerender.ts` re-renders saved
  folders whose titles keep that wording.
- `skill/jev-browse/SKILL.md`; `verify/apps/*/compose.yml` (`name:`) and `verify/apps/forgejo/seed.ts:26` (`-p`).

## Scope

**In scope:** every live mention in `src/`, `test/`, `verify/` (outside `verify/out/`), `skill/`, `package.json`,
`README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/verification.md`, and `docs/prior-art.md` where it means our product.

**Out of scope:**
- `verify/vikunja.ts` beyond its env-var names and product text: never its jobs or checks.
- Seed data (`jev-admin`, `@jev.test`, the Vikunja JWT secret): test accounts, not the product name.
- `test/jev-browse.test.ts` keeps its file name: other branches edit it at the same time, and a rename would conflict
  with each of them. Its content changes.
- The repo folder, the git remote, the GitHub repository.
- Any live suite: names only, so `pnpm typecheck`, `pnpm test`, `pnpm build` and an offline `tools/list` are the check.

Never read `.env`.

## Git workflow

Branch `wt/exec-rename`. Commits (each passes `pnpm typecheck` and `pnpm test`):
1. `docs: add plan 108 the product is named jevway`
2. `refactor: name the package, commands and mcp server jevway`
3. `refactor: rename the mcp tools to jevway_task, jevway_look and jevway_end`
4. `refactor: rename every JEV_ environment variable to JEVWAY_`
5. `refactor: rename the skill and compose projects to jevway`
6. `docs: describe jevway in the readme, agents guide and docs`

Lowercase conventional commits. **No AI attribution of any kind.** Do NOT push. Do NOT merge into `main`.

## Steps

1. **Package and server.** `package.json` name, bins, `repository`. The server name in `src/mcp.ts`, the CLI usage and
   error prefixes, the MCP client names in `verify/run.ts`, report and recording titles, the suite titles
   ("… jobs with jevway") with the report's title parser accepting both the new and the old ending, temp-dir and
   profile prefixes, the frame world names in `src/browser/frames.ts`, code comments, and reason texts with the tests
   that assert them. `verify/agent.ts`: server name in the MCP config, the tool ids' server part, the init check.
2. **Tools.** Register `jevway_task`, `jevway_look`, `jevway_end`; every description, error prefix and comment that
   names one; `test/mcp.test.ts`; `verify/run.ts` scenarios; `verify/agent.ts` ids; the skill's text.
3. **Environment.** Every `JEV_` variable to `JEVWAY_`, the built knob key, the `sh -c` string and its `env` object in
   `verify/agent.ts` together, tests, and the skill's text.
4. **Skill and compose.** `git mv skill/jev-browse skill/jevway`, frontmatter `name: jevway`; compose `name:`, the
   `apps:*` scripts and `seed.ts`'s `-p`.
5. **Docs.** README (title, one "formerly jev-browse" line), AGENTS.md, CLAUDE.md's title, `docs/verification.md`,
   `docs/prior-art.md` where it means our product.
6. **Check.** `pnpm build`; `node dist/mcp.js` over stdio, `initialize` + `tools/list`; `node dist/cli.js --help`;
   `npm pack --dry-run`; the residual grep below.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` exit 0 on every commit (build at the end)
- [ ] `tools/list` lists `jevway_task`, `jevway_look`, `jevway_end` (and the five journey tools), no `browser_*`
- [ ] `node dist/cli.js --help` says jevway; `npm pack --dry-run` shows `jevway@0.1.0` with `skill/jevway/SKILL.md`
- [ ] `rg -n "jev-browse|browser_task|browser_look|JEV_" -g '!plans/**' -g '!verify/out/**'` returns only: the
  README's "formerly jev-browse" line, the report parser's old-title alternative, and other projects' names containing
  "jev-browser"

## STOP conditions

- A rename would change a job, a check or a judge in `verify/vikunja.ts`.
- A test needs a behaviour change (not a name change) to pass.

## Maintenance note

A user's shell exports, `.env` and MCP client configs written for `JEV_*` and `browser_*` are silently ignored after
this lands; the README's setup lines are the reference. Old reports re-render with their saved titles, which still say
jev-browse.
