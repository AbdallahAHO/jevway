# jev-browse

Give your coding agent a browser goal. [TypeSafe Jev](https://docs.typesafe.ai) picks each click, type, and select in about 300 ms, and the agent gets back **one short summary** instead of making every decision itself.

```text
agent ──browser_task(goal, values, done_when)──▶ jev-browse ──one Jev request per step──▶ Chrome
agent ◀── { status, url, steps, stuck? } ───────┘            (same Chrome chrome-devtools inspects)
```

The only thing it needs is `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Other decision models, some of which read screenshots, are described [below](#models). No second LLM is involved: the agent passes the text values it already knows, and Jev *selects* which value goes into which field (a speculative `value_for_<field>` head in the same request).

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

## Models

`JEV_MODEL` (or `--model`) picks the decision model. All of them speak the same System One API through the same SDK. Jev uses the TypeSafe API when `TYPESAFE_API_KEY` is set. Everything else, and Jev without that key, goes through OpenRouter with `OPENROUTER_API_KEY`.

| `JEV_MODEL` | Model | Screenshots | Fixture + live web (`pnpm verify`) | Journeys |
| --- | --- | --- | --- | --- |
| `jev` (default) | `typesafe/jev-1.14` (OpenRouter) / `jev-latest` (TypeSafe API, text-only) | `fallback` | 6/6 off and `fallback`, 5–6/6 `always`, ~250 ms/request | 8/8 off and `always` |
| `pplx-decider` | `perplexity/pplx-decider-v1.1-27b` | `always` | 6/6 off and `always`, 0.4–1.3 s/request | 8/8 |
| `clef-omni` | `cloudflare/clef-omni` | `always` | 4/6 (3/6 off) | 7/8 (8/8 off) |
| `clef` | `cloudflare/clef` | none (images cost 16k tokens) | 6/6, 0.7–1.2 s/request | — |
| `clef-flash` | `cloudflare/clef-flash` | `always` | 1/6 | — |
| `gpt-6-luna` | `openai/gpt-6-luna-decisions` | `always` | 0–1/6: OpenAI refuses target questions (502) | — |

**Jev 1.14 is the fastest model that passes everything, and it reads screenshots. Perplexity's decider also passes everything with screenshots, but slower. Clef passes text-only, and is slower still.**

`JEV_SCREENSHOTS` (or `--screenshots`) controls screenshots for the vision models:

- `always`: on every step.
- `fallback`: only when a text-only decision would stop as uncertain or blocked, has its DONE rejected, or follows an action that changed nothing.
- `off`: never.

Journeys send one with each screen's judgments whenever the mode isn't `off`. Each observed element index is drawn on the image as a numbered box, taken from the snapshot's own rects. Covered elements get no box, and the overlay is removed before any input. The model still only selects observed ids.

Every model except Jev judges commit risk **per click candidate by name**, in one follow-up request per step, instead of Jev's single page-level guess. Per-model thresholds, rules and results are in [docs/verification.md](docs/verification.md#decision-models-on-openrouter-2026-10-11).

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
| `uncertain` | Operation or target confidence was below the model threshold (Jev 0.3; per model in `src/jev/model.ts`), or DONE could not be verified. |
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
- Confidence thresholds (per model, in `src/jev/model.ts`) and the 0.5 risk threshold are starting points, tuned on a small set of runs.
- The commit-risk check is a speculative page-level judgment ("the click that best advances the goal"), not a per-element classifier.
