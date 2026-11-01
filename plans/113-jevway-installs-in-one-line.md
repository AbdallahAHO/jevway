# Plan 113: jevway is ready to publish and installs in one line

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
> The user publishes to npm and renames the GitHub repository to `AbdallahAHO/jevway`; never run `npm publish`,
> `npm login` or `npm adduser`, and never push.
>
> **Drift check (run first)**:
> - `src/mcp.ts` must have the top-level `const runner = createRunner(process.env.JEVWAY_BROWSER ?? 'auto');`.
> - `src/task/start-task.ts` must call `const ask = createAsk(profile);` inside `createRunner`.
> - `src/cli.ts` must have no subcommand: `parseArgs` without positionals, and usage exit 2 without `--goal`.
> - `package.json` must have `"name": "jevway"`, the bins `jevway` and `jevway-mcp`, and no `prepublishOnly`.
> - `src/browser/chrome.ts` must not export `chromeExecutable`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: LOW (setup paths and docs; the run loop, guards and consent rules are untouched) · **Category**: distribution
- **Planned at**: commit `1401906`, 2026-11-01

## Why this matters

Prior art D1–D5 (`docs/prior-art.md`, "Distribution"):
- **D1:** jkudish (`README.md:38-120`) and wy-coliney (`README.md:17-62`) install in one line per client with
  `npx -y <package>`. Ours needs `pnpm build` and a hand-edited absolute path (`README.md:18-36`, "Once the package is
  published…").
- **D2:** MaciejWiatr (`.claude-plugin/`, `.mcp.json`) and nexibeo (`.claude-plugin/marketplace.json`,
  `mcp/.claude-plugin/plugin.json`) ship a Claude Code plugin, so one install brings the server and the skill. Ours asks
  people to copy `skill/jevway/` by hand.
- **D3:** wingman's `INSTALL-FOR-AGENTS.md:1-90` gives an installing agent rules and checkable outcomes.
- **D4:** wingman's `doctor` tells apart a missing key, no browser and remote debugging not allowed. Ours has nothing:
  a missing key surfaces as the server crashing at start.
- **D5:** "before repeating a write, check whether it already happened" and "continue a session that made progress"
  are missing from `skill/jevway/SKILL.md`.

Our own code:
- `src/mcp.ts:16` runs `createRunner` at module load, and `createRunner` calls `createAsk` (`src/task/start-task.ts:31`),
  which throws `Set OPENROUTER_API_KEY to use jev.` (`src/jev/model.ts:191`) when no key is set. The server exits before
  it answers `initialize`. MCP clients start servers before people add keys, so a fresh install looks broken.
- That message names OpenRouter even though `TYPESAFE_API_KEY` is the preferred route for Jev.
- `jevway_look` needs no model at all (`runner.look` never uses `ask`), yet it dies with the rest.

## Current state

- `package.json`: `name`, `version` 0.1.0, `bin`, `files` (`dist`, `skill`, the licences), `engines` (node ≥ 24),
  `repository: "github:AbdallahAHO/jevway"`. No `keywords`, `homepage`, `bugs`, `author` or `prepublishOnly`.
- `npm pack --dry-run` lists 37 files, `skill/jevway/SKILL.md` among them. tsc keeps the `#!/usr/bin/env node` line in
  `dist/cli.js` and `dist/mcp.js`; they are not executable until npm links them at install.
- `src/browser/chrome.ts`: `autoEndpoint` reads `DevToolsActivePort`; `chromeExecutable` finds Chrome or throws. Both are
  private.
- A Chrome allowed through `chrome://inspect/#remote-debugging` answers `/json/version` with 404 (checked on this
  machine). Only a Chrome started with `--remote-debugging-port` serves it. Any HTTP answer means "listening".

## Scope

**In scope:**
- `package.json` metadata, plus one `prepublishOnly` script and a `chmod +x` at the end of `build`.
- `src/task/start-task.ts`: the decision model's client is made on first use, not in `createRunner`.
- `src/mcp.ts`: loads the env file.
- `src/cli.ts`: the `doctor` subcommand, loading the env file, and the usage text.
- `src/browser/chrome.ts`: exports `findChrome` and `devToolsActivePort` (no change in behaviour).
- New `src/setup/` (`env-file.ts`, `doctor.ts`), new tests.
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
- `INSTALL-FOR-AGENTS.md`, the README install section, `skill/jevway/SKILL.md` (D5), and `AGENTS.md` (commands and
  layout lines).

**Out of scope:**
- `createAsk` and the rest of `src/jev/model.ts` (the replay executor's file).
- D6, the permissions deny list or proxy for other browser servers.
- A `userConfig` key prompt in the plugin (see decision 4).
- Publishing, tagging, pushing.

## Decisions

1. **The MCP server starts without a key.** `createRunner` makes the model client lazily (`ask ??= createAsk(profile)`),
   and `start()` and `startJourney()` ask for it first, before any browser connects. So:
   - `tools/list` works with no key.
   - `jevway_task` and the journey tools answer `isError` with the fix.
   - `jevway_look` works with no key: it never calls a model.
   - No Chrome is launched or attached for a key problem.

   The missing-key message changes for everyone: with no key at all it names `TYPESAFE_API_KEY` first, then
   `OPENROUTER_API_KEY`, where to put them (`~/.config/jevway/env` or the client's env block) and `jevway doctor`. A
   model that needs OpenRouter (clef, pplx-decider, …) keeps naming `OPENROUTER_API_KEY`. The CLI keeps exit 2 for it:
   `runner.requireKey()` runs right after `createRunner`, before any browser starts.
2. **The env file.** At start, `jevway` and `jevway-mcp` read `$XDG_CONFIG_HOME/jevway/env`, or
   `~/.config/jevway/env`, with `util.parseEnv`. They fill only variables that are unset or empty: the process
   environment wins. Only `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `CHROME_PATH` and `JEVWAY_*` are taken. Anything
   else (`NODE_OPTIONS`, `PATH`) is ignored, so the file can't change how Node runs. Some clients (Codex) pass servers
   a filtered environment, but `HOME` survives, so the file works on every client. The key never has to go into a
   chat, a command line or a synced config file. `./.env` stays the pnpm scripts' business.
3. **`jevway doctor`.** A pure `diagnose(probes)` returns findings, and `render` / `planSteps` turn them into text.
   `cli.ts` only dispatches `doctor` before `parseArgs` and wires the real probes. The findings:
   - **Node:** below 24 blocks.
   - **Key and route:** `resolveModel()` in try/catch. No key at all blocks. An unknown `JEVWAY_MODEL` or
     `JEVWAY_SCREENSHOTS` blocks with its own message. Otherwise one line says which key, where it came from
     (environment or the env file) and the route: TypeSafe API direct, or OpenRouter.
   - **Env file:** readable by group or others is a warning (`chmod 600`).
   - **Browser:**
     - `launch` / `launch-headless`: Chrome not found blocks (set `CHROME_PATH`).
     - `auto`: no `DevToolsActivePort` blocks ("not allowed", with the `chrome://inspect/#remote-debugging` hint). A
       file whose port doesn't answer blocks (Chrome closed or debugging turned off).
     - URL: nothing answering at `/json/version` blocks.
     - The probe is one HTTP GET with a 2 s timeout. It never opens the DevTools WebSocket, so the doctor never
       triggers Chrome's "allow" prompt or touches a tab.
   - **ffmpeg:** missing is a warning (recordings get no `run.mp4`).

   Exit 0 when nothing blocks (warnings allowed), 1 otherwise. `--plan` prints the remaining fixes as a numbered list
   (blockers first). `--live` makes one real request, the existing one-Choice `evidenceRequest`, and reports the model
   id and latency. It's off by default and never run in tests. Output never contains a key or any part of it: findings
   carry only variable names, and a live error message has every key value replaced by `[secret]`. The doctor avoids
   APIs newer than Node 21, so it can report an old Node instead of crashing on it.
4. **Plugin: `mcpServers` inline in `.claude-plugin/plugin.json`, not a root `.mcp.json`.**
   - A `.mcp.json` at the repository root is also Claude Code's project MCP config. Every session opened in this repo
     would be offered a server that runs the published package.
   - The command is `npx -y -p jevway jevway-mcp`. `${CLAUDE_PLUGIN_ROOT}/dist/mcp.js` can't work: the plugin installs
     from the git repository, which has no `dist/` and no `node_modules`. So the plugin works once 0.1.0 is on npm.
   - Unpinned, so a release needs no plugin edit. The plugin's `version` equals the package's, and a test keeps them
     equal.
   - The skill is referenced, not copied: `"skills": ["./skill/jevway"]`. `claude --plugin-dir . plugin details jevway`
     lists it.
   - The key comes from the env file or the environment Claude Code passes on. A `userConfig` prompt can't say "one of
     two keys", and how an unset optional value substitutes isn't documented. That's a follow-up.
5. **`package.json` `scripts` is shared with the replay executor.** `prepublishOnly` and the `chmod +x` in `build` are
   the only lines changed there, so expect a one-line merge conflict. `prepublishOnly` runs typecheck, test, a clean
   `dist/` and build.

## Git workflow

Commits, in order:
1. `docs: add plan 113 jevway installs in one line`
2. `test: describe the env file, the keyless server and the doctor` (red)
3. `feat: read keys from ~/.config/jevway/env`
4. `feat: start the mcp server without a key`
5. `feat: add jevway doctor`
6. `feat: complete the package metadata for npm`
7. `test: check the claude code plugin manifest` (red), then `feat: add the claude code plugin`
8. `docs: add the install guide for agents and one-line installs`

Lowercase conventional commits. **No AI attribution of any kind**. Do NOT push.

## Steps

1. Tests first (`test/env-file.test.ts`, `test/keyless.test.ts`, `test/doctor.test.ts`, later `test/package.test.ts`):
   - **Env file:** fills unset and empty variables; never overrides a set one; ignores names outside the allow-list;
     returns the names it filled; a missing file is a no-op; the XDG path wins over `~/.config`.
   - **Keyless:** with both keys empty, `createRunner('launch-headless')` doesn't throw, and `start()` rejects naming
     `TYPESAFE_API_KEY` without calling `connectChrome`. Over MCP: `tools/list` lists the 8 `jevway_*` tools, and
     `jevway_task` returns `isError` naming the key and `jevway doctor`.
   - **Doctor:** each row of the decision table (no key; Jev direct; Jev through OpenRouter; clef with only the TypeSafe
     key; unknown model; Node 22; launch without Chrome; auto with no port file, a dead port and a live port; a URL down;
     ffmpeg missing; an open env file), plus exit codes, `--plan` numbering, and a key never printed (also in a live
     error).
2. Implement each piece and commit as above.
3. Plugin and guide, README install section, skill wording, AGENTS.md command and layout lines.
4. Check: `pnpm typecheck && pnpm test && pnpm build`, `npm pack --dry-run`, `claude plugin validate .`,
   `claude --plugin-dir . plugin details jevway`, and `node dist/cli.js doctor` with both keys unset.

## Done criteria

- [ ] typecheck, test and build pass, with the new tests red first
- [ ] `npm pack --dry-run` lists `dist/`, `skill/jevway/SKILL.md`, `INSTALL-FOR-AGENTS.md`, README and licences only
- [ ] `claude plugin validate .` has no errors; `plugin details` lists the skill and the MCP server
- [ ] `node dist/cli.js doctor` output recorded with no key in its env
- [ ] `git diff --stat main` lists only the in-scope paths

## STOP conditions

- Any change would alter the run loop, a guard, the consent rule or a status.
- The doctor would need to open the DevTools WebSocket of the user's Chrome to tell a state apart.

## Maintenance note

On a release, bump `version` in `package.json` and `.claude-plugin/plugin.json` together (the test enforces it); the
server's `McpServer` version in `src/mcp.ts` should follow. The env file's allow-list is the place to add a new
`JEVWAY_*`-style knob that isn't prefixed.
