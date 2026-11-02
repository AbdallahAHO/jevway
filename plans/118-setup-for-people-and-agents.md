# Plan 118: setup that works for people and for agents

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Never push, never merge into `main`, never run `npm publish`.
>
> **Drift check (run first)**:
> - `src/cli.ts` dispatches `doctor` on `process.argv[2]` before `parseArgs`, calling `runDoctor(argv, fromEnvFile)`.
> - `src/setup/doctor.ts` exports `diagnose`, `render`, `planSteps`, `exitCode`, `liveCheck`, and `Finding` has `area`.
> - `src/setup/env-file.ts` exports `envFilePath`, `shownEnvFilePath`, `loadEnvFile`.
> - `package.json` `files` lists `skill`, and `skill/jevway/SKILL.md` exists.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: LOW (setup paths, docs and new subcommands; the run loop, guards,
  consent rules and statuses are untouched) · **Category**: distribution
- **Planned at**: commit `e755f59`, 2026-11-02

## Why this matters

- Setting up jevway today is a page of prose (`INSTALL-FOR-AGENTS.md` §2–§5): a person creates `~/.config/jevway/env`,
  sets its mode, types the key in an editor, then edits one MCP config per client by hand. Every step is a place to
  get it wrong, and the key-in-an-editor step is the one most likely to end with a key pasted into a chat.
- An installing agent has to copy commands out of Markdown (`INSTALL-FOR-AGENTS.md:83-118`). Nothing in the package
  prints them, so a renamed client flag or path drifts silently between the guide and the code.
- `jevway doctor` prints text only (`src/setup/doctor-command.ts:80`), so an agent has to scrape `FAIL` lines.
- The skill ships in the package (`package.json` `files`) but nothing installs it: §5 says "copy that folder", and an
  `npx` user has no idea where npm put it.
- The round's brief makes agents the primary CLI users: JSON by default, structured errors, never a prompt without a
  TTY.

## Current state

- `src/setup/doctor.ts`: pure `diagnose(probes)`; `browserFinding` is private. `doctor-command.ts` wires `realProbes`
  (private) and prints `render` or `planSteps`.
- `src/setup/env-file.ts`: reads the env file (allow-listed names only); nothing writes it.
- `src/cli.ts`: only `doctor` is a subcommand.
- Clients on a typical machine: `claude` (user MCP servers in `~/.claude.json` `mcpServers`, plugins in
  `~/.claude/plugins/installed_plugins.json`), `codex` (`$CODEX_HOME/config.toml`, `[mcp_servers.<name>]`), Cursor
  (`~/.cursor/mcp.json`, `mcpServers`), OpenCode (`$XDG_CONFIG_HOME/opencode/opencode.json`, `mcp`). Skills folders:
  `~/.claude/skills`, `$CODEX_HOME/skills`, `~/.cursor/skills`, `$XDG_CONFIG_HOME/opencode/skills` (on this machine
  several are symlink farms).

## Scope

**In scope:** `src/setup/*` (new modules), `test/setup/*`, two dispatch lines in `src/cli.ts`, `INSTALL-FOR-AGENTS.md`,
the setup/doctor/skill sections of `docs/reference.md`, the commands and layout lines of `AGENTS.md`.

**Out of scope:** the rest of the CLI (another executor rewrites it in phase 2 and keeps these entry points),
README.md, `src/mcp.ts`, live suites, new dependencies.

## Decisions

1. **Entry points.** `runSetup(argv, fromEnvFile?)`, `runSkill(argv)` and `runDoctor(argv, fromEnvFile)` each return
   the exit code. `cli.ts` gets two dispatch lines next to `doctor`. Exit codes: 0 success, 1 the command failed or
   refused, 2 bad usage (including "needs a TTY").
2. **Structured errors go to stdout** as `{ "ok": false, "error": { "code", "message", "hint" } }`: stdout is where an
   agent reads the result; stderr is reserved for progress. One function prints them, so phase 2 can move them.
3. **`jevway setup` without a TTY** (stdin or stdout not a terminal) exits 2 with code `needs_tty`, a message naming
   `jevway setup --client <name> --print`, and a hint giving the env-file commands (`mkdir -p`, `touch`, `chmod 600`).
   It never prompts.
4. **`jevway setup --client <claude-code|codex|cursor|opencode|other> --print [--json]`** changes nothing and exits 0.
   Text: one line saying what to do and where, then the command or snippet. `--json`:
   `{ client, kind, command?, file?, snippet }`.
   | client | kind | command | file | snippet |
   | --- | --- | --- | --- | --- |
   | claude-code | command | `claude mcp add jevway -s user -- npx -y -p jevway jevway-mcp` | — | the command |
   | codex | command | `codex mcp add jevway -- npx -y -p jevway jevway-mcp` | `~/.codex/config.toml` | the TOML table it writes |
   | cursor | config | — | `~/.cursor/mcp.json` | `{ "mcpServers": { "jevway": … } }` |
   | opencode | config | — | `~/.config/opencode/opencode.json` | `{ "mcp": { "jevway": … } }` |
   | other | config | — | — | `{ "command": "npx", "args": [...] }` |
   Paths are shown with `~` and honour `$CODEX_HOME` / `$XDG_CONFIG_HOME`. `--print` without `--client`, or an
   unknown client, is exit 2.
5. **Detection** is injectable (`home`, `env`, `onPath(binary)`, file reads under `home`): a client is detected when
   its binary is on PATH (scanned directory by directory, never a shell: on this machine `claude` is a shell
   function) or its config folder exists. It is **already configured** when its config names `jevway`: Claude Code's
   `~/.claude.json` `mcpServers.jevway` or any `jevway@…` plugin; Codex's `[mcp_servers.jevway]`; Cursor's
   `mcpServers.jevway`; OpenCode's `mcp.jevway`. A configured client is skipped with a line saying so.
6. **Applying.** Claude Code and Codex run their own `mcp add` (via `execFile`, never a shell), shown first.
   Cursor and OpenCode get a JSON edit: parse, add only the `jevway` entry, re-serialise with the file's own indent,
   show a **unified diff** (own line diff, 3 lines of context, no dependency), write only on an explicit yes. A missing
   file is created (OpenCode's with its `$schema`). A file that is not plain JSON (comments, JSONC) or whose
   container is not an object is never edited: the snippet is printed to add by hand.
7. **Every write is atomic**: write `<file>.jevway-<pid>.tmp` beside it, then `rename`. Ctrl-C at any prompt exits 130
   with every file either as it was or fully written.
8. **The env file.** `setEnvValue(text, name, value?)` replaces the first `NAME=` line (dropping later duplicates),
   appends when missing, removes the line when `value` is undefined, and keeps every other line verbatim. The temp
   file is created with mode 600 (and `chmod`ed, since the umask can narrow `mode`) before it replaces the env file, so
   the result is always 600, including a file that was open before.
9. **The key.** The route question (TypeSafe recommended, or OpenRouter) picks `TYPESAFE_API_KEY` or
   `OPENROUTER_API_KEY`. Input is hidden (readline writing to a muted stream, history off). Loose shape check: 16 or
   more printable characters with no spaces, quotes or `#` (an `=` is fine: `parseEnv` splits on the first one); asked again up to 3 times. An OpenRouter key not
   starting `sk-or-` gets a confirm. An existing key (environment or file) is kept unless the person says replace.
   If the same variable is set in the real environment, setup says the environment wins over the file. After writing,
   `process.env` gets the value so the closing doctor sees it. `doctor --live` is offered, default no. The key never
   reaches any output, log or file but the env file.
10. **Browser.** Choices `auto` (default), `launch`, `launch-headless`, or a port (`http://127.0.0.1:<port>`); each is
    tested with the doctor's `browserFinding` (exported). A failed test offers another choice. `JEVWAY_BROWSER` is
    written only for a non-`auto` choice; choosing `auto` removes an existing line (shown first).
11. **Skill.** `jevway skill` prints the bundled `SKILL.md` (found at `../../skill/jevway/` from the module, the same
    depth in `src/` and `dist/`). `jevway skill --install <dir>` copies the folder to `<dir>/jevway/` and prints JSON
    `{ ok, path, files, status: 'installed' | 'unchanged' | 'replaced' }`. An identical folder is `unchanged` (exit 0);
    a different one (or a symlink) is refused, exit 1, code `skill_exists`, hint `--force`. `--force` replaces it
    (a symlink is replaced by the copy, its target untouched). The wizard offers the same per client, shown and
    confirmed.
12. **`doctor --json`**: `{ ready, findings: [{ check, level, message, fix? }] }` with `check` the finding's `area`
    as a stable lowercase slug (`node`, `key`, `model`, `env_file`, `browser`, `ffmpeg`, `replay`, `live`), mapped at
    the edge (the `Finding` type keeps `area`). `fix` only on `warn`/`fail`. Exit codes unchanged; no key ever.
13. **Wizard end**: the doctor's report, then one line on what to try first (a `jevway --goal` example on
    `launch-headless` or the configured browser).

## Git workflow

1. `docs: add plan 118 setup for people and agents`
2. `test: describe doctor --json` → `feat: add jevway doctor --json`
3. `test: describe jevway skill` → `feat: add jevway skill and skill --install`
4. `test: describe setup --print and client registration` → `feat: add jevway setup --client --print`
5. `test: describe the setup wizard` → `feat: add the interactive jevway setup`
6. `docs: point agents at setup --print and skill --install`

## Steps

1. Tests first in `test/setup/`: `doctor.test.ts` (json shape), `skill.test.ts`, `clients.test.ts` (detection,
   configured, `--print` per client, JSON edits keep other servers, unparsable files untouched),
   `unified-diff.test.ts`, `env-file.test.ts` (updates, mode 600, other lines kept), `setup.test.ts` (wizard with a
   scripted prompter: the key never echoed, applies only on yes, no TTY exits 2).
2. Implement per commit above; `pnpm release:check` passes at each.
3. Docs: `INSTALL-FOR-AGENTS.md` §3 and §5 point at the commands; `docs/reference.md` gains `jevway setup`,
   `jevway skill` and `doctor --json`; `AGENTS.md` commands and layout lines.
4. Check by hand: `node dist/cli.js setup --client cursor --print --json`, `node dist/cli.js skill | head`,
   `node dist/cli.js setup < /dev/null`, `node dist/cli.js doctor --json`.

## Done criteria

- [ ] new tests red first, then green; `pnpm release:check` passes
- [ ] `setup` without a TTY exits 2 with the structured error; `--print` exits 0 for all five clients and writes nothing
- [ ] env file written 600 with other lines kept; a key never appears in any output in tests
- [ ] JSON config edits keep every other server, and only happen after a yes
- [ ] `git diff --stat main` lists only the in-scope paths

## STOP conditions

- Any change would alter the run loop, a guard, the consent rule or a status.
- Registering a client would require editing another server's entry or a file that is not plain JSON.

## Maintenance note

A new client is one entry in `src/setup/clients.ts` (paths, detection, registration, skills folder) plus a `--print`
test. When a client's `mcp add` syntax changes, update its entry; `INSTALL-FOR-AGENTS.md` points at `--print` so it
does not need to change.
