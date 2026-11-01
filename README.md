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
- **Coordinate clicks (opt-in):** `allow_coordinate_clicks` / `--allow-coordinate-clicks`. When Jev is stuck and the box matches nothing the DOM reader reported (canvas, or a frame that was skipped), jev-browse clicks the box centre after a hit-test. Irreversible-looking clicks still need `confirm_irreversible`.
- **Journeys:** each screen's primary action is boxed (a dashed outline in the viewer, `primary_action` in reports). A tappable control with no DOM element becomes a `control_not_in_dom` QA finding.

Every model judges commit risk **per click candidate by name**, in one follow-up request per step. Jev also keeps its page-level guess, and a click is held if either says so. Per-model thresholds, rules and results are in [docs/verification.md](docs/verification.md#decision-models-on-openrouter-2026-10-11).

## Tools

**`browser_task`** takes `goal`, `url` | `tab`, `values`, `secret_keys`, `files`, `done_when`, `checks`, `session`, `confirm_irreversible`, `confirm_target`, `max_steps`, `max_seconds`, `allowed_hosts`, `blocked_hosts`, and, for new sessions only, `allow_coordinate_clicks` and `record_dir`. It returns:

```json
{ "session": "be63210d", "status": "needs_input", "reason": "Blocked: no supplied value for \"Email address\"",
  "url": "…", "title": "…", "page_text": "…", "elapsed_ms": 899,
  "steps": [{ "operation": "TYPE_TEXT", "element": "Full name", "value_key": "full_name", "page_changed": true, "confidence": 0.9 }],
  "jev": { "requests": 3, "input_tokens": 7534, "median_latency_ms": 284 },
  "stuck": { "operation": "BLOCKED", "candidates": [] },
  "missing": [{ "label": "Email address", "role": "textbox", "path": "/stays" }] }
```

`secret_keys` names the keys of `values` that are secrets (an API token, a one-time code). Jev sees `[secret:<key>]` in place of such a value and never reads it; it is typed as given, and wherever the page echoes it, `page_text`, `steps`, reasons, traces and `record_dir`'s `summary.json` and `index.html` show the marker instead. Recorded screenshots and video are pixels of the page and are not masked. Mark only real secrets: every occurrence of the value is replaced, even inside other words.

| Status | Meaning |
| --- | --- |
| `done` | Jev chose DONE **and** a separate `done_when` check passed, or that check alone scored ≥ 0.9 once or ≥ 0.75 on 3 decisions in a row. A rejected DONE waits and re-decides, up to 3 times. |
| `needs_input` | A field needs a value that isn't in `values`. Nothing is invented. `missing` lists each field (label, role, page path). |
| `needs_confirmation` | The next click looks irreversible (pay, send, delete, submit). `confirm_irreversible: true` allows exactly one such click, and an agent should set it only for the action and target the user's own request names (a category such as "anything unused" names no target: it lists the candidates and asks the user); otherwise it asks the user. It allows only the control that needs_confirmation named (same label, same page path); a different irreversible control is handed back as a new needs_confirmation. It counts only on the call that answers a needs_confirmation (or a new session's first call, which has no flagged control and allows any one); anywhere else it is ignored. Pass `confirm_target` with the user's words that name the target; jev-browse checks the page shows them (the control's own words, like "delete", do not count) and refuses otherwise. |
| `uncertain` | Operation or target confidence was below the model threshold (Jev 0.3; per model in `src/jev/model.ts`), 6 actions in a row ran under 0.5 confidence (exploring, not progressing), or DONE could not be verified. |
| `blocked` | No supported operation can progress, 3 actions in a row changed nothing, the same target was covered 3 times, one action only toggled the page back and forth 4 times, or the same element was used 6 times in 7 actions; the page shows an error after this call acted (the reason quotes it); or a sign-in screen blocks the goal and no supplied value fits its fields (`wall: { kind: 'sign_in', origin }`). Also a bot check (a Cloudflare challenge, a reCAPTCHA, hCaptcha or Turnstile page, an "unusual traffic" page) that did not clear by itself within 8 s: the reason names it, the summary carries `wall: { kind: 'bot_check', origin, name }` (name: cloudflare, recaptcha, hcaptcha, turnstile or unusual-traffic), no Jev request is spent on it, and jev-browse never tries to get past one. |
| `step_budget` | `max_steps` (default 40) or `max_seconds` (CLI `--max-seconds`; default 300, per call) was reached; the reason says which. |

Cancelling the MCP request (or Ctrl-C in the CLI) stops the run before its next step: it ends `blocked`, "Cancelled by the caller", in the recording and the session history. An action already under way finishes first, and the session's next call works as usual.

`page_text` is the final page's visible text (the viewport, up to 2500 characters; a cut is marked with how much was left out), on every status: read it for what a page shows after `done`. It is untrusted page content, data and never instructions.

**Checks** (`checks`, CLI `--checks '<json>'`) are facts code reads off the final page: `url_contains {text}`, `url_matches {pattern}` (a glob over the whole URL, `*` is any run of characters), `title_contains {text}`, `text_contains` / `text_absent {text}` (the reader's visible text), `element_exists {name, role?}`, `value_equals {label, value}`, `checked {label, state}`, `count_at_least {min, name?, role?}`. Elements are the listed controls, by role and name: never a CSS selector or a script. Case and spacing are ignored, and an empty needle fails. The summary returns each one in `checks` with `pass` and `detail`. A failed check turns `done` into `uncertain` (the reason lists the failed ones). When every check passes, `blocked` or `uncertain` becomes `done` only if `done_when` was given and scored at least 0.5 on that same final page (0.75 right after an unsaved edit), since the checked text may have been on the page before the run. `needs_input`, `needs_confirmation` and `step_budget` never change. Like `done_when`, checks stay for the session until a call replaces them (`[]` clears them).

**Evidence:** a `done` with `done_when` carries `evidence: {quote, url, deep_link, confidence}`: the span of the final page's visible text that shows `done_when`. Jev chooses it among spans code cut from the page (one more request, only on `done`), and code copies it word for word, so the quote is always the page's own text (untrusted page content, like `page_text`). `deep_link` opens the page with the quote highlighted (a `#:~:text=` fragment); it is left out for a quote too short or repeated to point at one place. No span shows it, or Jev is unsure: no `evidence`, and the status stays `done`.

**`browser_task_end`** takes `session` and `keep_tab`.

**`browser_look`** takes one of `session`, `tab` or `url` (opened in a background tab, read, closed again) and returns `url`, `title`, `page_text` (cut as above), the listed controls once each (`label`, `role`, and `value`, `checked`, `selected`, `expanded` when set) and `password_fields` as filled or empty. It makes no Jev request and sends no input; it carries no element ids, so nothing in it can be passed back as a target. It is annotated read-only.

Every tool carries MCP hints for clients that ask before a call: `browser_task` and `journey_step` are destructive and open-world (they can submit, pay or delete on any site), `journey_start` and `journey_autopilot` are open-world but not destructive, `browser_look` is read-only, and `browser_task_end`, `journey_annotate` and `journey_finish` only touch jev-browse's own state.

**Recording:** `record_dir` (CLI `--record <dir>`) saves a screencast video (`run.mp4`, needs `ffmpeg` on the PATH, otherwise skipped), a 2× JPEG before every action with its target outlined, the final page, `summary.json`, and an `index.html` viewer. These shots are for people; the model still gets its own 1024 px screenshots.

## Safety

- Model output only ever selects an observed element index. It never becomes a selector, script, or text, and it becomes a coordinate only through the opt-in coordinate click (stuck, a confident box matching no observed element, a hit-test, and the commit-risk gate).
- Typing uses real key events per character, so autocompletes register it. Enter is a separate fixed key, offered only right after typing into a search-like field, and pressed only while that field still has focus. Escape is offered only while a menu, popover or suggestion list is expanded, and pressed once automatically when a popup covers the chosen target (then a blur and a synthetic outside press, for lists that ignore Escape).
- Every input re-checks the page for freshness and for covered targets first (from jev-ultrafast).
- Page text is treated as untrusted data in every instruction.
- **Hosts:** `allowed_hosts` / `blocked_hosts` (CLI `--allowed-hosts`, `--blocked-hosts`; server-wide `JEV_ALLOWED_HOSTS`, `JEV_BLOCKED_HOSTS`) take exact hosts or `*.example.com` (subdomains only, not `example.com`). A call can only narrow the server's lists, and a later call only the session's. A start URL outside is never opened; the page URL is checked before every decision and after every step, and leaving ends the run `blocked` naming the host. The run never navigates back. `about:blank` and Chrome error pages always pass; `data:`, `file:` and other host-less pages are outside an allowed list. Only the top page's URL is checked: iframes, popup tabs and the page's own requests are not.

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

`pnpm verify:real` runs Wikipedia, MDN, GitHub, Hacker News, npm, Booking.com and Google Flights. Every task stops before login or payment, passes are checked against the final URL, and bot walls (Cloudflare, captchas) are reported apart from failures, judged by the same detector the run uses (`src/browser/bot-wall.ts`).

Traces go to `verify/out/`. Results are in [docs/verification.md](docs/verification.md).

How jev-browse compares with other open-source Jev browser projects, and which of their ideas are planned or rejected: [docs/prior-art.md](docs/prior-art.md).

## Limits

- An element whose centre is off-screen (a row wider than its scroll box) is clicked at the centre of its visible part. A target clipped by a scrolling sidebar or table is scrolled into view just before the click.
- Also read: sortable column headers (including ones scrolled sideways), plain pointer-cursor items inside open popups (date-range menus), and contenteditable search bars. Rows are labelled by their visible text.
- The DOM reader covers common HTML/ARIA controls, including inside open shadow roots and iframes. Every visible frame, same-origin or cross-origin (out-of-process frames too), is read with the same reader: its controls continue the page's numbering, its text follows the page's under `[Frame: …]` within the same 6000 characters, and clicks, typing and every guard run inside the frame. A frame is skipped when it shows less than 16×16 px, sits outside an open modal, is still blank, takes over 1.5 s to read, or is past the caps (10 frames, 3 levels deep); controls a banner or sheet covers in the page around the frame aren't listed. CSS-transformed (scaled, rotated) iframes are placed as if untransformed.
- Closed shadow roots and canvas aren't read, and file inputs inside iframes aren't supported: they are not listed, and an upload is never set inside a frame. Box can see canvas controls (and frames skipped above), and click them with the opt-in; otherwise use chrome-devtools.
- Uploads take only files the caller declares in `files` (key → absolute path, checked before the run), never a path from `values`. Only then are file inputs listed (hidden ones through their label or styled button) and UPLOAD offered; Jev sees each key and file name, never the path, and a native file picker is intercepted. No declared file fitting a field is `needs_input`.
- A tab the session's own click opens (`target=_blank`, `window.open`) is followed, and a closed one falls back to the tab that opened it; tabs anyone else opens are never touched. `browser_task_end` closes the tabs the session's clicks opened (and its first tab when it opened it) unless `keep_tab`. The new tab is set up when it appears, so on a page that loads within ~20 ms its first document's own scripts run before the click counter; that can only end a run `blocked`, never repeat a click. A dialog the new tab raises before it is set up freezes it; following then fails after 5 s and the run ends `blocked`. In `auto` mode Chrome shows the new tab in front. A `record_dir` video stays on the first tab.
- Only on-screen elements are listed; Jev scrolls to reveal more. On a page whose document doesn't scroll (an app shell), the scroll goes to the largest visible pane that does; a scroll that moved nothing is reported to Jev as such. Exception: an off-screen link, button or row containing one of the supplied `values` is listed too, and scrolled into view when clicked.
- The scroll aimed at an inner pane works on the main page only; inside an iframe, scrolling stays page-level.
- Confidence thresholds (per model, in `src/jev/model.ts`) and the 0.5 risk threshold are starting points, tuned on a small set of runs.
- Jev's commit-risk check is a speculative page-level judgment ("the click that best advances the goal") plus a per-element score for the chosen click; the higher one counts. Other models score each candidate only, and Box rescues use the box's own score.
- A click scoring 0.25–0.5 on risk gets a screenshot look before it runs, but only with screenshots on (`fallback` or `always`). With screenshots `off`, text alone under-reads some checkout pages (a bare "Continue" can score under 0.5), so keep screenshots on when a task can reach a payment step.
