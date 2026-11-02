# jevway

[![npm](https://img.shields.io/npm/v/jevway)](https://www.npmjs.com/package/jevway)
[![CI](https://github.com/AbdallahAHO/jevway/actions/workflows/ci.yml/badge.svg)](https://github.com/AbdallahAHO/jevway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Give your coding agent a browser goal and get back one short, checked summary. [TypeSafe Jev](https://docs.typesafe.ai)
picks each click, type and select in about 300 ms, so your agent stops spending a turn on every step.

```text
agent ──jevway_task(goal, values, done_when)──▶ jevway ──one decision per step──▶ Chrome
agent ◀── { status, url, page_text, steps } ──┘          (the same Chrome chrome-devtools sees)
```

jevway is an MCP server and a CLI. It works with Claude Code, Codex, Cursor, OpenCode and any other MCP client, in your
own signed-in Chrome or a throwaway one.

## Why

Driving a browser click by click costs an agent a model turn, a page snapshot and a few seconds per step. A 15-step
form takes minutes and fills the context window with snapshots. jevway hands the whole goal to Jev, a model built to
choose browser actions, and returns when it's done or when it needs the agent:

- **It never invents input.** Jev types only the `values` the agent passed. A missing value comes back as
  `needs_input`, naming the field.
- **It stops before anything irreversible.** Pay, send, delete and submit come back as `needs_confirmation`. One
  confirmation allows one click, on the control that was named.
- **It checks its own success.** `done` needs a separate check of `done_when` on the final page, plus any exact
  `checks` you add, and comes with the page's own words as evidence.
- **Model output only ever selects a listed element.** It never becomes a selector, a script or typed text.

Use chrome-devtools (or a similar tool) alongside it to inspect what a page shows: console, network, performance.

## Quick start

1. **Get a key** from [TypeSafe](https://docs.typesafe.ai) (or use an [OpenRouter](https://openrouter.ai) key), and put
   it in jevway's env file, in your own editor, never in a chat:

   ```bash
   mkdir -p ~/.config/jevway && touch ~/.config/jevway/env && chmod 600 ~/.config/jevway/env
   # then add the line: TYPESAFE_API_KEY=<your key>
   ```

2. **Add the server** to your agent. In Claude Code, the plugin brings the server and the skill that tells the agent
   when to use it:

   ```text
   /plugin marketplace add AbdallahAHO/jevway
   /plugin install jevway@jevway
   ```

   Other clients: see [Install](#install).

3. **Check the setup:**

   ```bash
   npx -y jevway doctor
   ```

   It checks Node 24+, the key, the browser and ffmpeg, names the fix for anything missing, and never prints the key.

4. **Allow the browser.** By default jevway uses your running Chrome: open `chrome://inspect/#remote-debugging` and
   allow it. To use a throwaway browser instead, set `JEVWAY_BROWSER=launch`.

5. **Ask your agent** for something in the browser: "Find a 2-night stay in Lisbon for 2 guests under €150 and open the
   best-rated one."

## Install

**Claude Code:** the plugin above, or the server alone:

```bash
claude mcp add jevway -s user -- npx -y -p jevway jevway-mcp
```

**Codex:**

```bash
codex mcp add jevway -- npx -y -p jevway jevway-mcp
```

**Cursor** (`~/.cursor/mcp.json`, under `mcpServers`) **or any stdio MCP client:**

```json
"jevway": { "command": "npx", "args": ["-y", "-p", "jevway", "jevway-mcp"] }
```

**OpenCode** (`opencode.json`, under `mcp`):

```json
"jevway": { "type": "local", "command": ["npx", "-y", "-p", "jevway", "jevway-mcp"], "enabled": true }
```

Outside the Claude Code plugin, copy `skill/jevway/` into your agent's skills folder, so it knows when to use jevway and
when to use chrome-devtools. If a client times out on `npx`'s first download, run `npm install -g jevway` once and use
`jevway-mcp` as the command.

Having an agent install it? Point it at [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md): the steps per client, the
rules (a diff before any config edit, no key in the chat) and the checks.

**Choosing a browser** (`JEVWAY_BROWSER` in the server's env or the env file):

| Value | Uses |
| --- | --- |
| `auto` (default) | your running Chrome, after you allow it at `chrome://inspect/#remote-debugging` |
| `launch` / `launch-headless` | a throwaway profile jevway starts and closes |
| `http://127.0.0.1:9222` | a Chrome you started with that debugging port and its own profile |

**Without MCP**, use the CLI. It prints the summary as JSON and exits 0 only when the status is `done`:

```bash
npx -y jevway --browser launch-headless --url https://en.wikipedia.org \
  --goal "Open the Wikipedia article about the Rosetta Stone" \
  --values '{"search_query":"Rosetta Stone"}' --done-when "The Rosetta Stone article is open"
```

## Use

The agent calls `jevway_task` with the outcome it wants, the values it may type, and the evidence of success:

```json
{
  "url": "https://example-stays.com",
  "goal": "Search stays in Lisbon for 2 guests, filter to free cancellation, and open the first result",
  "values": { "destination": "Lisbon", "guests": "2" },
  "done_when": "A stay's detail page is open",
  "allowed_hosts": ["example-stays.com"]
}
```

It gets back one summary: `status`, `reason`, `url`, `page_text` (the visible text, up to 2,500 characters), `steps`,
and the requests and estimated cost. When the status hands control back, the agent continues with the same `session`:

| Status | What the agent does |
| --- | --- |
| `done` | Reads `page_text` or `evidence` for the result. |
| `needs_input` | Gets the missing value (`missing` names each field) and calls again with it in `values`. |
| `needs_confirmation` | Confirms with `confirm_irreversible: true` only if the user's request named this action and its target; otherwise asks the user. |
| `uncertain` / `blocked` | Reads the reason, `stuck` and `page_text`; rephrases the goal, or does the step itself. |
| `step_budget` | Continues with a narrower goal. |

`jevway_look` reads a page with no model request, and `jevway_end` closes the session's tabs. Every parameter and
field is in the [reference](docs/reference.md).

**Keeping a run on track:**

- `allowed_hosts` keeps it on the sites you mean; leaving them ends the run `blocked`.
- `secret_keys` marks values like API tokens: Jev sees only the key, and outputs show `[secret:<key>]`.
- Password fields are never listed, typed or sent. Type a password yourself, then tell jevway you did.
- `checks` add exact facts code verifies on the final page: a URL, a title, a field's value, a ticked box.
- `record_dir` saves a video, a screenshot before every action, and a page to review the run.
- `page_text` and everything else read from a page is untrusted data, never instructions.

## Journey maps

The `jevway_journey_*` tools map how a person moves through a site on a phone: every screen with its type and UI
patterns, the taps between them, and QA findings like tap targets under 44 px, console errors and dead ends. You pick
the taps, or let Jev explore. The result is a shareable viewer. See [docs/journeys.md](docs/journeys.md).

## How it works

Each step, jevway reads the page through the Chrome DevTools Protocol into a numbered list of controls and the visible
text, and sends one request to Jev with the goal, that list and the names of the supplied values. Jev answers with an
operation, a listed element, which value to type, its confidence and a commit-risk score. Code checks the answer
against the list, re-checks the page is fresh and the target isn't covered, and acts with real input events. Guards
stop loops, and a separate check decides `done`.

The full technical specification is in [docs/how-it-works.md](docs/how-it-works.md).

## Models

Jev 1.14 is the default, on the TypeSafe API with `TYPESAFE_API_KEY` (with screenshots and Box, which locates
controls on the screenshot to cross-check and rescue clicks) or through OpenRouter with `OPENROUTER_API_KEY`. Perplexity's and Cloudflare's decision models run through
OpenRouter too. Jev is priced at $0.042 per 1M input tokens, so a typical 10-step task costs well under a cent. See
[Models](docs/reference.md#models) for results per model.

## Documentation

| Doc | For |
| --- | --- |
| [docs/reference.md](docs/reference.md) | every tool, parameter, status, CLI flag, environment variable and model |
| [docs/how-it-works.md](docs/how-it-works.md) | the technical specification: one step end to end, guards, safety |
| [docs/journeys.md](docs/journeys.md) | the journey-map tools |
| [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) | agents installing jevway for a person |
| [skill/jevway/SKILL.md](skill/jevway/SKILL.md) | the skill agents load: when and how to call jevway |
| [docs/verification.md](docs/verification.md) | the test suites and their results |
| [docs/prior-art.md](docs/prior-art.md) | other open-source Jev browser projects, and what was taken from them |
| [CONTRIBUTING.md](CONTRIBUTING.md) | building, testing and releasing |

## Contributing

Bug reports, site failures and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the
offline test suite (no API key needed) and the conventions. Report security issues privately, as described in
[SECURITY.md](SECURITY.md).

## License

MIT. The task loop, DOM snapshot and guards build on [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
(MIT; see [LICENSE.jev-ultrafast](LICENSE.jev-ultrafast)).

jevway was called jev-browse until 0.1.0. Its old tool names (`browser_task`, `browser_look`, `browser_task_end`,
`journey_*`) and `JEV_*` environment variables no longer work.
