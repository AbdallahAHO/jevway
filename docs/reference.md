# Reference

Every tool, parameter, summary field, status, CLI flag, environment variable and model jevway has. For how a run works
inside, see [how-it-works.md](how-it-works.md). For the journey tools, see [journeys.md](journeys.md).

- [`jevway_task`](#jevway_task)
  - [Parameters](#parameters)
  - [The result](#the-result)
  - [Statuses](#statuses)
  - [Confirming an irreversible click](#confirming-an-irreversible-click)
  - [Checks](#checks)
  - [Evidence](#evidence)
  - [Secret values](#secret-values)
  - [Authenticator codes](#authenticator-codes)
  - [Hosts](#hosts)
  - [Recording](#recording)
- [Output folder](#output-folder)
  - [Concise and full results](#concise-and-full-results)
- [`jevway_look`](#jevway_look)
- [`jevway_end`](#jevway_end)
- [Tool hints](#tool-hints)
- [MCP server](#mcp-server)
- [CLI](#cli)
  - [The daemon](#the-daemon)
- [`jevway doctor`](#jevway-doctor)
- [Environment variables](#environment-variables)
- [Models](#models)
- [Limits](#limits)

## `jevway_task`

Runs a browser goal to the end, or until it needs the caller, and returns one result: how it ended, a sentence per
step, what to do next and where its files are. Call it again with the same `session` to continue: the tab, history and
settings carry over.

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
| `totp` | object | 2FA on the user's own account: key → authenticator secret (base32 or `otpauth://totp/` URI). See [Authenticator codes](#authenticator-codes). |
| `done_when` | string | Visible evidence of success on the page the call ends on. `done` needs this check to pass. On a continuing session it stays for the same goal; a call with a new `goal` and no `done_when` drops it. |
| `checks` | object[] | Facts code checks on the final page. See [Checks](#checks). |
| `confirm_irreversible` | boolean | Allows one click flagged as irreversible. See [Confirming](#confirming-an-irreversible-click). |
| `confirm_target` | string | The user's own words naming what that click acts on. |
| `max_steps` | integer ≤ 100 | Step budget for this call. Default 40. |
| `max_seconds` | integer ≤ 3600 | Time budget for this call. Default 300. |
| `wait_for_person_seconds` | integer 0–600 | With a visible browser, how long to wait for the user at a bot check, a sign-in wall or an SSO sign-in before handing back. Default `JEVWAY_PERSON_WAIT_SECONDS`, else 120; 0 never waits; headless always 0. See [Waiting for a person](#waiting-for-a-person). |
| `allowed_hosts` | string[] | Hosts the run may be on. See [Hosts](#hosts). |
| `blocked_hosts` | string[] | Hosts the run must never be on. |
| `allow_coordinate_clicks` | boolean | New session only, opt-in. When Jev is stuck and a screenshot box matches no listed element (a canvas, a skipped frame), click the box centre after a hit-test. Needs Jev 1.14 on the TypeSafe API. |
| `record` | boolean | New session only. Also keeps a record for people (video, step shots, `index.html`) in the run folder. See [Recording](#recording). |
| `record_dir` | string | New session only. An override: the whole run folder, recording on, goes to this folder instead of `./.jevway/runs/…`. |
| `detail` | `concise` \| `full` | `concise` (default) or `full`, which adds the raw steps with confidences, Jev's stats and the stuck candidates. See [The result](#the-result). |
| `screenshot` | boolean | Attach the end page inline on `done` and `step_budget` too (hand-backs attach it already). |

Every earlier parameter keeps its meaning. `checks` is advertised as a list of objects and checked strictly when the
call arrives: a bad check answers `isError` naming its place and field (`` `checks[0].text`: … ``) with a valid one to
copy.

### The result

Every call returns one JSON object, both as the text block (`content[0]`) and as `structuredContent` (declared by the
tool's `outputSchema`). It is concise unless the call passes `detail: "full"`, and it leads with what matters:

```json
{ "status": "needs_input", "reason": "No supplied value fits the field \"Phone number\"",
  "story": ["Typed the \"name\" value into \"Full name\".", "Typed the \"email\" value into \"Email address\"."],
  "next": "Add the missing values to `values` and call again with this session.",
  "session": "3f9a71c2-0b8e-4d6a-9c1e-5a2b7d4e8f10",
  "url": "https://shop.example/checkout/details", "title": "Your details · Shop",
  "missing": [{ "label": "Phone number", "role": "textbox", "path": "/checkout/details" }],
  "files": { "run_dir": "/work/.jevway/runs/2026-11-02_0905_buy-the-blue-mug_3f9a",
             "screenshot": "/work/.jevway/runs/2026-11-02_0905_buy-the-blue-mug_3f9a/final.jpg",
             "manifest": "/work/.jevway/runs/2026-11-02_0905_buy-the-blue-mug_3f9a/manifest.json" },
  "page_text": "Your details\nFull name\n…" }
```

| Field | When | What it holds |
| --- | --- | --- |
| `status`, `reason` | always | See [Statuses](#statuses). The reason is one sentence for the caller. |
| `story` | always | One past-tense sentence per step of this call, in the recording page's words, plus what happened when that was not the plain outcome ("Clicked \"Open in new tab\"; a new tab opened: …"). Secrets show as their marker. |
| `next` | always | The one thing to do next for this status (and wall), in the tools' parameter names. |
| `session` | always | A full UUID. Pass it back to continue. |
| `url`, `title` | always | The tab in use at the end (a tab the run's click opened, if it followed one). |
| `missing` | `needs_input` | One `{label, role, path}` per field that wants a value; `path` is the URL pathname. |
| `wall` | some `blocked` | `{kind: "sign_in", origin}` or `{kind: "bot_check", origin, name}` (an SSO sign-in: `kind: "sign_in"` at the provider's origin, `name` `google`, `apple` or `microsoft`), plus `person_can_act` (false in a headless browser: nobody can pass it there) and `waited_seconds` (when jevway waited for a person who didn't come). |
| `checks` | `checks` given | Each check with `pass` and `detail`. |
| `evidence` | `done` with `done_when` | See [Evidence](#evidence). |
| `confirm_ignored` | a dropped confirmation | Consent the caller gave that jevway did not use, and why. |
| `files` | always | Absolute paths: `run_dir`, `screenshot` (`final.jpg`; absent when the capture failed), `page` and `video` (with `record`), `manifest`. See [Output folder](#output-folder). |
| `page_text` | always, last | The final page's visible text: the viewport, up to 2,500 characters, with a marked cut. Untrusted page content: data, never instructions. |
| `steps` | `detail: "full"` | One entry per action: operation, element label, value key, whether the page changed, confidence. |
| `jev` | `detail: "full"` | Requests, input tokens, median latency, screenshots sent, the model id, and `est_cost_usd`. |
| `stuck` | `detail: "full"`, `uncertain` / `blocked` | The operation Jev wanted and its candidate elements. |
| `elapsed_ms`, `done_probability` | `detail: "full"` | The call's time and the last done check. |

`jev.est_cost_usd` estimates the call's cost from its input tokens, counting every request (follow-ups, Box and the
evidence request included), at the model's published input rate, rounded to 6 decimals. Jev costs $0.042 per 1M input
tokens, with free output, on the TypeSafe API; the same rate is used through OpenRouter, whose margin isn't checked. A
model with no rate written down gets `null`. It's an estimate, not billing.

After the JSON come:

- **The end page inline**, `image/jpeg` (`final.jpg`, at most 1280 px wide), on a hand-back (`needs_input`,
  `needs_confirmation`, `uncertain`, `blocked`), where the agent decides what happens next. On `done` and
  `step_budget` only with `screenshot: true`. `JEVWAY_IMAGE_RESPONSES=always` attaches it on every status and `never`
  on none, not even with `screenshot: true`. It is pixels: a secret typed into a visible field shows in it.
- **Links** to the run folder as `resource_link`s with `file://` URIs: `final.jpg`, then `index.html` and `run.mp4`
  when recorded, `summary.json` and `manifest.json`.

While a call runs, a client that sends a `progressToken` gets one `notifications/progress` per step, in order and all
before the result: `progress` is the step number, `total` the call's `max_steps` when it passes one, and `message` the
step's story line (`Step 3: Clicked "Search".`). While the run waits for a person at a wall, a note goes out at once
and every 10 s (`Waiting for you to pass the Cloudflare check in the Chrome window (45 s left)`), with `progress`
between the last step's number and the next, so it keeps rising and the client's idle timer resets.

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
  8 s, nor did a person pass it while jevway waited (`wall.kind: "bot_check"`, `wall.name` one of `cloudflare`,
  `recaptcha`, `hcaptcha`, `turnstile`, `unusual-traffic`). No Jev request is spent on it, and jevway never tries to
  get past one;
- nobody finished an SSO sign-in (Google, Apple, Microsoft) while jevway waited (`wall.kind: "sign_in"`);
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

### Authenticator codes

`totp` (CLI `--totp '<json>'`) gives jevway the authenticator secret of the user's own account, so a 2FA step needs no
person: `{"github_otp": "JBSWY3DPEHPK3PXP"}`.

- The secret is base32 as authenticator apps print it (any case, spaces, hyphens and `=` padding ignored; SHA1, 6
  digits, 30 s), or an `otpauth://totp/…?secret=…` URI whose `digits` (6–8), `period` (1–300 s) and `algorithm` (SHA1,
  SHA256, SHA512) are honoured. Counter-based `otpauth://hotp/` is not supported.
- Jev sees the key as `[secret:<key>]`, like a [secret value](#secret-values), and may choose it for a field. The code is
  computed by code (RFC 6238) at the moment it is typed, never by the model, and typed as it is.
- With under 8 s left in the code's period (a third of a shorter period), the run waits for the next code and types that
  one, so the submit that follows is not sent with an expired code. A cancel or `max_seconds` still stops it first.
- The secret (as given and as base32) and every code typed are masked everywhere a secret value is: requests,
  `page_text`, `steps`, `story`, reasons, traces, `summary.json`, `index.html`, `manifest.json`, file names and the
  daemon log. A 6-digit number on the page equal to a code typed this session reads as the marker too. Recorded
  screenshots, `final.jpg` and video are pixels, so a typed code shows there.
- A bad secret (not base32, under 16 characters (80 bits), a wrong URI or parameter) and a key also given in `values`
  are input errors naming the key (`totp.<key>: …`), before any tab opens; the message never repeats the secret. The CLI
  exits 2.
- The key stays for the session. A later call's `totp` replaces it; a later `values` for the same key replaces it with a
  plain value, which stays secret.

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

### Waiting for a person

Some walls only a person can get past: a bot check (after its 8 s to clear by itself), a sign-in wall no supplied
value fits, and an SSO sign-in (an `accounts.google.com`, `appleid.apple.com`, `login.microsoftonline.com` or
`login.live.com` URL carrying another site's `client_id` and `redirect_uri`, or a `SAMLRequest`). With a visible
browser (`auto`, `launch` or a debugging port, unless that Chrome reports itself headless) the call stays alive up to
`wait_for_person_seconds` (default 120) for each kind of wall, once per call:

- the tab comes to the front (`Page.bringToFront`, then `Target.activateTarget`);
- one desktop notification titled "jevway" says what to do, naming only the wall and the host: "Pass the Cloudflare
  check in the Chrome window", "Sign in to github.com in Chrome", "Finish signing in with Google in Chrome" (macOS
  `osascript`, Linux `notify-send` when installed, nothing on Windows; `JEVWAY_NOTIFY=off` turns it off);
- a progress note goes out at once and every 10 s (MCP progress, CLI `waiting` NDJSON events);
- the page is read every second, with no Jev request and no input. A bot check is passed when the detector no longer
  finds it. A sign-in is passed after two reads in a row that show no password field, are not the wall's page still
  listing its fields, are not on a sign-in path (`/login`, `/session(s)`, `/auth`, `/oauth`, `/sso`, `/2fa`,
  `/verify`, …) and are not an SSO page; an SSO sign-in after two reads off the provider's sign-in URL. Tabs the page
  opens meanwhile are the person's and are never followed.

When the person gets past it, the run goes on in the same call and the story says so ("A person passed the Cloudflare
check."). When the wait runs out it ends `blocked` as before, the reason adding "nobody passed it in the 120 s jevway
waited", with `wall.waited_seconds`. The caller's cancel and `max_seconds` still stop it. In a headless browser it
never waits: `wall.person_can_act` is false and the reason says a visible browser is needed, and an SSO page is left to
Jev as before. The MCP server, an in-process `jevway run`, or the daemon read `JEVWAY_PERSON_WAIT_SECONDS` and
`JEVWAY_NOTIFY` when they start; a running daemon keeps its values until `jevway stop`.
The host check comes first: with `allowed_hosts`, include the provider's host (`accounts.google.com`) or an SSO
redirect ends the run as outside its hosts before any wait.

### Recording

`record: true` (or `record_dir`, CLI `--record <dir>`, which also moves the run folder there) keeps a record of the run
for people in the run folder:

- `run.mp4`, a screencast (needs `ffmpeg` on the PATH; skipped otherwise);
- `steps/01-type-destination.jpg`, `steps/02-select-2-guests.jpg`, …: a 2× JPEG before every action with its target
  outlined, named for the action, and `steps/NN-finished-<status>.jpg`, the final page of each call;
- `final.jpg` (the page as the latest call ended, at most 1280 px wide) and `calls/NN-<status>.jpg` (each call's);
- `summary.json` (with `asked`: each call's goal and `done_when`, secrets masked);
- `index.html`: first what was asked, how the run ended and why (a plain word: Done, Needs input, Blocked …), when,
  how long, the estimated cost and the start and end page; then the video with its steps on a timeline and a strip kept
  in sync; then each call's steps as the summary's `story` sentences, every step linking its shot file and its time in
  the video (`index.html#s3` opens step 3); then the details and the folder's files. It works offline and without JS,
  follows the reader's light or dark scheme, and carries `summary.json` itself as
  `<script type="application/json" id="jevway-summary">` and `<meta name="generator" content="jevway <version>">`;
- `manifest.json`, every file with its path, kind and a one-line description.

These images never reach the model, which gets its own 1024 px screenshots. The video stays on the first tab.

## Output folder

The session service (`src/session/session-service.ts`), which the MCP server and the CLI daemon adapt, gives
every session a folder, whether or not it records:

```
.jevway/                                        ($JEVWAY_OUT_DIR overrides; holds a .gitignore of "*")
  runs/2026-11-02_0905_book-a-stay-in-lisbon_3f9a/
    final.jpg  calls/01-needs-input.jpg  calls/02-done.jpg  summary.json  manifest.json
    index.html  run.mp4  steps/01-type-destination.jpg …       (only with record)
  journeys/2026-11-02_0910_stays.example_8c21/
    index.html  journey.json  manifest.json  screens/s01-home.png  screens/s02-search-results.png …
```

A journey's `index.html` reads without JS: each flow as a sequence of screens and the actions between them, every
screen named by its type (`#s03`, with its description, insight, patterns, findings and how it was reached), and the QA
findings by severity, each linking its screen. It embeds `journey.json` as `<script type="application/json"
id="jevway-journey">`.

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

A result is concise by default (`presentSummary` in `src/task/present.ts`): `status`, `reason`, `story`, `next`,
`session`, `url`, `title`, `page_text`, `files`, and `missing`, `wall`, `checks`, `evidence`, `confirm_ignored` when
present. `detail: "full"` adds `steps`, `jev`, `stuck`, `elapsed_ms` and `done_probability`. Each field is described
in [The result](#the-result). Progress events while a call runs: `{ "type": "started" }`,
`{ "type": "step", "n", "story", "url" }` per step, and `{ "type": "finished", "status" }`, each with its `session`.

## `jevway_look`

Returns what a page shows now, with no model request and no input to the page. Pass exactly one of:

- `session`: that session's tab;
- `tab`: an open tab whose URL contains this text;
- `url`: opened in a background tab, read, then closed.

It returns `url`, `title`, `page_text` (cut as in the summary), the listed controls once each (`label`, `role`, and
`value`, `checked`, `selected`, `expanded` when set) and `password_fields` as filled or empty, as JSON text and as
`structuredContent`. It carries no element ids, so nothing in it can be passed back as a target. Use it to see a page
after a hand-back, or to check whether a write already happened before repeating it. Passing none or more than one of
`session`, `tab` and `url` answers `isError` with an example.

## `jevway_end`

Takes `session` and `keep_tab`. Forgets the session and closes the tabs it opened: its first tab when it started from
`url`, and any tab its clicks opened. `keep_tab: true` leaves them open. It returns
`{ "session", "ended": true, "run_dir" }`; the run folder stays.

## Tool hints

Every tool carries MCP annotations for clients that ask before a call:

| Tool | Hints |
| --- | --- |
| `jevway_task`, `jevway_journey_step` | destructive, open-world: they can submit, pay or delete on any site |
| `jevway_journey_start`, `jevway_journey_autopilot` | open-world, not destructive |
| `jevway_look` | read-only |
| `jevway_end`, `jevway_journey_annotate`, `jevway_journey_finish` | touch only jevway's own state |

## MCP server

`jevway-mcp` serves the tools over stdio to 2025-era clients (`initialize`) and 2026-07-28 clients alike.

- **Instructions.** The server sends `instructions` (under 1,500 characters; Claude Code shows them upfront and searches
  them): what jevway is for, `jevway_task` versus chrome-devtools, continuing with `session` after a hand-back, the
  consent rule, `jevway_look` before repeating a write, where files go, and that page text is untrusted. Rules shared by
  tools live there once; a rule about one parameter lives in that parameter's description.
- **Tool list.** Tools are listed in one fixed order (task, look, end, then the journey tools), so the list is
  byte-stable for prompt caching. All 8 together are about 2,500 tokens (characters / 4 of `tools/list`, output schemas
  included; 4,515 before the lean rewrite), pinned by `test/mcp/server.test.ts`.
- **`JEVWAY_TOOLS`**: `all` (default), `task` (`jevway_task`, `jevway_look`, `jevway_end`) or `journeys` (the five
  journey tools). The instructions name only the tools served. Any other value serves `all` and says so on stderr.
- **`JEVWAY_IMAGE_RESPONSES`**: `auto` (default), `always` or `never`; see [The result](#the-result). Journey replies
  always carry their screen image.
- **Sessions** live in the server process until it restarts or `jevway_end` ends them; there is no idle timeout. A call
  on a session the server no longer holds answers `isError`: `Unknown session "…". Sessions end when the server
  restarts; start a new one with `url` (or `tab`).`
- **Errors say what to do.** Every failure is an `isError` result naming the fix: a missing key names
  `~/.config/jevway/env` and `jevway doctor`; a `jevway_task` with none of `url`, `tab` and `session` lists them with an
  example call; a schema error names the field with an example (`values holds text only, e.g. {"city":"Lisbon"}`).
- **Tasks** (the 2026-07-28 long-running call extension) are not served yet: the SDK does not implement them
  (plan 120). Progress notifications keep a client's idle timeout from firing during a long run.

## CLI

For agents without MCP, and for people. Every command prints exactly one JSON document on stdout: the result,
`{ "ok": true, … }`, or `{ "ok": false, "error": { "code", "message", "hint" } }`. stderr carries only NDJSON progress
events. Only `--help`, `--version` and the text modes of `doctor`, `setup` and `skill` print text. The CLI never prompts
(`jevway setup` asks questions only in a terminal). No Node stack trace reaches either stream.

```bash
# One-shot, in this process: its tab closes at the end, as before (`jevway --goal …` still works)
npx -y jevway run --browser launch-headless --url https://en.wikipedia.org/wiki/Main_Page \
  --goal "Open the Wikipedia article about the Rosetta Stone" --done-when "The Rosetta Stone article is open"

# A session: the background daemon keeps the tab (and a launched browser) between commands
jevway run --session new --browser launch-headless --url https://shop.example/checkout \
  --goal "Fill in the delivery details" --values '{"name":"Ada Lovelace"}'
jevway run --session <id> --goal "Fill in the delivery details" --values '{"phone":"+44 20 7946 0000"}'
jevway look --session <id>
jevway sessions
jevway end <id>
jevway stop
```

| Command | What it does |
| --- | --- |
| `run` | A task. Without `--session`: in-process, tabs closed at the end. `--session new` starts a session in the daemon; `--session <id>` continues it. |
| `look` | [`jevway_look`](#jevway_look): `--session <id>` through the daemon, `--url` or `--tab` in-process. |
| `journey start\|step\|autopilot\|annotate\|finish` | The journey tools through the daemon. The result is the screen report with `screen.screenshot` (an absolute path) instead of an inline image. |
| `sessions` | `{ daemon: { pid, version, socket, log, idle_timeout_s, started_at } \| null, sessions: [{ session, kind, goal, status, url, running, run_dir, started_at, last_used_at }] }`. |
| `end <id> [--keep-tab]` | [`jevway_end`](#jevway_end) (a journey id finishes the journey): `{ session, run_dir }`. |
| `serve [--idle-timeout 1h]` | The daemon in the foreground. |
| `stop` | Stops the daemon: `{ stopped: true, ended }`, or `{ stopped: false }`. |
| `doctor`, `setup`, `skill`, `help [command]` | See below. `jevway help <command>` equals `jevway <command> --help`. |

`run` flags mirror `jevway_task` in kebab-case:

| Flag | Same as |
| --- | --- |
| `--goal`, `--url`, `--tab`, `--session <id\|new>` | `goal`, `url`, `tab`, `session` |
| `--values '<json>'`, `--files '<json>'`, `--checks '<json>'` | `values`, `files`, `checks` |
| `--secret-keys a,b` | `secret_keys` |
| `--totp '<json>'` | `totp` |
| `--done-when` | `done_when` |
| `--confirm-irreversible`, `--confirm-target` | `confirm_irreversible`, `confirm_target` |
| `--max-steps`, `--max-seconds` | `max_steps`, `max_seconds` |
| `--wait-for-person <seconds>` | `wait_for_person_seconds` (0 to 3600) |
| `--allowed-hosts a,b`, `--blocked-hosts a,b` | `allowed_hosts`, `blocked_hosts` |
| `--allow-coordinate-clicks` | `allow_coordinate_clicks` |
| `--record` | `record` (the recording kept in the run folder) |
| `--record-dir <dir>` (or `--record <dir>`) | `record_dir` |
| `--detail concise\|full` | `detail` |
| `--screenshot` | `screenshot` (accepted; the CLI result always carries `files.screenshot`) |
| `--browser`, `--model`, `--screenshots` | `JEVWAY_BROWSER`, `JEVWAY_MODEL`, `JEVWAY_SCREENSHOTS` (a session's first call only) |
| `--keep-open` | one-shot only: leaves the tabs open at the end |

The result is the [concise summary](#concise-and-full-results) (`--detail full` adds the raw steps) with `ok: true`.
`files` holds absolute paths. `next` names flags, not MCP parameters, and the session to pass
("Add the missing values to `--values` and run again with `--session <id>`."). A one-shot result names no session.

**Exit codes.** 0: the status is `done`, or the command did what it says. 1: a hand-back (`needs_input`,
`needs_confirmation`, `uncertain`, `step_budget`, `blocked`) or a tool error. 2: bad usage, or the model's key is
missing.

**Error codes.** `unknown_command` and `unknown_flag` (hint: `Did you mean --values? See jevway run --help`),
`missing_command`, `missing_flag`, `missing_value`, `invalid_value` (a JSON flag names itself and its parse error, e.g.
`--values: Expected property name …`, and the hint gives an example), `unexpected_argument`, `missing_key` (all exit 2);
`unknown_session`, `daemon_busy`, `daemon_running`, `daemon_unavailable`, `failed` (anything else that went wrong, its
message kept), and `outcome_unknown` (exit 1). `outcome_unknown` means the daemon stopped answering while a call that
can click or type was running: it may already have happened, so check with `jevway look --session <id>` before
repeating it.

**Events on stderr**, one JSON object per line: `{"type":"started","session"}`,
`{"type":"step","session","n","story","url"}` per step, `{"type":"finished","session","status"}`, and
`{"type":"daemon","event":"started"|"restarted","pid","log","reason?"}` when a command started or replaced the daemon.
Ctrl-C ends a run `blocked` ("Cancelled by the caller") and still prints its result; a second Ctrl-C exits 130.

### The daemon

The first command that needs a session (`run --session new`, `journey start`) starts `jevway serve` in the background.
Commands that name an existing session, plus `sessions`, `end` and `stop`, never start one: with no daemon running, a
session id is `unknown_session` and `sessions` lists nothing.

- **One local socket**: `daemon.sock` in `$JEVWAY_STATE_DIR`, else `$XDG_RUNTIME_DIR/jevway`, else `~/.cache/jevway`
  (mode 700); its log is `daemon.log` beside it (NDJSON; method, session, duration and error code per request, never a
  request's values). On Windows it is a named pipe (untested).
- **Sessions and browsers stay alive** between commands: one browser connection per `--browser`/`--model`/`--screenshots`
  choice. Runs land under the caller's `.jevway/` (or `JEVWAY_OUT_DIR`), whichever directory started the daemon, and
  each output root gets `sessions.json`: the open sessions writing there.
- **Idle**: a session or journey unused for `--idle-timeout` (default `1h`; seconds, or `90s`, `30m`, `2h`; `0` never)
  is ended, closing the tabs it opened; the daemon exits once it holds none and nothing has asked it anything for that
  long.
- **Version and settings**: a daemon of another version, or started with other keys set, `CHROME_PATH`,
  `JEVWAY_ALLOWED_HOSTS`, `JEVWAY_BLOCKED_HOSTS` or `JEVWAY_REPLAY*`, is replaced when it holds no sessions (event
  `restarted`) and is `daemon_busy` otherwise. It keeps the environment it started with: after rotating a key, run
  `jevway stop`.
- **Stale socket**: a socket file nothing answers on is removed and a new daemon started.
- **Timeouts**: the client waits a call's `--max-seconds` (default 300) plus two minutes, a journey call 30 min, other
  calls 60 s: always longer than the daemon's own limits, so the agent gets the daemon's real answer.
- `jevway stop` aborts running calls (they end `blocked`), ends every session, closes the browsers it launched and
  removes the socket.

## `jevway setup`

```bash
npx -y jevway setup                                    # interactive, in a terminal
npx -y jevway setup --client cursor --print            # how to register jevway with Cursor; changes nothing
npx -y jevway setup --client codex --print --json      # the same as { client, kind, command?, file?, snippet }
```

The interactive setup has three steps, then runs the doctor and names one thing to try first:
1. **Key.** TypeSafe (recommended) or OpenRouter. The key is read with hidden input and written only as its line in
   `~/.config/jevway/env` (`$XDG_CONFIG_HOME` respected), mode 600, every other line kept. A key already set is kept
   unless you say replace. One real request (`doctor --live`) is offered, default no.
2. **Browser.** `auto`, `launch`, `launch-headless` or a port, tested with the doctor's browser check.
   `JEVWAY_BROWSER` is written only for a choice other than `auto`.
3. **MCP clients.** Claude Code, Codex, Cursor and OpenCode, found by their command on `PATH` or their config. Each
   change is shown first (the command it runs, or a unified diff of the config file) and made only on a yes; other
   servers' entries are never touched, a client that already has `jevway` is skipped, and a config file that is not
   plain JSON is left alone with the snippet to add by hand. It also offers to copy the skill into that client's
   skills folder.

Every file is written whole (a temporary file renamed into place), so Ctrl-C at any point leaves each file as it was
or complete. Without a terminal it asks nothing and exits 2 with
`{ "ok": false, "error": { "code": "needs_tty", "message", "hint" } }` on stdout, naming `--client <name> --print`
and the env-file steps.

`--client <name> --print`:

| `--client` | `kind` | What it prints |
| --- | --- | --- |
| `claude-code` | `command` | `claude mcp add jevway -s user -- npx -y -p jevway jevway-mcp` |
| `codex` | `command` | `codex mcp add jevway -- npx -y -p jevway jevway-mcp`, and the `[mcp_servers.jevway]` table it writes to `~/.codex/config.toml` |
| `cursor` | `config` | `{ "mcpServers": { "jevway": … } }` for `~/.cursor/mcp.json` |
| `opencode` | `config` | `{ "mcp": { "jevway": { "type": "local", … } } }` for `~/.config/opencode/opencode.json` |
| `other` | `config` | `{ "command": "npx", "args": ["-y", "-p", "jevway", "jevway-mcp"] }` |

Paths honour `$CODEX_HOME` and `$XDG_CONFIG_HOME`. An unknown client is exit 2.

## `jevway doctor`

```bash
npx -y jevway doctor          # Node, key and route, browser, ffmpeg; exit 0 when ready
npx -y jevway doctor --plan   # the setup steps still missing, numbered
npx -y jevway doctor --json   # { ready, findings: [{ check, level, message, fix? }] }
npx -y jevway doctor --live   # plus one real Jev request (a fraction of a cent)
```

`--browser <source>` and `--model <name>` check another browser or model than the configured one. It never prints a
key, and never replays recordings. `--json` names each finding by `check` (`node`, `key`, `model`, `env_file`,
`browser`, `ffmpeg`, `replay`, `live`), `level` is `ok`, `warn` or `fail`, and `fix` comes with every `warn` and
`fail`; the exit code is the same as without it.

## `jevway skill`

```bash
npx -y jevway skill                              # print the SKILL.md this version ships
npx -y jevway skill --install ~/.codex/skills    # copy skill/jevway/ to ~/.codex/skills/jevway/
```

`--install` prints `{ ok, status, path, files }`, `status` being `installed`, `unchanged` (the same skill is already
there) or `replaced`. A different `jevway` folder (or a symlink) is left as it is: exit 1 with
`"code": "skill_exists"`, unless `--force` is given, which replaces it (a symlink is removed, never its target).

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
| `JEVWAY_OUT_DIR` | `./.jevway` | The output root: `runs/` and `journeys/`. See [Output folder](#output-folder). |
| `JEVWAY_JOURNEYS_DIR` | `<JEVWAY_OUT_DIR>/journeys` | Where journey maps are written. |
| `JEVWAY_STATE_DIR` | `$XDG_RUNTIME_DIR/jevway`, else `~/.cache/jevway` | The CLI daemon's socket and log. See [The daemon](#the-daemon). |
| `JEVWAY_TOOLS` | `all` | MCP: `all`, `task` (task, look, end) or `journeys`. See [MCP server](#mcp-server). |
| `JEVWAY_PERSON_WAIT_SECONDS` | `120` | Seconds a run with a visible browser waits for a person at a wall, when the call names none; `0` never waits. See [Waiting for a person](#waiting-for-a-person). |
| `JEVWAY_NOTIFY` | on | `off` stops the desktop notification while a run waits for a person. |
| `JEVWAY_IMAGE_RESPONSES` | `auto` | MCP: when a task result carries its end page inline: `auto` (hand-backs, or `screenshot: true`), `always`, `never`. |
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
