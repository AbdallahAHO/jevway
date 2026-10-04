# jev-browse

Give your coding agent a browser goal. [TypeSafe Jev](https://docs.typesafe.ai) picks each click, type, and select in about 300 ms, and the agent gets back **one short summary** instead of making every decision itself.

```text
agent ──browser_task(goal, values, done_when)──▶ jev-browse ──one Jev request per step──▶ Chrome
agent ◀── { status, url, steps, stuck? } ───────┘            (same Chrome chrome-devtools inspects)
```

The only thing it needs is `TYPESAFE_API_KEY`. No second LLM is involved: the agent passes the text values it already knows, and Jev *selects* which value goes into which field (a speculative `value_for_<field>` head in the same request).

Built on the loop, DOM snapshot, and guards from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT).

## Install into any agent

Build once:

```bash
pnpm install && pnpm build
```

MCP config (Claude Code, Codex, Cursor, OpenCode, Gemini: any stdio MCP client):

```json
{
  "jev-browse": {
    "command": "node",
    "args": ["/absolute/path/to/jev-browse/dist/mcp.js"],
    "env": { "TYPESAFE_API_KEY": "…", "JEV_BROWSER": "auto" }
  }
}
```

Once the package is published, replace `command`/`args` with `npx -y jev-browse-mcp`.

`JEV_BROWSER` selects the browser:

- `auto` (default): your running Chrome, after you allow it at `chrome://inspect/#remote-debugging`. This is the same Chrome `chrome-devtools-mcp --auto-connect` uses, so Jev's tab is visible to chrome-devtools.
- `launch` or `launch-headless`: a throwaway profile.
- `http://127.0.0.1:9222`: an explicit debugging port.

Optionally copy `skill/jev-browse/` into your agent's skills so it knows when to use Jev and when to use chrome-devtools.

For agents without MCP, use the CLI:

```bash
TYPESAFE_API_KEY=… node dist/cli.js --browser launch-headless \
  --url https://en.wikipedia.org/wiki/Main_Page \
  --goal "Open the Wikipedia article about the Rosetta Stone" \
  --values '{"search_query":"Rosetta Stone"}' \
  --done-when "The Rosetta Stone article is open"
# prints the JSON summary; exit 0 only when status is "done"
```

## Tools

**`browser_task`** takes `goal`, `url` | `tab`, `values`, `done_when`, `session`, `confirm_irreversible`, and `max_steps`. It returns:

```json
{ "session": "be63210d", "status": "needs_input", "reason": "Blocked: no supplied value for \"Email address\"",
  "url": "…", "title": "…", "elapsed_ms": 899,
  "steps": [{ "operation": "TYPE_TEXT", "element": "Full name", "value_key": "full_name", "page_changed": true, "confidence": 0.9 }],
  "jev": { "requests": 3, "input_tokens": 7534, "median_latency_ms": 284 },
  "stuck": { "operation": "BLOCKED", "candidates": [], "page_text": "…" } }
```

| Status | Meaning |
| --- | --- |
| `done` | Jev chose DONE **and** a separate `done_when` check passed. A rejected DONE waits and re-decides, up to 3 times. |
| `needs_input` | A field needs a value that isn't in `values`. Nothing is invented. |
| `needs_confirmation` | The next click looks irreversible (pay, send, delete, submit). `confirm_irreversible: true` allows exactly one such click. |
| `uncertain` | Operation or target confidence was below 0.3, or DONE could not be verified. |
| `blocked` | No supported operation can progress, or 3 actions in a row changed nothing. |
| `step_budget` | `max_steps` was reached (default 40). |

**`browser_task_end`** takes `session` and `keep_tab`.

## Safety

- Model output only ever selects an observed element index. It never becomes a selector, coordinate, script, or text.
- Every input re-checks the page for freshness and for covered targets first (from jev-ultrafast).
- Page text is treated as untrusted data in every instruction.

## Verify

```bash
pnpm test      # offline: action space, request shape, answer validation, task-loop rules
pnpm verify    # live: headless Chrome + real Jev, checked against independent ground truth
```

`pnpm verify` runs:

- **Local booking fixture:** async autocomplete, native select, checkbox, async results, then open a result. Next, `needs_input` for a missing email, then `needs_confirmation` on "Confirm booking and pay", then the confirmed booking. All four scenarios share one session.
- **Real Wikipedia search.**
- **MCP stdio round trip.**

Traces go to `verify/out/`. Results are in [docs/verification.md](docs/verification.md).

## Limits

- The DOM reader covers common HTML/ARIA controls only. Shadow roots, iframes, canvas, uploads, popup tabs, and nested scrolling aren't supported; use chrome-devtools for those.
- Confidence and risk thresholds (0.3 and 0.5) are starting points, tuned on a small set of runs.
- The commit-risk check is a speculative page-level judgment ("the click that best advances the goal"), not a per-element classifier.
