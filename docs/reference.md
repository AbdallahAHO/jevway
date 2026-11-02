# Reference

Every tool, parameter, summary field, status, CLI flag, environment variable and model jevway has. For how a run works
inside, see [how-it-works.md](how-it-works.md). For the journey tools, see [journeys.md](journeys.md).

- [`jevway_task`](#jevway_task)
  - [Parameters](#parameters)
  - [The summary](#the-summary)
  - [Statuses](#statuses)
  - [Confirming an irreversible click](#confirming-an-irreversible-click)
  - [Checks](#checks)
  - [Evidence](#evidence)
  - [Secret values](#secret-values)
  - [Hosts](#hosts)
  - [Recording](#recording)
- [Output folder](#output-folder)
  - [Concise and full results](#concise-and-full-results)
- [`jevway_look`](#jevway_look)
- [`jevway_end`](#jevway_end)
- [Tool hints](#tool-hints)
- [CLI](#cli)
- [`jevway doctor`](#jevway-doctor)
- [Environment variables](#environment-variables)
- [Models](#models)
- [Limits](#limits)

## `jevway_task`

Runs a browser goal to the end, or until it needs the caller, and returns one summary. Call it again with the same
`session` to continue: the tab, history and settings carry over.

### Parameters

| Parameter | Type | What it does |
| --- | --- | --- |
| `goal` | string, required | The full outcome wanted, in plain language, with every filter and choice. |
| `url` | string | Opens this URL in a new background tab and starts a new session. |
| `tab` | string | Instead of `url`: drives an open tab whose URL contains this text (new session). |
| `session` | string | Continues a session from an earlier summary. |
| `values` | object | Text values Jev may type, by descriptive key: `{"city":"Lisbon","email":"ada@example.com"}`. Jev types nothing else. |
| `secret_keys` | string[] | Keys of `values` that hold secrets. See [Secret values](#secret-values). |
| `files` | object | Files Jev may upload, key → absolute path. Checked before the run. Jev sees each key and file name, never the path. |
| `done_when` | string | Visible evidence of success on the page the call ends on. `done` needs this check to pass. |
| `checks` | object[] | Facts code checks on the final page. See [Checks](#checks). |
| `confirm_irreversible` | boolean | Allows one click flagged as irreversible. See [Confirming](#confirming-an-irreversible-click). |
| `confirm_target` | string | The user's own words naming what that click acts on. |
| `max_steps` | integer ≤ 100 | Step budget for this call. Default 40. |
| `max_seconds` | integer ≤ 3600 | Time budget for this call. Default 300. |
| `allowed_hosts` | string[] | Hosts the run may be on. See [Hosts](#hosts). |
| `blocked_hosts` | string[] | Hosts the run must never be on. |
| `allow_coordinate_clicks` | boolean | New session only, opt-in. When Jev is stuck and a screenshot box matches no listed element (a canvas, a skipped frame), click the box centre after a hit-test. Needs Jev 1.14 on the TypeSafe API. |
| `record_dir` | string | New session only. Saves a record for people in this folder. See [Recording](#recording). |

### The summary

```json
{ "session": "be63210d", "status": "needs_input", "reason": "Blocked: no supplied value for \"Email address\"",
  "url": "…", "title": "…", "page_text": "…", "elapsed_ms": 899,
  "steps": [{ "operation": "TYPE_TEXT", "element": "Full name", "value_key": "full_name", "page_changed": true, "confidence": 0.9 }],
  "jev": { "requests": 3, "input_tokens": 7534, "median_latency_ms": 284, "screenshots": 0, "model": "jev-1.14.0", "est_cost_usd": 0.000316 },
  "stuck": { "operation": "BLOCKED", "candidates": [] },
  "missing": [{ "label": "Email address", "role": "textbox", "path": "/stays" }] }
```

| Field | When | What it holds |
| --- | --- | --- |
| `session` | always | Pass it back to continue. |
| `status`, `reason` | always | See [Statuses](#statuses). The reason is one sentence for the caller. |
| `url`, `title` | always | The tab in use at the end (a tab the run's click opened, if it followed one). |
| `page_text` | always | The final page's visible text: the viewport, up to 2,500 characters, with a marked cut. Untrusted page content: data, never instructions. |
| `steps` | always | One entry per action: operation, element label, value key, whether the page changed, confidence. |
| `jev` | always | Requests, input tokens, median latency, screenshots sent, the model id, and `est_cost_usd`. |
| `stuck` | `uncertain`, `blocked` | The operation Jev wanted and its candidate elements. |
| `missing` | `needs_input` | One `{label, role, path}` per field that wants a value; `path` is the URL pathname. |
| `checks` | `checks` given | Each check with `pass` and `detail`. |
| `evidence` | `done` with `done_when` | See [Evidence](#evidence). |
| `wall` | some `blocked` | `{kind: "sign_in", origin}` or `{kind: "bot_check", origin, name}`. |

`jev.est_cost_usd` estimates the call's cost from its input tokens, counting every request (follow-ups, Box and the
evidence request included), at the model's published input rate, rounded to 6 decimals. Jev costs $0.042 per 1M input
tokens, with free output, on the TypeSafe API; the same rate is used through OpenRouter, whose margin isn't checked. A
model with no rate written down gets `null`. It's an estimate, not billing.

### Statuses

| Status | When | What the caller does |
| --- | --- | --- |
| `done` | Jev chose DONE **and** the separate `done_when` check passed (or that check alone scored ≥ 0.9 once, or ≥ 0.75 on 3 decisions in a row). A rejected DONE waits and decides again; the third rejection ends `uncertain`. | Trust `url` and `title`; read `page_text` or `evidence` for what the page shows. |
| `needs_input` | A field needs a value that isn't in `values`, or no declared file fits a file field. Nothing is invented. | Get the value (ask the user if unknown) and call again with the same `session`. |
| `needs_confirmation` | The next click looks irreversible: pay, send, delete, submit. | Confirm only what the user asked for. See [below](#confirming-an-irreversible-click). |
| `uncertain` | Confidence was under the model's threshold (Jev: 0.3), 6 actions in a row ran under 0.5 confidence, a `check` failed, or DONE couldn't be verified. | Read `stuck` and `page_text`; rephrase `goal` on the same session, or do the step yourself. |
| `blocked` | No operation can progress; see the list below. | Read the reason. Rephrasing helps only when the page itself is fine. |
| `step_budget` | `max_steps` or `max_seconds` ran out, or the run made 2 × `max_steps` decisions without finishing. The reason says which. | Continue on the same session with a narrower goal. |

A run ends `blocked` when:

- 3 actions in a row changed nothing, the same target was covered 3 times, one action toggled the page back and forth
  4 times, or the same element was used 6 times in 7 actions;
- the page shows an error after this call acted (the reason quotes it);
- a sign-in screen blocks the goal and no supplied value fits its fields (`wall.kind: "sign_in"`);
- a bot check (Cloudflare, reCAPTCHA, hCaptcha, Turnstile, an "unusual traffic" page) didn't clear by itself within
  8 s (`wall.kind: "bot_check"`, `wall.name` one of `cloudflare`, `recaptcha`, `hcaptcha`, `turnstile`,
  `unusual-traffic`). No Jev request is spent on it, and jevway never tries to get past one;
- the run left its allowed hosts (the reason names the host);
- a click never reached the page (nothing was clicked; call again or check the browser);
- the browser or the model API failed ("Browser error: …", "Model error: …");
- the caller cancelled ("Cancelled by the caller").

Cancelling the MCP request, or Ctrl-C in the CLI, stops the run before its next step. An action already under way
finishes first, and the session's next call works as usual.

### Confirming an irreversible click

A click is flagged when Jev's commit-risk score for it is at or above 0.5. The run stops with `needs_confirmation`
before clicking, naming the control.

- Set `confirm_irreversible: true` only when the user's own request names this action and its target. "Delete the
  repository ada/scratch" covers each click that deletes it. "Tidy up unused repos" names a kind of thing, not a
  target: list the candidates and ask the user.
- One confirmation allows exactly one click, on the control the `needs_confirmation` named (same label, same page
  path). If Jev picks a different irreversible control, it is handed back as a new `needs_confirmation`.
- The flag counts only on the call that answers a `needs_confirmation`, or on a new session's first call (which has no
  flagged control yet and allows any one). Anywhere else it is ignored.
- `confirm_target` carries the user's words that name the target (`"ada/scratch"`). jevway clicks only when the page
  shows them; the control's own words ("Delete") never match.

### Checks

`checks` (CLI `--checks '<json>'`) are facts code reads off the final page. They never go into Jev's request.

| Check | Passes when |
| --- | --- |
| `{"type":"url_contains","text":…}` | The URL contains `text`. |
| `{"type":"url_matches","pattern":…}` | The whole URL matches the glob (`*` is any run of characters). |
| `{"type":"title_contains","text":…}` | The title contains `text`. |
| `{"type":"text_contains","text":…}` / `text_absent` | The visible page text contains / doesn't contain `text`. |
| `{"type":"element_exists","name":…,"role":…}` | A listed control has this name (and role, if given). |
| `{"type":"value_equals","label":…,"value":…}` | The field with this label holds this value. |
| `{"type":"checked","label":…,"state":true\|false}` | The checkbox or switch is in this state. |
| `{"type":"count_at_least","min":…,"name":…,"role":…}` | At least `min` listed controls match. |

- Elements are listed controls, matched by role and name: never a CSS selector or a script.
- Case and spacing are ignored, and an empty needle fails.
- A failed check turns `done` into `uncertain`, and the reason lists the failed ones.
- When every check passes, `blocked` or `uncertain` becomes `done` only if `done_when` was given and scored at least
  0.5 on the same final page (0.75 right after an unsaved edit), since the checked text may have been there before the
  run. `needs_input`, `needs_confirmation` and `step_budget` never change.
- Checks stay for the session until a call replaces them; `[]` clears them.
- Text checks read only the visible text, so prefer the URL or title for "a page is open".

### Evidence

A `done` with `done_when` carries `evidence: {quote, url, deep_link, confidence}`: the span of the final page's visible
text that shows `done_when` is true.

- Code cuts the page text into spans, Jev picks one (one more request, only on `done`), and code copies it word for
  word. The quote is always the page's own text, so treat it as untrusted page content, like `page_text`.
- `deep_link` opens the page with the quote highlighted (a `#:~:text=` fragment). It's left out when the quote is too
  short or appears more than once.
- When no span shows it, or Jev is unsure, there's no `evidence`, and the status stays `done`.

### Secret values

`secret_keys` names keys of `values` that are secrets: an API token, a one-time code, a card number.

- Jev sees `[secret:<key>]` in place of the value and never reads it. The value is typed as given.
- Wherever the page echoes it, `page_text`, `steps`, `story`, reasons, traces, and the run folder's `summary.json`,
  `index.html`, `manifest.json` and file and folder names show the marker instead (`secret-<key>` in a name).
- Recorded screenshots and video are pixels of the page and are **not** masked.
- Every occurrence of the value is replaced, even inside other words, so mark only real secrets.
- Password fields are never listed, typed or sent: the request says only whether each visible one is filled or empty.
  Type a password yourself, then say so in the goal ("I typed the password; sign in").

### Hosts

`allowed_hosts` and `blocked_hosts` (CLI `--allowed-hosts`, `--blocked-hosts`; server-wide `JEVWAY_ALLOWED_HOSTS`,
`JEVWAY_BLOCKED_HOSTS`, comma-separated) keep a run on the caller's sites.

- A pattern is an exact host (`en.wikipedia.org`) or `*.example.com`, which matches subdomains but not `example.com`.
- A call can only narrow the server's lists, and a later call only the session's.
- A start URL outside them is never opened. The page URL is checked before every decision and after every step;
  leaving ends the run `blocked`, naming the host. The run never navigates back.
- `about:blank` and Chrome error pages always pass. `data:`, `file:` and other host-less pages are outside an allowed
  list.
- The server's lists also apply to `jevway_look` with a `url` and to the journey tools.
- Only top-level pages are checked: the session's tab, and a tab its click opened once the run follows it. Iframes and
  the page's own requests aren't.

### Recording

`record_dir` (CLI `--record <dir>`) saves a record of the run for people in that folder:

- `run.mp4`, a screencast (needs `ffmpeg` on the PATH; skipped otherwise);
- `steps/01-type-destination.jpg`, `steps/02-select-2-guests.jpg`, …: a 2× JPEG before every action with its target
  outlined, named for the action, and `steps/NN-finished-<status>.jpg`, the final page of each call;
- `final.jpg` (the page as the latest call ended, at most 1280 px wide) and `calls/NN-<status>.jpg` (each call's);
- `summary.json`;
- `index.html`, which opens on the video with its steps on a timeline and a strip kept in sync, then the run's calls,
  reason, address and cost;
- `manifest.json`, every file with its path, kind and a one-line description.

These images never reach the model, which gets its own 1024 px screenshots. The video stays on the first tab. Through
the session service (below), `record: true` keeps the same record in the session's run folder, and `record_dir` stays
an override.

## Output folder

The session service (`src/session/session-service.ts`), which the MCP server and the CLI daemon adopt next, gives
every session a folder, whether or not it records:

```
.jevway/                                        ($JEVWAY_OUT_DIR overrides; holds a .gitignore of "*")
  runs/2026-11-02_0905_book-a-stay-in-lisbon_3f9a/
    final.jpg  calls/01-needs-input.jpg  calls/02-done.jpg  summary.json  manifest.json
    index.html  run.mp4  steps/01-type-destination.jpg …       (only with record)
  journeys/2026-11-02_0910_stays.example_8c21/
    index.html  journey.json  manifest.json  screens/s01-home.png  screens/s02-search-results.png …
```

- Folder names are local start time, a slug (the goal, or the journey's host) and the first 4 characters of the
  session id. A slug is lowercase ASCII and hyphens, at most 40 characters, and never holds a secret value.
- `final.jpg` is the viewport as the latest call ended: JPEG, at most 1280 px wide. It is pixels, so a secret typed into
  a visible field shows in it.
- `manifest.json` lists every file with its `path` (relative), `kind` and a one-line `description`, e.g.
  `steps/01-type-destination.jpg`, `step`, "Before step 1, its target outlined: Type the "destination" value into
  "Destination"". Kinds: `page`, `summary`, `video`, `screenshot`, `step`, `screen`, `journey`, `manifest`, `file`.
- `JEVWAY_JOURNEYS_DIR` replaces `.jevway/journeys` as the journeys root; a journey's `out_dir` is the exact folder.
- Session ids are full UUIDs. A session the service no longer holds answers: Unknown session "…". Sessions end
  when the server restarts (or after the daemon's idle time); start a new one with `url` (or `tab`).

### Concise and full results

A result through the session service is concise by default (`presentSummary` in `src/task/present.ts`):

```json
{ "session": "3f9a71c2-0b8e-4d6a-9c1e-5a2b7d4e8f10", "status": "needs_input",
  "reason": "No supplied value fits the field \"Phone number\"",
  "next": "Add the missing values to `values` and call again with this session.",
  "story": ["Typed the \"name\" value into \"Full name\".", "Typed the \"email\" value into \"Email address\"."],
  "url": "…", "title": "…", "page_text": "…",
  "missing": [{ "label": "Phone number", "role": "textbox", "path": "/checkout/details" }],
  "files": { "run_dir": "/abs/.jevway/runs/…_3f9a", "screenshot": "/abs/…/final.jpg", "manifest": "/abs/…/manifest.json" } }
```

- Concise: `session`, `status`, `reason`, `next`, `story`, `url`, `title`, `page_text`, and when present `missing`,
  `wall`, `checks`, `evidence`, `confirm_ignored` and `files` (`run_dir`, `screenshot`, `page`, `video`, `manifest`;
  absolute paths).
- `detail: "full"` adds `steps` (with confidences), `jev`, `stuck`, `elapsed_ms` and `done_probability`.
- `story` has one sentence per step of the call, in the recording page's words, plus what happened when that was not
  the plain outcome ("Clicked \"Open in new tab\"; a new tab opened: …").
- Progress events while a call runs: `{ "type": "started" }`, `{ "type": "step", "n", "story", "url" }` per step, and
  `{ "type": "finished", "status" }`, each with its `session`.

## `jevway_look`

Returns what a page shows now, with no model request and no input to the page. Pass exactly one of:

- `session`: that session's tab;
- `tab`: an open tab whose URL contains this text;
- `url`: opened in a background tab, read, then closed.

It returns `url`, `title`, `page_text` (cut as in the summary), the listed controls once each (`label`, `role`, and
`value`, `checked`, `selected`, `expanded` when set) and `password_fields` as filled or empty. It carries no element ids,
so nothing in it can be passed back as a target. Use it to see a page after a hand-back, or to check whether a write
already happened before repeating it.

## `jevway_end`

Takes `session` and `keep_tab`. Forgets the session and closes the tabs it opened: its first tab when it started from
`url`, and any tab its clicks opened. `keep_tab: true` leaves them open.

## Tool hints

Every tool carries MCP annotations for clients that ask before a call:

| Tool | Hints |
| --- | --- |
| `jevway_task`, `jevway_journey_step` | destructive, open-world: they can submit, pay or delete on any site |
| `jevway_journey_start`, `jevway_journey_autopilot` | open-world, not destructive |
| `jevway_look` | read-only |
| `jevway_end`, `jevway_journey_annotate`, `jevway_journey_finish` | touch only jevway's own state |

## CLI

For agents without MCP. Prints one JSON summary; the exit code is 0 only when the status is `done`.

```bash
npx -y jevway --browser launch-headless \
  --url https://en.wikipedia.org/wiki/Main_Page \
  --goal "Open the Wikipedia article about the Rosetta Stone" \
  --values '{"search_query":"Rosetta Stone"}' \
  --done-when "The Rosetta Stone article is open"
```

| Flag | Same as |
| --- | --- |
| `--goal`, `--url`, `--tab` | `goal`, `url`, `tab` |
| `--values '<json>'`, `--files '<json>'`, `--checks '<json>'` | `values`, `files`, `checks` |
| `--secret-keys a,b` | `secret_keys` |
| `--done-when` | `done_when` |
| `--max-steps`, `--max-seconds` | `max_steps`, `max_seconds` |
| `--allowed-hosts a,b`, `--blocked-hosts a,b` | `allowed_hosts`, `blocked_hosts` |
| `--allow-coordinate-clicks` | `allow_coordinate_clicks` |
| `--record <dir>` | `record_dir` |
| `--browser`, `--model`, `--screenshots` | `JEVWAY_BROWSER`, `JEVWAY_MODEL`, `JEVWAY_SCREENSHOTS` |
| `--keep-open` | leaves the tabs open at the end (`auto` and remote browsers) |

## `jevway doctor`

```bash
npx -y jevway doctor          # Node, key and route, browser, ffmpeg; exit 0 when ready
npx -y jevway doctor --plan   # the setup steps still missing, numbered
npx -y jevway doctor --live   # plus one real Jev request (a fraction of a cent)
```

`--browser <source>` and `--model <name>` check another browser or model than the configured one. It never prints a
key, and never replays recordings.

## Environment variables

jevway reads them from the environment, or from `~/.config/jevway/env` (`$XDG_CONFIG_HOME/jevway/env` when set). The
file fills only variables the environment lacks, and only the keys, `CHROME_PATH` and `JEVWAY_*`.

| Variable | Default | What it sets |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Jev on the TypeSafe API (screenshots as `assets`, Box). |
| `OPENROUTER_API_KEY` | — | Jev without the key above, and every other model, through OpenRouter. |
| `JEVWAY_BROWSER` | `auto` | `auto`, `launch`, `launch-headless` or `http://127.0.0.1:<port>`. See below. |
| `JEVWAY_MODEL` | `jev` | The decision model. See [Models](#models). |
| `JEVWAY_SCREENSHOTS` | per model | `always`, `fallback` or `off`. |
| `JEVWAY_ALLOWED_HOSTS`, `JEVWAY_BLOCKED_HOSTS` | — | Server-wide host lists, comma-separated. |
| `JEVWAY_OUT_DIR` | `./.jevway` | The session service's output root: `runs/` and `journeys/`. See [Output folder](#output-folder). |
| `JEVWAY_JOURNEYS_DIR` | `./journeys` (MCP today), `<JEVWAY_OUT_DIR>/journeys` (session service) | Where journey maps are written. |
| `JEVWAY_REPLAY`, `JEVWAY_REPLAY_DIR` | — | `record` or `replay` Jev answers in that folder (development; the folder is required). See [CONTRIBUTING.md](../CONTRIBUTING.md#live-suites). |
| `CHROME_PATH` | the usual install path | The Chrome `launch` starts. |

| `JEVWAY_BROWSER` | Uses | Setup |
| --- | --- | --- |
| `auto` | your running Chrome, the same one `chrome-devtools-mcp --auto-connect` uses | allow it at `chrome://inspect/#remote-debugging`; Chrome asks again on the first connection |
| `launch` / `launch-headless` | a throwaway profile jevway starts and closes | Chrome installed, or `CHROME_PATH` |
| `http://127.0.0.1:<port>` | a Chrome started with `--remote-debugging-port=<port>` and its own `--user-data-dir` | start it yourself; never on your everyday profile |

## Models

`JEVWAY_MODEL` (or `--model`) picks the decision model. All of them speak the same System One API through the same SDK.
With `TYPESAFE_API_KEY` set, Jev runs on the TypeSafe API as `jev-1.14.0`: screenshots go in as `assets`, and Box
questions are available. Everything else, and Jev without that key, goes through OpenRouter, which drops the `assets`
map, so Box runs only on the direct route.

| `JEVWAY_MODEL` | Model id | Screenshots | Results |
| --- | --- | --- | --- |
| `jev` (default) | `jev-1.14.0` (TypeSafe API) / `typesafe/jev-1.14` (OpenRouter) | `fallback` | `pnpm verify` 7/7 with screenshots, 6/6 without; journeys 8/8; about 240 ms per request |
| `pplx-decider` | `perplexity/pplx-decider-v1.1-27b` | `always` | `pnpm verify` 6/6; journeys 8/8; 0.4–1.3 s per request |
| `clef-omni` | `cloudflare/clef-omni` | `always` | `pnpm verify` 4/6 (3/6 without screenshots); journeys 7/8 |
| `clef` | `cloudflare/clef` | none (an image costs 16k tokens) | `pnpm verify` 6/6; 0.7–1.2 s per request |
| `clef-flash` | `cloudflare/clef-flash` | `always` | `pnpm verify` 1/6 |
| `gpt-6-luna` | `openai/gpt-6-luna-decisions` | `always` | `pnpm verify` 0–1/6: the API refuses target questions (502) |

Jev 1.14 is the fastest model that passes everything, and it reads screenshots. Perplexity's decider also passes with
screenshots, but slower. Clef passes text-only, and slower still.

The full runs, per-model thresholds and rules are in
[verification.md](verification.md#decision-models-on-openrouter-2026-10-11).

`JEVWAY_SCREENSHOTS` controls screenshots for the vision models:

- `always`: on every step.
- `fallback`: only when a text-only decision would stop as uncertain or blocked, has its DONE rejected, or follows an
  action that changed nothing.
- `off`: never.

Each listed element is drawn on the image as a numbered box from the snapshot's own rects; covered elements get none,
and the overlay is removed before any input. The model still only selects listed ids.

## Limits

**What it reads.** Common HTML and ARIA controls, including inside open shadow roots and iframes (same-origin and
cross-origin, up to 10 frames, 3 levels deep). Also sortable column headers, pointer-cursor items inside open popups,
contenteditable search bars, and table rows by their visible text.

**What it can't read.** Closed shadow roots, canvas, and file inputs inside iframes. A frame is skipped when it shows
less than 16×16 px, sits outside an open modal, is still blank, or takes over 1.5 s to read. Box can see canvas controls
and skipped frames, and click them with `allow_coordinate_clicks`; otherwise use chrome-devtools. CSS-transformed
iframes are placed as if untransformed.

**Scrolling.** Only on-screen elements are listed, and Jev scrolls to reveal more. When the document doesn't scroll (an
app shell), the scroll goes to the largest visible pane that does; inside an iframe, scrolling stays page-level. An
off-screen link, button or row containing one of the supplied `values` is listed anyway, and scrolled into view when
clicked. An element whose centre is off-screen is clicked at the centre of its visible part.

**Tabs.** A tab the session's own click opens is followed; when it closes, the run moves to the newest still-open tab it drove. Tabs anyone else
opens are never touched. A dialog the new tab raises before it's set up freezes it; following fails after 5 s and the
run ends `blocked`. In `auto` mode Chrome shows the new tab in front.

**Uploads.** Only files declared in `files`, never a path from `values`. File inputs are listed only then, hidden ones
through their label or styled button, and a native file picker is intercepted.

**Risk scores.** Confidence thresholds (per model, in `src/jev/model.ts`) and the 0.5 risk threshold were tuned on a
small set of runs. A click scoring 0.25–0.5 on risk gets a screenshot look first, but only with screenshots on. With
screenshots `off`, text alone under-reads some checkout pages (a bare "Continue" can score under 0.5), so keep them on
when a task can reach a payment step.
