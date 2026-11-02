# Installing jevway (for agents)

You are an agent asked to install jevway for a person. jevway is an MCP server, `jevway-mcp`, plus a CLI, `jevway`.
It hands browser goals to TypeSafe Jev. Both come from the npm package `jevway`.

Read this whole file before you run anything. Run only these:
- `npx -y jevway doctor --json` (or `--plan`, or `jevway doctor`);
- `npx -y jevway setup --client <name> --print [--json]`, which prints how to register jevway with a client and
  changes nothing;
- `npx -y jevway skill --install <skills folder>`;
- `npm install -g jevway`;
- the client's own `mcp add` command, or an edit to its MCP config file that the person approved.

Never run plain `jevway setup` yourself: it is the person's interactive setup, and without a terminal it exits 2 with
`{ "ok": false, "error": { "code": "needs_tty", … } }`.

Done means: `jevway doctor --json` prints `"ready": true` (exit 0), and the client lists the `jevway_*` tools.

## Rules

- **Show a diff before editing any MCP config file, and wait for approval.** Keep the person's other servers as they
  are. When the client has an `mcp add` command, prefer it.
- **Never ask for the key in the chat, and never echo it.** The person puts it in `~/.config/jevway/env` themselves
  (below), or in the client's env block. Don't write a key into config that is committed to git or synced between
  machines.
- **Never relaunch, close or restart a browser you didn't start.** For the person's own Chrome, ask them to allow
  remote debugging. If they'd rather keep it untouched, use `JEVWAY_BROWSER=launch` (a throwaway profile jevway starts
  and closes).
- **Pass the key explicitly when the client filters the environment.** Codex, for example, gives MCP servers only a few
  variables. The env file works on every client, because jevway reads it itself; the client only has to pass `HOME`.
  Otherwise put `TYPESAFE_API_KEY` in that server's env block.
- **Stop and ask** when a step would change another browser tool's config, or when the doctor reports something this
  file doesn't cover.

## 1. Check the machine

```bash
npx -y jevway doctor --json
```

It prints `{ ready, findings: [{ check, level, message, fix? }] }`; `--plan` prints the steps still missing, numbered.
It needs no key to run and never prints one. It checks:
- Node 24 or later;
- a key, and which route it selects;
- the browser source;
- ffmpeg (optional: only for recordings).

If the first `npx` start is slow, or a client times out starting the server, install once with `npm install -g jevway`.
Then use `jevway-mcp` as the command instead of `npx -y -p jevway jevway-mcp`.

## 2. The key

jevway needs one of these:
- `TYPESAFE_API_KEY` (preferred): Jev on the TypeSafe API, with screenshots and Box.
- `OPENROUTER_API_KEY`: Jev, and the other models, through OpenRouter.

The easiest way for the person: run `npx -y jevway setup` in their own terminal. It reads the key with hidden input,
writes only that line to `~/.config/jevway/env` (mode 600), tests the browser, and offers to register their MCP
clients, showing each change first.

Or they add the line themselves, in their own editor or terminal, never in this chat:

```bash
mkdir -p ~/.config/jevway && touch ~/.config/jevway/env && chmod 600 ~/.config/jevway/env
# then, in an editor: TYPESAFE_API_KEY=<their key>
```

How the file is read:
- `jevway` and `jevway-mcp` read it at start (`$XDG_CONFIG_HOME/jevway/env` when that is set).
- They take only the keys, `CHROME_PATH` and `JEVWAY_*` settings.
- A variable already in the environment wins.

Without a key the MCP server still starts and lists its tools. `jevway_look` works, and each other call answers with
the fix.

## 3. Register the MCP server

Use the server name `jevway`. Add `JEVWAY_BROWSER` only if the person chose something other than `auto`.

**Claude Code.** The plugin brings the server and the skill in one install. Run these inside Claude Code:

```text
/plugin marketplace add AbdallahAHO/jevway
/plugin install jevway@jevway
```

Otherwise ask jevway for the exact command or snippet. It prints, and changes nothing:

```bash
npx -y jevway setup --client claude-code --print   # also: codex, cursor, opencode, other
npx -y jevway setup --client cursor --print --json # { client, kind, command?, file?, snippet }
```

- `kind: "command"` (Claude Code, Codex): run `command`. For Codex, `snippet` is the table it writes to `file`.
- `kind: "config"` (Cursor, OpenCode): merge `snippet` into `file`, keeping every other server; show the person the
  diff first and wait for approval. `other` gives the `command` and `args` for any stdio MCP client.

## 4. The browser

`JEVWAY_BROWSER` (the server's env, or `--browser` for the CLI):

| Value | What it uses | What the person does |
| --- | --- | --- |
| `auto` (default) | their running Chrome, shared with `chrome-devtools-mcp --auto-connect` | open `chrome://inspect/#remote-debugging` and allow it; Chrome asks once more on jevway's first connection |
| `launch` / `launch-headless` | a throwaway profile jevway starts and closes | nothing (Chrome must be installed, or `CHROME_PATH` set) |
| `http://127.0.0.1:<port>` | a Chrome started with `--remote-debugging-port=<port>` and its own `--user-data-dir` | start that Chrome; never point it at their everyday profile |

## 5. The skill (clients other than the Claude Code plugin)

The skill says when to use `jevway_task` and when to use chrome-devtools. It ships in the package; `jevway skill`
prints it, and this copies it into a client's skills folder as `<folder>/jevway/`:

```bash
npx -y jevway skill --install ~/.codex/skills   # or ~/.claude/skills, ~/.cursor/skills, ~/.config/opencode/skills
```

It prints `{ ok, status, path, files }`. A different `jevway` skill already there (or a symlink to one) is left alone
with `"code": "skill_exists"` and exit 1; replace it with `--force` only if the person agrees.

## 6. Check the outcome

1. `npx -y jevway doctor --json` prints `"ready": true` and exits 0 (every finding `ok` or `warn`).
2. The client lists the tools: `jevway_task`, `jevway_look`, `jevway_end` and `jevway_journey_start`, `_step`,
   `_autopilot`, `_annotate`, `_finish`.
   - In Claude Code: `/mcp`.
   - Elsewhere, the client's MCP list.
   - Or the MCP Inspector:
     `npx @modelcontextprotocol/inspector --cli npx -y -p jevway jevway-mcp --method tools/list`.
3. Optional, costs a fraction of a cent: `npx -y jevway doctor --live` makes one real Jev request and reports its
   latency.

When a check fails, the doctor names the cause and the fix, and `--plan` lists the steps left. Re-run it after each fix.
