# Plan 117: an agent-first CLI with sessions through an auto-started daemon

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Another executor rewires `src/mcp.ts` on the session service (plan 116) and a third
> reworks the HTML pages, so never edit `src/mcp.ts`, `src/recording/` or `verify/` here. Never push, never merge into
> `main`, never run `npm publish`.
>
> **Drift check (run first)**:
> - `src/cli.ts` is one file: `parseArgs` without positionals for the task, and `doctor`/`setup`/`skill` dispatched on
>   `process.argv[2]` before it (`runDoctor(argv, fromEnvFile)`, `runSetup(argv, fromEnvFile)`, `runSkill(argv)`).
> - `src/session/session-service.ts` exports `createSessionService`, `UnknownSession` (`code = 'unknown_session'`),
>   `SessionEvent` and `listSessions()`; `src/task/present.ts` exports `presentSummary` and `nextFor`.
> - `src/setup/command-output.ts` exports `printError(exitCode, code, message, hint)`.
> - `package.json` `bin.jevway` is `dist/cli.js`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: L · **Risk**: MEDIUM (a new long-lived process holding browser tabs; the run loop,
  guards, consent rules and statuses are untouched) · **Category**: agent experience
- **Planned at**: commit `7e6458f` (`wt/round13`), 2026-11-02

## Why this matters

- The CLI can't continue a session (`src/cli.ts:85-115`: one `runner.start`, one `task.run`, tabs closed, exit). An
  agent without MCP that gets `needs_input` has to start over: a new Chrome for `launch`, the form typed again.
- Its output isn't parseable as a whole: usage goes to stderr as text (`src/cli.ts:65`), errors are
  `jevway: <message>` on stderr (`:78`, `:88`, `:113`), and a bad `--values` throws a raw `SyntaxError` out of
  `JSON.parse` (`:94`) with a Node stack trace. `parseArgs` errors (a typo like `--vales`) crash the same way.
- The summary printed is the raw `TaskSummary` (`:111`), 1–4k tokens of steps and stats, with no `story`, `next` or
  file paths, while plan 115 built a concise, file-rich form for every adapter.
- Prior art the owner pointed at: agent-browser and the Playwright CLI keep a browser and named sessions alive in a
  background daemon the first command starts, talk to it over one local socket, and give every command a JSON result.

## Current state

- `createSessionService(runner, options)` holds task sessions and journeys by UUID, gives each a run folder, waits on a
  session's running call, emits `started`/`step`/`finished` events, and lists sessions (`listSessions`). One service
  has one output root and one runner (one browser source, one model).
- `createRunner(source, { model, screenshots })` connects the browser lazily on the first `start`/`look`/journey.
  `runner.requireKey()` throws the missing-key message.
- `runSetup`, `runSkill`, `runDoctor` return their exit codes and print to `process.stdout` themselves (plan 118).

## Scope

**In scope:**
- `src/cli.ts` → `src/cli/` (dispatcher, flag parsing, help, output, one module per command); `src/daemon/` (protocol,
  paths, server, client); tests in `test/cli/` and `test/daemon/`.
- `package.json` `bin.jevway` → `dist/cli/main.js`, the `build` script's `chmod` and the `cli` script's path;
  `test/package.test.ts` (bin only).
- The CLI sections of `docs/reference.md`, the commands section (and the one `src/cli.ts` layout line) of `AGENTS.md`.

**Out of scope:**
- `src/mcp.ts`, `src/task/present.ts` wording, the run loop, `skill/jevway/SKILL.md` (plan 116 owns the skill text;
  the reviewer folds the CLI lines in), README, `docs/how-it-works.md` and `CONTRIBUTING.md` (they name `src/cli.ts`
  as the entry; the reviewer updates the path).
- Changing `doctor`/`setup`/`skill` behaviour: they are routed through the new dispatcher as they are (their own
  output rules from plan 118 stand: `doctor` prints text unless `--json`, `skill` prints SKILL.md).

## Decisions

1. **Commands.** `run`, `look`, `journey start|step|autopilot|annotate|finish`, `sessions`, `end`, `serve`, `stop`,
   plus `doctor`, `setup`, `skill`, `help`. `jevway --goal …` (any argv starting with a flag other than
   `--help`/`--version`) is `jevway run --goal …`. Flags mirror the MCP parameters in kebab-case (`--secret-keys`,
   `--done-when`, `--confirm-irreversible`, `--confirm-target`, `--stay-within`, `--out-dir`, `--keep-tab`), plus
   `--browser`, `--model`, `--screenshots`, `--keep-open` (one-shot) and `--detail concise|full`.
2. **Output contract.** stdout carries exactly one JSON document per command: `{ "ok": true, … }` or
   `{ "ok": false, "error": { "code", "message", "hint" } }`. The only exceptions are the outputs a person asks for
   by name: `--help`/`help` (text, examples first), `--version` (`0.1.2`), and the plan-118 commands' own text modes.
   stderr carries only NDJSON events: the service's `started`/`step`/`finished`, and
   `{"type":"daemon","event":"started"|"restarted",…}` when a command started the daemon (an event type beyond the
   service's three, still NDJSON). Exit codes: 0 success (`done`,
   or a command that did what it said), 1 a hand-back (`needs_input`, …) or a tool error, 2 bad usage (unknown
   command or flag, a bad value, a missing flag, the model's key missing). A top-level guard turns any uncaught error
   into `{ ok:false, error:{ code:'internal_error' } }`, exit 1: no Node stack trace reaches either stream.
3. **Error codes.** `unknown_command`, `unknown_flag` (hint `Did you mean --values? See jevway run --help`, by edit
   distance ≤ 2 over the command's flags), `missing_flag`, `invalid_value` (JSON flags name the flag and give an
   example: `--values: Expected property name …`, hint `--values '{"city":"Lisbon"}'`), `missing_key` (exit 2),
   `unknown_session`, `daemon_unavailable` (hint names the log), `daemon_busy` (see 9), `outcome_unknown`, `failed`
   (any other error from the run or the browser, its message kept). The CLI never prompts.
4. **One-shot `run` stays in-process.** `jevway run` without `--session` runs exactly like today: no daemon, its own
   browser connection, its tabs closed at the end (`--keep-open` keeps them), Ctrl-C ends it `blocked`. It now goes
   through `createSessionService` in-process, so it gets a run folder, the concise result, `story` and `files`. Its
   result carries no `session` (nothing is left to continue) and its `next` says to run again, adding
   `--session new` to keep the tab between calls. `look --url`/`look --tab` are in-process too (no session needed).
5. **Everything with a session goes through the daemon**: `run --session new|<id>`, `look --session`, every `journey`
   subcommand, `end`. Only commands that need a session start it; `sessions`, `end` and `stop` never do (no daemon:
   `sessions` is an empty list with `"daemon": null`, `end` is `unknown_session`, `stop` is `"stopped": false`).
6. **Daemon process.** `jevway serve [--idle-timeout 1h]` runs it in the foreground: one JSON line on stdout once it
   listens, NDJSON log lines on stderr. Auto-start spawns `process.execPath <this entry> serve` detached, cwd the
   state dir, stdout and stderr appended to `<state>/daemon.log`, then polls the socket for up to 10 s. State dir:
   `$JEVWAY_STATE_DIR`, else `$XDG_RUNTIME_DIR/jevway`, else `~/.cache/jevway` (mode 700); socket
   `<state>/daemon.sock`. Windows: a named pipe `\\.\pipe\jevway-<user>` through the same `net` API (untested; no
   socket file to clean up).
7. **Protocol.** Newline-delimited JSON over the socket. Request `{ id, method, params }`; replies
   `{ id, event }` (zero or more), then `{ id, result }` or `{ id, error: { code, message, hint } }`; the client
   cancels with `{ cancel: id }`. Methods: `hello`, `task`, `look`, `end`, `sessions`, `journey.start|step|autopilot|
   annotate|finish`, `stop`. A dropped connection aborts that connection's running calls (like a cancelled MCP request:
   the run ends `blocked` at its next check, the session stays usable).
8. **One daemon, many configurations.** The daemon keeps one runner per `(browser, model, screenshots)` and one session
   service per `(runner, output root, journeys root)`. The client resolves every path before sending (`JEVWAY_OUT_DIR`
   or `./.jevway` against the caller's cwd, `--record-dir`, `--out-dir`, `JEVWAY_JOURNEYS_DIR`), so runs land under
   the caller's working directory whichever directory started the daemon. A session id is found in whichever service
   holds it. Each output root gets `sessions.json` (that root's open sessions) rewritten on every change.
9. **Version and environment match.** `hello` carries the CLI's version and a fingerprint (sha256) of what the daemon
   reads from its own environment: which key variables are set (never their values or anything derived from them),
   `CHROME_PATH`, `JEVWAY_ALLOWED_HOSTS`, `JEVWAY_BLOCKED_HOSTS` (journeys and looks read them daemon-side),
   `JEVWAY_REPLAY` and `JEVWAY_REPLAY_DIR`. Browser, model, screenshots and paths travel per request. On a mismatch
   the client stops the daemon and starts a new one when it holds no sessions (event `restarted`, with the reason), and
   otherwise fails with `daemon_busy`: "the running daemon is version X / has other settings and holds N sessions",
   hint `jevway sessions` then `jevway stop`. Restarting under open sessions would close tabs an agent still uses. A
   rotated key with the same variables set is not noticed: `jevway stop` picks it up (documented).
10. **Stale socket.** A socket file nothing answers (`ECONNREFUSED`, `ENOTSOCK`) is removed before starting a daemon.
    A daemon that finds the socket in use checks it: one that answers means another daemon won the start race, so it
    exits 0; one that doesn't is removed and listened on again.
11. **Timeouts.** `hello` 5 s; a task call `max_seconds` (default 300) + 120 s; `look`, `end`, `sessions`, `stop`
    60 s; journey calls 30 min (autopilot has no step limit). These are all above the daemon's own limits, so the
    agent normally gets the daemon's real result. When the client gives up or the connection drops before a reply,
    a `task`, `journey.step`, `journey.autopilot` or `end` call is `outcome_unknown`: "the daemon stopped answering
    while the call was running; it may already have clicked or typed", hint
    `Check the page with jevway look --session <id> before repeating it`.
12. **The daemon log never holds a value.** `daemon.log` gets one NDJSON line per start, stop, request (method, id,
    session, duration, error code) and idle end; never a request's `params` (they carry `values`, secret ones
    included). A test sends a secret value and reads the log.
13. **Idle.** Every tick (a quarter of the idle time, between 25 ms and 60 s) the daemon ends each session and
    journey idle for `--idle-timeout` (default `1h`; seconds or `90s`/`30m`/`2h`; `0` never) with no call running (tabs it opened are closed; a
    journey is finished, so its map is written), and exits when it holds none and no request came for that long.
    The unknown-session message names the idle time. `stop` aborts running calls, waits up to 10 s for them,
    ends every session, closes the browsers it launched, removes the socket and exits.
14. **Results.** `run`: `{ ok, session?, status, reason, next, story, url, title, page_text, …, files }` from
    `presentSummary` (`--detail full` adds steps, `jev`, `stuck`), `next` translated to flags (`values` →
    `--values`, `confirm_irreversible: true` → `--confirm-irreversible`, "this session" → `--session <id>`). `look`:
    `{ ok, url, title, page_text, elements, … }`. `journey …`: the screen report with its `screenshot` path; the
    base64 preview the MCP tools inline is left out. `sessions`: `{ ok, daemon: { pid, version, socket, log,
    idle_timeout_s } | null, sessions: [{ session, kind, goal, status, url, running, run_dir, … }] }`. `end`:
    `{ ok, session, run_dir }` (a journey: its finish summary). `--screenshot` is accepted for parity with the MCP
    `screenshot` parameter and changes nothing: the CLI always returns the screenshot's path.
15. **`--record`.** `--record` (no value) keeps the recording in the session's run folder; `--record-dir <dir>` is the
    MCP `record_dir`. Today's `--record <dir>` keeps working: a `--record` followed by a value that is not a flag is
    read as `--record-dir`.
16. **Entry.** `src/cli/main.ts` (`#!/usr/bin/env node`) is the bin, `dist/cli/main.js`; it loads the env file and
    calls `runCli(argv, deps)`, whose dependencies (streams, env, cwd, runner factory, daemon access) are injected so
    tests run every command in-process against a real socket and a fake runner.

## Git workflow

1. `docs: add plan 117 agent-first cli and daemon`
2. `test: describe the cli contract` (red) → `feat: parse cli flags into structured errors and help`
3. `test: describe the daemon` (red) → `feat: add the session daemon and its client`
4. `feat: run sessions through the daemon from the cli`
5. `docs: describe the cli commands and the daemon`

Tests first in each, red for the right reason. `pnpm release:check` passes at every handed-over commit.

## Steps

1. Tests (`test/cli/`, `test/daemon/`), all without Chrome or a key (fake runner from `BrowserTask` on `fakeTab`, as in
   `test/session/session-service.test.ts`):
   - arg parsing: every error code and exit code; did-you-mean; JSON flag errors naming the flag; `--record <dir>`;
     the `--goal` alias; help starts with `Examples:`; `--version`.
   - stdout is exactly one JSON document in every path (done, hand-back, usage error, tool error); stderr lines all
     parse as JSON.
   - daemon: start/connect/reuse; two `runCli` invocations continue one session (same tab, call 2 in `calls/`);
     `sessions`, `end`, `stop`; idle exit and idle session end; stale socket file; version mismatch with and without
     sessions; a dropped connection mid-run is `outcome_unknown`; cancel ends the run `blocked`.
   - a subprocess check of `src/cli/main.ts`: `--version`, an unknown flag (no stack trace), and the real detached
     auto-start (`look --session <unknown>` starts a daemon in a temporary state dir, answers `unknown_session`, then
     `stop`).
2. Implement `src/cli/` and `src/daemon/`, move the bin, build.
3. Docs: `docs/reference.md` CLI section (commands, flags, output, daemon), `AGENTS.md` commands.
4. Live by hand (a `live-1` lock): `run --session new --browser launch-headless --url https://en.wikipedia.org`,
   `look --session`, `sessions`, `end`, `stop`; paste the outputs in the report.

## Done criteria

- [x] new tests red first, then green; `pnpm release:check` passes
- [x] every CLI path prints one JSON document on stdout (help and version excepted) and NDJSON only on stderr
- [x] two CLI invocations continue one session through the daemon; idle, stale socket and version mismatch tested
- [x] the live session run, look, sessions, end and stop outputs recorded in the report
- [x] `git diff --stat wt/round13` lists only in-scope paths

## Deviations

- `src/task/present.ts` (outside the scope above), at the coordinator's request: `presentSummary` prints `status`,
  `reason`, `story`, `next`, `session`, `url`, `title`, … and `page_text` last, the order plan 116's MCP results use,
  so both adapters share it.
- Commands that name an existing session (`run --session <id>`, `look --session`, `journey step|…`) never start the
  daemon: with none running the session is `unknown_session`. Only `run --session new` and `journey start` start it.
- `serve` prints its start document on one line, so `daemon.log` stays one JSON object per line.

## STOP conditions

- Any change would alter the run loop, a guard, the consent rule or a status.
- The session service would need more than a small fix to be shared across output roots (then share one root and say
  so instead).

## Maintenance note

A new CLI flag is one entry in its command's spec in `src/cli/` (the did-you-mean list and help come from it) plus a
line in `docs/reference.md`. A new environment variable the daemon reads itself (not per request) must join the
fingerprint in `src/daemon/paths.ts`, or a daemon started before the change keeps the old value. A protocol change
needs no version bump of its own: a CLI of another version already restarts the daemon.
