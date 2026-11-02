# Setting up jevway (for agents)

You are an agent asked to set up jevway for a person and prove it works. jevway is an MCP server, `jevway-mcp`, plus a
CLI, `jevway`, both from the npm package `jevway`. It hands browser goals to TypeSafe Jev and returns one checked
summary per goal.

Read this whole file before you run anything. You will:
1. check the machine's prerequisites with the person and help install what's missing;
2. get the API key in place (the person does that part);
3. register the MCP server with the client you're running in;
4. pick the browser with the person;
5. install the skill;
6. check the setup;
7. run a recorded smoke test, from Google to Wikipedia;
8. report back with the run page, its video and screenshots, as proof.

Run only these yourself:
- `node --version`, `ffmpeg -version`, and the person-approved install commands from step 1;
- `npx -y jevway doctor --json` (or `--plan`, or `jevway doctor`);
- `npx -y jevway setup --client <name> --print [--json]`, which prints how to register jevway with a client and
  changes nothing;
- `npx -y jevway skill --install <skills folder>`;
- `npm install -g jevway`;
- the client's own `mcp add` command, or an edit to its MCP config file that the person approved;
- the jevway tools themselves (or `npx -y jevway run …`) for the smoke test.

Never run plain `jevway setup` yourself: it is the person's interactive setup, and without a terminal it exits 2 with
`{ "ok": false, "error": { "code": "needs_tty", … } }`.

Done means: `jevway doctor --json` prints `"ready": true`, the client lists the `jevway_*` tools, and the smoke test
ended `done` with a run page you showed the person.

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

`npx` itself needs Node, so check `node --version` first. For anything missing, propose the command that fits the
person's OS and package manager, and run it only after they say yes (or wait while they install it themselves, then
check again):

| Tool | Needed for | macOS (Homebrew) | Debian / Ubuntu | Fedora | Windows (winget) |
| --- | --- | --- | --- | --- | --- |
| Node.js 24+ | running jevway (required) | `brew install node` | Node 24 from NodeSource or nvm | `sudo dnf install nodejs` (check it's 24+) | `winget install OpenJS.NodeJS` |
| Chrome or Chromium | every run (required) | `brew install --cask google-chrome` | Google's `.deb`, or `sudo apt install chromium` | `sudo dnf install chromium` | `winget install Google.Chrome` |
| ffmpeg | the video in a recording (optional) | `brew install ffmpeg` | `sudo apt install ffmpeg` | `sudo dnf install ffmpeg-free` | `winget install Gyan.FFmpeg` |
| notify-send | the desktop notification when a person is needed (optional, Linux) | built in | `sudo apt install libnotify-bin` | `sudo dnf install libnotify` | not used |

A Chrome in an unusual place: set `CHROME_PATH` in `~/.config/jevway/env`.

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

Ask the person which browser jevway should use, and set `JEVWAY_BROWSER` in the server's env (or `--browser` for
the CLI) when it isn't `auto`. For the smoke test a visible one is best, so they can pass a check if one appears.

| Value | What it uses | What the person does |
| --- | --- | --- |
| `auto` (default) | their running Chrome, shared with `chrome-devtools-mcp --auto-connect` | open `chrome://inspect/#remote-debugging` and allow it; Chrome asks once more on jevway's first connection |
| `launch` / `launch-headless` | a throwaway profile jevway starts and closes | nothing (Chrome must be installed, or `CHROME_PATH` set) |
| `http://127.0.0.1:<port>` | a Chrome started with `--remote-debugging-port=<port>` and its own `--user-data-dir` | start that Chrome; never point it at their everyday profile |

## 5. The skill (clients other than the Claude Code plugin)

The skill says when to use `jevway_task` and when to use chrome-devtools. It ships in the package; `jevway skill`
prints it, and this copies it into a client's skills folder as `<folder>/jevway/`, with the standalone inbox skill
beside it as `<folder>/jevway-inbox/`:

```bash
npx -y jevway skill --install ~/.codex/skills   # or ~/.claude/skills, ~/.cursor/skills, ~/.config/opencode/skills
```

It prints `{ ok, status, path, files, skills }`: `status` (`installed`, `unchanged` or `replaced`), `path` and `files`
for `jevway`, and `skills: [{ name, status, path, files }]` for both. A different skill already in either folder (or a
symlink to one) is left alone and nothing is copied: `"code": "skill_exists"` naming it, exit 1; replace it with
`--force` only if the person agrees.

## 6. Check the setup

1. `npx -y jevway doctor --json` prints `"ready": true` and exits 0 (every finding `ok` or `warn`). For every finding
   that isn't `ok`, tell the person the fix in one line and wait; re-run it after each fix (`--plan` lists the steps
   left).
2. The client lists the tools: `jevway_task`, `jevway_look`, `jevway_end`, the five `jevway_journey_*` tools and
   `jevway_inbox_create` / `jevway_inbox_wait`.
   - In Claude Code: `/mcp`.
   - Elsewhere, the client's MCP list.
   - Or the MCP Inspector:
     `npx @modelcontextprotocol/inspector --cli npx -y -p jevway jevway-mcp --method tools/list`.
3. Optional, costs a fraction of a cent: `npx -y jevway doctor --live` makes one real Jev request and reports its
   latency.

## 7. The smoke test

Call `jevway_task` with:

```json
{
  "url": "https://www.google.com",
  "goal": "Search Google for the Rosetta Stone and open its English Wikipedia article",
  "values": { "query": "Rosetta Stone Wikipedia" },
  "done_when": "The English Wikipedia article about the Rosetta Stone is open",
  "allowed_hosts": ["google.com", "*.google.com", "en.wikipedia.org"],
  "record": true,
  "detail": "full"
}
```

What to expect, and what to do:
- **A cookie banner** is handled by jevway (it declines when it can).
- **A reCAPTCHA ("unusual traffic")** is common for automated browsers on Google. In a visible browser jevway brings
  the tab to the front, sends the person a desktop notification and waits up to 2 minutes for them to pass it; it
  never solves it. Tell the person it may happen before you start.
- **A result with `ask_user`** (a bot check, a sign-in, a missing value): put that question to the person with your
  own ask tool, then do what its `then` says.
- **Google keeps blocking**: run the same goal from `https://duckduckgo.com` with
  `allowed_hosts: ["duckduckgo.com", "en.wikipedia.org"]`. It usually finishes in 5 steps.
- **No MCP in your client**: run the same test with the CLI, which prints one JSON result on stdout:

  ```bash
  npx -y jevway run --browser launch --record --detail full --url https://www.google.com \
    --goal "Search Google for the Rosetta Stone and open its English Wikipedia article" \
    --values '{"query":"Rosetta Stone Wikipedia"}' \
    --done-when "The English Wikipedia article about the Rosetta Stone is open" \
    --allowed-hosts "google.com,*.google.com,en.wikipedia.org"
  ```

End the session with `jevway_end` when you have what you need.

## 8. Report back

Tell the person, in this shape:
- **Outcome:** `status` and `reason`, and the `story` as a numbered list.
- **Proof:** the run page `files.page` (open it for them: `open` on macOS, `xdg-open` on Linux, `start` on Windows),
  the video `files.video` (present when ffmpeg is installed), the end screenshot `files.screenshot` (show it if you
  can display images), and the run folder `files.run_dir` with its `manifest.json`.
- **Cost:** `jev.requests` and `jev.est_cost_usd` (an estimate; a typical smoke test is well under a cent).
- **Setup:** what you installed or changed, with the person's yes for each.
- **Anything that needed them**, and anything that didn't work, with the fix.

The run page opens with the goal and how it ended, then the video with every step on a timeline and a strip of
screenshots kept in sync. It is the proof that the whole chain works: the client, the MCP server, the key, the
browser and Jev.
