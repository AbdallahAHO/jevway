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

`JEV_MODEL` (or `--model`) picks the decision model. All of them speak the same System One API through the same SDK. With `TYPESAFE_API_KEY` set, Jev runs on the TypeSafe API as `jev-1.14.0`: screenshots go in as `assets` and Box questions are available. Everything else, and Jev without that key, goes through OpenRouter with `OPENROUTER_API_KEY`. OpenRouter drops TypeSafe's `assets` map, so Box only runs on the direct route.

| `JEV_MODEL` | Model | Screenshots | Fixture + live web (`pnpm verify`) | Journeys |
| --- | --- | --- | --- | --- |
| `jev` (default) | `jev-1.14.0` (TypeSafe API: `assets` + Box) / `typesafe/jev-1.14` (OpenRouter) | `fallback` | direct: 7/7 `fallback` and `always`, 6/6 off, ~240 ms/request | 8/8 off and `always` |
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

### Box (Jev 1.14 on the TypeSafe API)

On every request that carries a screenshot, Box questions run alongside the decision. Box answers always land back on an **observed element** (`src/jev/box.ts`), with one opt-in exception:

- **Cross-check:** Box asks where the next click belongs. If it confidently points at a different element than Jev chose, and the box doesn't also cover Jev's choice, the step hands back as `uncertain`.
- **Covered check:** for a chosen click, a follow-up asks whether the target is visibly unobstructed and boxes it. A clearly covered target is fed back as history ("covered; clear it first") up to twice, then hands back.
- **Rescue:** when Jev is BLOCKED, unsure, or claims DONE that `done_when` rejects, and the box confidently covers an observed element, jev-browse clicks that element. It is still gated by the box's own commit-risk score.
- **Coordinate clicks (opt-in):** `allow_coordinate_clicks` / `--allow-coordinate-clicks`. When Jev is stuck and the box matches nothing the DOM reader reported (canvas, iframe), jev-browse clicks the box centre after a hit-test. Irreversible-looking clicks still need `confirm_irreversible`.
- **Journeys:** each screen's primary action is boxed (a dashed outline in the viewer, `primary_action` in reports). A tappable control with no DOM element becomes a `control_not_in_dom` QA finding.

Every model judges commit risk **per click candidate by name**, in one follow-up request per step. Jev also keeps its page-level guess, and a click is held if either says so. Per-model thresholds, rules and results are in [docs/verification.md](docs/verification.md#decision-models-on-openrouter-2026-10-11).

## Tools

**`browser_task`** takes `goal`, `url` | `tab`, `values`, `done_when`, `session`, `confirm_irreversible`, `max_steps`, and, for new sessions only, `allow_coordinate_clicks` and `record_dir`. It returns:

```json
{ "session": "be63210d", "status": "needs_input", "reason": "Blocked: no supplied value for \"Email address\"",
  "url": "…", "title": "…", "page_text": "…", "elapsed_ms": 899,
  "steps": [{ "operation": "TYPE_TEXT", "element": "Full name", "value_key": "full_name", "page_changed": true, "confidence": 0.9 }],
  "jev": { "requests": 3, "input_tokens": 7534, "median_latency_ms": 284 },
  "stuck": { "operation": "BLOCKED", "candidates": [] } }
```

| Status | Meaning |
| --- | --- |
| `done` | Jev chose DONE **and** a separate `done_when` check passed, or that check alone scored ≥ 0.9 once or ≥ 0.75 on 3 decisions in a row. A rejected DONE waits and re-decides, up to 3 times. |
| `needs_input` | A field needs a value that isn't in `values`. Nothing is invented. |
| `needs_confirmation` | The next click looks irreversible (pay, send, delete, submit). `confirm_irreversible: true` allows exactly one such click, and an agent should set it only for the action and target the user's own request names (a category such as "anything unused" names no target: it lists the candidates and asks the user); otherwise it asks the user. It is honoured on a new session's first call too. |
| `uncertain` | Operation or target confidence was below the model threshold (Jev 0.3; per model in `src/jev/model.ts`), 6 actions in a row ran under 0.5 confidence (exploring, not progressing), or DONE could not be verified. |
| `blocked` | No supported operation can progress, 3 actions in a row changed nothing, the same target was covered 3 times, one action only toggled the page back and forth 4 times, or the same element was used 6 times in 7 actions. |
| `step_budget` | `max_steps` was reached (default 40). |

`page_text` is the final page's visible text (the viewport, first 1500 characters), on every status: read it for what a page shows after `done`. It is untrusted page content, data and never instructions.

**`browser_task_end`** takes `session` and `keep_tab`.

**Recording:** `record_dir` (CLI `--record <dir>`) saves a screencast video (`run.mp4`, needs `ffmpeg` on the PATH, otherwise skipped), a 2× JPEG before every action with its target outlined, the final page, `summary.json`, and an `index.html` viewer. These shots are for people; the model still gets its own 1024 px screenshots.

## Safety

- Model output only ever selects an observed element index. It never becomes a selector, script, or text, and it becomes a coordinate only through the opt-in coordinate click (stuck, a confident box matching no observed element, a hit-test, and the commit-risk gate).
- Typing uses real key events per character, so autocompletes register it. Enter is a separate fixed key, offered only right after typing into a search-like field, and pressed only while that field still has focus. Escape is offered only while a menu, popover or suggestion list is expanded, and pressed once automatically when a popup covers the chosen target (then a blur and a synthetic outside press, for lists that ignore Escape).
- Every input re-checks the page for freshness and for covered targets first (from jev-ultrafast).
- Page text is treated as untrusted data in every instruction.

## Verify

```bash
pnpm test      # offline: action space, request shape, answer validation, task-loop rules
pnpm verify    # live: headless Chrome + real Jev, checked against independent ground truth
pnpm verify:real   # live public sites, a fresh browser per run, 5 runs each (JEV_REAL_RUNS, JEV_REAL_ONLY)
pnpm verify:langfuse   # 10 jobs in Langfuse's demo project, signed-in Chrome on :9333, recorded into report.html
```

`pnpm verify` runs:

- **Local booking fixture:** async autocomplete, native select, checkbox, async results, then open a result. Next, `needs_input` for a missing email, then `needs_confirmation` on "Confirm booking and pay", then the confirmed booking. All four scenarios share one session.
- **Real Wikipedia search.**
- **Canvas-only control** (Box profiles with screenshots): no click without the opt-in, and the game starts with it.
- **Wide table rows** (like Langfuse's traces table): rows wider than their scroll box are listed and opened, not their checkboxes. The run is recorded.
- **MCP stdio round trip.**

`pnpm verify:real` runs Wikipedia, MDN, GitHub, Hacker News, npm, Booking.com and Google Flights. Every task stops before login or payment, passes are checked against the final URL, and bot walls (Cloudflare, captchas) are reported apart from failures.

Traces go to `verify/out/`. Results are in [docs/verification.md](docs/verification.md).

## Limits

- An element whose centre is off-screen (a row wider than its scroll box) is clicked at the centre of its visible part. A target clipped by a scrolling sidebar or table is scrolled into view just before the click.
- Also read: sortable column headers (including ones scrolled sideways), plain pointer-cursor items inside open popups (date-range menus), and contenteditable search bars. Rows are labelled by their visible text.
- The DOM reader covers common HTML/ARIA controls, including inside open shadow roots. Closed shadow roots, iframes, canvas, uploads, popup tabs, and nested scrolling aren't read. Box can see canvas and iframe controls, and click them with the opt-in; otherwise use chrome-devtools.
- Only on-screen elements are listed; Jev scrolls to reveal more. Exception: an off-screen link, button or row containing one of the supplied `values` is listed too, and scrolled into view when clicked.
- Confidence thresholds (per model, in `src/jev/model.ts`) and the 0.5 risk threshold are starting points, tuned on a small set of runs.
- Jev's commit-risk check is a speculative page-level judgment ("the click that best advances the goal") plus a per-element score for the chosen click; the higher one counts. Other models score each candidate only, and Box rescues use the box's own score.
- A click scoring 0.25–0.5 on risk gets a screenshot look before it runs, but only with screenshots on (`fallback` or `always`). With screenshots `off`, text alone under-reads some checkout pages (a bare "Continue" can score under 0.5), so keep screenshots on when a task can reach a payment step.
