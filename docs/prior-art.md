# Prior art (2026-11-01)

What other open-source projects that put Jev behind a browser do, and which of their ideas jev-browse should take.
This is a dated review of ten repositories, read at the commits below; each idea was checked against jev-browse's own
code at `4c7f34d`. The candidate plans that come out of it are listed in
[plans/README.md](../plans/README.md#backlog-from-the-prior-art-review-2026-11-01).

## Sources

All ten are MIT-licensed (each ships a `LICENSE` file). Adapting their code with attribution is allowed, as jev-browse
already does for jev-ultrafast; for anything that touches the loop guards or the consent rule, reimplement against our
invariants instead of porting.

| Repository | Commit | ★ | What it is |
| --- | --- | --- | --- |
| [jkudish/jev-browser](https://github.com/jkudish/jev-browser) | `17f5fd0` | 365 | MCP server, CLI and library; Jev picks each step and scores goal-met and stuck |
| [jkudish/jev-agent-tools](https://github.com/jkudish/jev-agent-tools) | `416498f` | 6 | The transport and provider layer under jkudish/jev-browser |
| [Ying-Kai-Liao/jev-browser](https://github.com/Ying-Kai-Liao/jev-browser) | `b407745` | 128 | `browser_do(step, values)` over MCP on Playwright; the closest design to ours |
| [jiawei686/jev-ultrafast-mcp](https://github.com/jiawei686/jev-ultrafast-mcp) | `6b2e275` | 19 | Python MCP server; `browser_goal(goal, url, verify=[…])` checked by code afterwards |
| [forvela/jev-agent-browser](https://github.com/forvela/jev-agent-browser) | `eb35251` | 15 | Jev picks, Vercel's agent-browser CLI executes; structured hand-backs |
| [coderexpert123/jev-browser-wingman](https://github.com/coderexpert123/jev-browser-wingman) | `97cdb9c` | 7 | `browse_step` over MCP; can sit in front of another browser MCP; benchmark against Playwright alone |
| [MaciejWiatr/jev-browser](https://github.com/MaciejWiatr/jev-browser) | `fcee525` | 3 | Claude Code plugin; background tabs of the user's Chrome; per-site action memory |
| [wy-coliney/jev-browser-use](https://github.com/wy-coliney/jev-browser-use) | `54deed1` | 1209 | Skill and Codex plugin: "Jev clicks, Codex thinks and verifies" |
| [nexibeo/jev-browser-control](https://github.com/nexibeo/jev-browser-control) | `1c752b8` | 5 | Chrome extension plus MCP server |
| [agent-labs-dev/fastbrowse](https://github.com/agent-labs-dev/fastbrowse) | `9893697` | 172 | Rust core; Jev picks actions, every claim in an answer cites a page quote |

Citations below read `repo path:line` at the commit in this table.

### Vercel's agent-browser (checked at v0.41.0)

agent-browser has no goal-to-summary mode like `browser_task`. Its closest feature, `agent-browser chat "<instruction>"`,
runs a general LLM (default `anthropic/claude-sonnet-4.6` through the AI Gateway) with one tool that executes any
agent-browser command, so the per-step cost stays a full LLM turn, there is no structured status, no `done_when` check
and no irreversible-click gate. A request for a Jev-driven `run "<goal>"` (vercel-labs/agent-browser#1949) was closed
as not planned. Their direction is cheaper steps for the calling agent instead: `snapshot --delta`, refs that survive
DOM changes and `screenshot --if-changed` (v0.38).

## How to read the entries

- **Today**: what jev-browse does now, with the file that shows it.
- **Jev request**: *changes* means the idea alters what Jev is asked, so Jev's verified baseline moves; it needs the
  full gate re-run, and the held-back Vikunja jobs stay frozen. *no* means the request is untouched.
- **Value / effort**: value is high, med or low; effort is in working time, before verify runs.

## Recommended order

| Round | Ideas | Why this order |
| --- | --- | --- |
| A, safety | [S1](#s1), [S2](#s2), [S3](#s3), [S5](#s5), [K7](#k7), then [S4](#s4) with [K3](#k3) | Small, no change to Jev's request except S4 for marked keys. S1 is the only gap where a run can act in the user's Chrome with no one waiting for it |
| B, capability | [V1](#v1) first, then [C1](#c1), [C2](#c2), [C3](#c3), [C4](#c4) | V1 is the acceptance suite for the gaps README "Limits" lists |
| C, caller contract | [K1](#k1), [K2](#k2), [K6](#k6) | Code-checked results and evidence for the calling agent |
| D, Jev request | [J1](#j1), [J2](#j2), [J4](#j4), [J3](#j3), one at a time | Each moves the verified baseline and is measured on its own |
| E, measurement | [V2](#v2), [V3](#v3) | Baseline cost comparison and credit-free regression runs |
| F, distribution | [D1](#d1) to [D6](#d6) | Once there is a release to install |

## Safety and consent

<a id="s1"></a>
### S1. Stop on caller cancellation and a time budget

- **Idea**: pass the MCP request's abort signal into the run, add `max_seconds`, and cap every wait and model call by
  the time left. Stop between steps or inside waits, never mid-input.
- **Seen in**: jkudish/jev-browser `src/navigate.ts:593-614`, `:1074-1076`, `src/index.ts:237`; forvela
  `src/loop.js:50`, `:226-240`, `src/browser.js:94-110`; nexibeo `extension/lib/agent.js:47-50`; fastbrowse
  `README.md:374-383`.
- **Today**: the `browser_task` handler takes no `extra`, so the SDK's `signal` is ignored (`src/mcp.ts:74`); the loop is
  bounded by `max_steps` only (`src/task/run-task.ts:350`). A client that times out leaves the run clicking.
- **Invariants**: never abort an input in flight (the `InputNotDelivered` rule); a timeout is its own status or reason,
  not the "protocol call timed out → browser error" path. The SDK may sleep up to 60 s on a `Retry-After`; cap it by the
  time left (jkudish caps it at 5 s).
- **Jev request**: no. **Value**: high. **Effort**: ½ day.

<a id="s2"></a>
### S2. Allowed and blocked hosts for `browser_task`

- **Idea**: the caller (and optionally a server env setting) gives allowed and blocked hosts; the page's URL is checked
  before each decision and after every step, and leaving the envelope hands back `blocked`.
- **Seen in**: jiawei686 `jev_ultrafast_mcp/safety.py:32-46`; wy-coliney `skills/jev-browser-use/bridge.mjs:42-48`;
  nexibeo `extension/background.js:64`, `:72`; MaciejWiatr `server/browser_tools.py:56-65`; wingman
  `src/core/policy.ts`. fastbrowse blocks at the network layer with `Fetch` (`docs/design.md:207-219`).
- **Today**: journeys have `stay_within` (`src/mcp.ts:170`); `browser_task` has nothing. In `auto` mode the run is in
  the user's signed-in Chrome.
- **Notes**: jiawei686 checks only explicit navigations, so a click that leaves the domain gets through; check after
  every step. `Fetch`-level blocking is a later step.
- **Jev request**: no. **Value**: high. **Effort**: ½ day (URL check), +1 day for `Fetch`.

<a id="s3"></a>
### S3. Bind a confirmation to the element that was flagged

- **Idea**: at `needs_confirmation`, store the flagged control's path and label (and the URL); `confirm_irreversible`
  then allows only that control.
- **Seen in**: wingman `README.md:214` (a single-use token bound to URL, element fingerprint and verb),
  `src/core/tokens.ts`.
- **Today**: `#confirmedCommit` is a boolean (`src/task/run-task.ts:245-253`) armed for whichever risky click the next
  call picks (`:1067`); `confirm_target` words must be on the page, but the element itself is not pinned.
- **Invariants**: tightens the consent rule; a different risky control on the confirmed call hands back
  `needs_confirmation` again.
- **Jev request**: no. **Value**: med-high. **Effort**: 2–3 h.

<a id="s4"></a>
### S4. Opt-in secret values

- **Idea**: the caller marks keys as secret. For those, Jev sees the key name only (never the value), and the value is
  scrubbed from `page_text`, steps, recordings and anything the page echoes back.
- **Seen in**: Ying-Kai-Liao `src/page-model.mjs:112-115`, `src/session.mjs:287-295`, `:681-682` (redacts by key name:
  token, otp, card, cvv, pin); forvela `src/contracts.js:1-41`, `src/decision.js:29-34`; wingman
  `src/core/withhold.ts` (withholds every value).
- **Today**: `supplied_values` goes to Jev raw (`src/jev/decide.ts:266`), and the value question lists `key: value`
  (`:300`). Only password fields are protected.
- **Invariants**: extends "password fields are never listed" to an API token typed into an ordinary field. Keep it
  opt-in: withholding every value, as wingman does, would break the `value_for_` heads Jev's baseline was verified on.
- **Jev request**: changes, for marked keys only; measure on `verify:signup`. **Value**: med-high. **Effort**: ½ day.

<a id="s5"></a>
### S5. Bot-wall detection inside the run

- **Idea**: a DOM check before spending a decision: a challenge title, or 3+ challenge markers including a brand
  phrase (so a page that quotes them isn't flagged). A challenge gets about 8 s to clear itself, the final page is
  checked again so a run never ends `done` on a challenge, and a wall ends `blocked` with a reason naming it.
- **Seen in**: jkudish/jev-browser `src/lib.ts:474-524`, `src/navigate.ts:762-821`, `:1147-1157`; MaciejWiatr
  `server/browser_tools.py:446-451`; wingman `src/core/page-scripts.ts:406-460` (with decoy fixtures). fastbrowse asks
  Jev instead (`crates/fastbrowse-agent/src/policy.rs:755-771`).
- **Today**: only the harness detects walls (`verify/real-world.ts:106`), and its whole-body regex misread Hacker News
  comments as a wall (plans/LOG.md, 2026-10-18). The run spends its steps before stopping.
- **Invariants**: none if reported as a `blocked` reason; keep the status set, which every suite matches on. Leave
  sign-in pages out (see [J2](#j2)): a hard login stop would break `verify:signup`.
- **Jev request**: no (the DOM rule, not fastbrowse's questions). **Value**: high. **Effort**: ~3 h plus fixtures.

<a id="s6"></a>
### S6. Caller-supplied `never_click`

- **Idea**: name patterns (e.g. `/delete/i`) removed from the action space before Jev sees it.
- **Seen in**: wy-coliney `skills/jev-browser-use/bridge.mjs:125-138` (`denyNames`).
- **Today**: none; the consent gate only stops the click after Jev picked it.
- **Jev request**: no (fewer ids, same question). **Value**: med. **Effort**: 2 h.

<a id="s7"></a>
### S7. Sensitive-host policy

- **Idea**: an optional policy that hands back on banking, mail or identity hosts before any page text goes to Jev.
- **Seen in**: wingman `src/core/policy.ts`, `src/core/policy-data.ts`; nexibeo `README.md:162`
  (`JBC_BLOCKED_SITES`).
- **Today**: none. Builds on [S2](#s2).
- **Jev request**: no. **Value**: med. **Effort**: ½ day.

<a id="s8"></a>
### S8. Server ceilings a call can lower but not raise

- **Idea**: env settings such as a step or time ceiling, or confirmations off entirely (`JEV_ALLOW_CONFIRM=0`), that a
  call may tighten but never loosen.
- **Seen in**: nexibeo `README.md:160`; fastbrowse `README.md:374-383`.
- **Today**: none. **Jev request**: no. **Value**: low-med. **Effort**: 1–2 h, with [S1](#s1).

## Capability gaps

These close items in README "Limits". Build [V1](#v1) first so each has an acceptance test.

<a id="c1"></a>
### C1. Scroll the area that actually scrolls

- **Idea**: aim the wheel at the largest visible scrollable area, or at the scroll box around a target; report a scroll
  that moved nothing.
- **Seen in**: Ying-Kai-Liao `src/session.mjs:54-85`, `:586-614`.
- **Today**: the wheel always goes to the centre column, lower half (`src/browser/tab.ts:398-405`): the "nested
  scrolling" gap. forvela's LinkedIn scroll script exists for the same reason.
- **Invariants**: the point comes from DOM rects, never from the model.
- **Jev request**: no. **Value**: high. **Effort**: ½ day.

<a id="c2"></a>
### C2. Follow a tab our tab opens

- **Idea**: when a click opens a tab (`target=_blank`, `window.open`), switch to it and note "new tab opened: <url>" in
  history; fall back if it closes.
- **Seen in**: Ying-Kai-Liao `src/session.mjs:167-170`, `:182`; jkudish/jev-browser `src/navigate.ts:741-746`,
  `:1081-1086`.
- **Today**: popup tabs are unsupported (`src/mcp.ts:36`).
- **Notes**: in raw CDP, `Target.setDiscoverTargets` plus `targetCreated` filtered by `openerId` = our tab (in `auto`
  mode never follow the user's own tabs). The new tab needs the input-delivery counter and dialog handling installed
  before its scripts run; the confirmation state carries over; `browser_task_end` and `keep_tab` need a rule for the
  session's new tab.
- **Jev request**: no. **Value**: med. **Effort**: 1 day.

<a id="c3"></a>
### C3. File upload from caller-declared paths

- **Idea**: an upload operation where Jev picks a file input (including a hidden one behind a styled button) and a key;
  code sets the files with `DOM.setFileInputFiles`.
- **Seen in**: Ying-Kai-Liao `src/session.mjs:449-454`, `:560-563`, hidden inputs `src/page-script.mjs:56`.
- **Today**: unsupported (README "Limits").
- **Invariants**: paths come from a separate caller `files` map, so an ordinary text value can never become a path.
- **Jev request**: changes (a new operation). **Value**: med. **Effort**: 1 day.

<a id="c4"></a>
### C4. Read every frame with the same reader

- **Idea**: element ids continue across frames, each element carries its frame, and actions run in that frame; frames
  with no URL are skipped and each gets a time cap.
- **Seen in**: Ying-Kai-Liao `src/session.mjs:233-258`, `:518-521`.
- **Today**: iframes are unsupported (README "Limits").
- **Notes**: same-process frames via `Page.getFrameTree` and `Page.createIsolatedWorld`; cross-origin ones via
  `Target.setAutoAttach` with `flatten`. Rects need the frame offset; the freshness check, hit tests, input counter and
  screenshot marks all have to work per frame.
- **Jev request**: no (more ids). **Value**: med-high. **Effort**: 2–3 days.

## Changes to Jev's request

Each of these moves Jev's verified baseline: the full gate set re-runs, one idea at a time, and none is tuned on
Vikunja.

<a id="j1"></a>
### J1. Tell Jev what the last action changed

- **Idea**: code diffs the page before and after each action and sends `last_change`: elements added, removed or
  changed (value, checked, sorted), elements that only moved, URL change, and new text by a word-level diff.
- **Seen in**: Ying-Kai-Liao `src/page-model.mjs:32-83`, fed in at `src/session.mjs:692`; its notes credit it with
  fixing add-item and drag done scores.
- **Today**: history carries `page_changed` and `value_kept` only (`src/task/run-task.ts:633-639`); new text is shown
  only after risky or saving clicks, as `[Page message after …]`.
- **Value**: high. **Effort**: 1 day plus verify runs.

<a id="j2"></a>
### J2. Error and sign-in-wall questions

- **Idea**: two yes/no questions in each request: "does the page show an error caused by the actions so far?" and "is
  this a sign-in screen?" An error ends the run with the page's words; a sign-in wall with no fitting values hands back
  with a `wall` field instead of a new status.
- **Seen in**: Ying-Kai-Liao `src/session.mjs:389-390`, `:726-730`; fastbrowse
  `crates/fastbrowse-agent/src/policy.rs:755-771`.
- **Today**: a rejected submit is caught only when the same form is submitted again; nothing asks about sign-in.
- **Notes**: their 0.7 thresholds are theirs; set ours from runs. Sign-in must still work when the caller supplies
  values (`verify:signup`, the skill's "I typed the password" flow).
- **Value**: med. **Effort**: a few hours plus verify runs.

<a id="j3"></a>
### J3. A stuck question

- **Idea**: a separate "is the run stuck?" question beside the action and done questions.
- **Seen in**: jkudish/jev-browser `src/questions.ts:14-26`, stop gate `src/navigate.ts:881` (0.85, measured on two
  sites only).
- **Today**: deterministic `GUARDS` only. Start it as a trace-only signal and set any threshold from our runs.
- **Value**: low-med. **Effort**: 1 h plus verify runs.

<a id="j4"></a>
### J4. Explicit true/false meanings on yes/no questions

- **Idea**: give `DONE_CHECK`, `COMMIT_RISK` and `ELEMENT_COMMIT_RISK` explicit `true`/`false` descriptions, as
  TypeSafe's guidance suggests. The installed SDK supports them.
- **Seen in**: fastbrowse `docs/jev.md:14`, `:132-133`.
- **Today**: `noul()` gets instructions only (`src/jev/decide.ts:252-257`).
- **Value**: med. **Effort**: 1 h plus verify runs (it touches the 0.3 and commit-risk baseline).

<a id="j5"></a>
### J5. Stricter answer validation

- **Idea**: the chosen option must be within 0.01 of the top probability; the sum tolerance scales with the number of
  non-zero options; failures get typed codes (`rate_limited`, `unavailable`, `invalid_distribution`).
- **Seen in**: jkudish/jev-agent-tools `src/provider.ts:71-97`, `:158-163`.
- **Today**: a fixed 0.02 sum tolerance and no check that the choice is the maximum (`src/jev/decide.ts:487-497`).
- **Notes**: count "Invalid TypeSafe answer" in existing traces before changing anything.
- **Jev request**: no (validation only). **Value**: low. **Effort**: 1 h.

## Caller contract

<a id="k1"></a>
### K1. Caller checks on the final page

- **Idea**: `verify=[{url_contains | text_contains | text_absent | element_exists | checked | value_equals |
  count_at_least}]`, checked by code on the final page. A pass turns `blocked` into `done`; a fail turns `done` into
  unconfirmed. An empty needle fails.
- **Seen in**: jiawei686 `jev_ultrafast_mcp/assertions.py:16-63`, override at `jev_ultrafast_mcp/server.py:581-608`.
- **Today**: `done` is judged by the `done_when` model check only; ground-truth checks live in `verify/`.
- **Notes**: alongside `done_when`, never instead of it (text can be on the page before the run). Leave out their `js`
  check type.
- **Jev request**: no. **Value**: high. **Effort**: 1–2 days.

<a id="k2"></a>
### K2. Evidence quote with `done`

- **Idea**: one Jev choice over spans of visible text cut by code ("which span shows `done_when`?", with an `absent`
  option); code copies the span word for word into `evidence: {quote, url, deep_link}` with a `#:~:text=` link. The same
  request could back a standalone `browser_check(statement)`.
- **Seen in**: fastbrowse `crates/fastbrowse-agent/src/retrieval/choices.rs:126-141`,
  `crates/fastbrowse-core/src/citations.rs:58`; nexibeo `jev_check` (`extension/lib/agent.js:211-222`).
- **Today**: only raw `page_text`.
- **Invariants**: Jev selects, code copies. Viewport text is capped at 6000 characters (`src/browser/snapshot.js:511`),
  so the spans fit Jev's option limit.
- **Jev request**: adds one request on the done path. **Value**: high. **Effort**: 1 day.

<a id="k3"></a>
### K3. A structured `needs_input`

- **Idea**: the hand-back names the field it wants: `{name, role, value_key_suggestion}`.
- **Seen in**: forvela `src/loop.js:293-298`, `:329-347`.
- **Today**: a reason string plus `stuck.element`.
- **Jev request**: no. **Value**: med. **Effort**: 1–2 h, with [S4](#s4).

<a id="k4"></a>
### K4. Console errors and failed requests on `browser_task`

- **Idea**: collect console errors, page errors and failed requests per step, capped, and return them to the caller
  only.
- **Seen in**: jkudish/jev-browser `src/navigate.ts:674-705`.
- **Today**: `src/journeys/diagnostics.ts` collects them, for journeys only.
- **Invariants**: never into the Jev request. **Jev request**: no. **Value**: low-med. **Effort**: 2 h.

<a id="k5"></a>
### K5. Cost, effective model and time split

- **Idea**: `est_cost_usd` from tokens and a per-profile price, the model the API reports back, and total model time
  against page time.
- **Seen in**: jkudish/jev-browser `src/navigate.ts:127-136`; jkudish/jev-agent-tools
  `src/transports/typesafe.ts:102-113`; jiawei686 `jev_ultrafast_mcp/server.py:617-620`.
- **Today**: `jev` reports requests, input tokens, median latency and screenshots (`src/task/run-task.ts:56`).
- **Jev request**: no. **Value**: low-med. **Effort**: 1–2 h.

<a id="k6"></a>
### K6. A look tool with no model call

- **Idea**: `browser_look(session)` returns `page_text`, the listed elements and the URL, for checking a page or
  diagnosing a hand-back.
- **Seen in**: jiawei686 `jev_ultrafast_mcp/server.py:246`, `:264`.
- **Today**: `tab.observe()` exists (`src/browser/tab.ts:105`), but page text only comes back at the end of a
  `browser_task`, and `verify:agent` gives the agent no way to look again.
- **Invariants**: password fields stay filled/empty only. **Jev request**: no. **Value**: med. **Effort**: 2–3 h.

<a id="k7"></a>
### K7. MCP tool annotations

- **Idea**: `destructiveHint` and `openWorldHint` on `browser_task`, local hints on `browser_task_end`.
- **Seen in**: jiawei686 `jev_ultrafast_mcp/server.py:95-103`.
- **Today**: none in `src/mcp.ts`. **Jev request**: no. **Value**: low-med. **Effort**: 15 min.

## Measurement

<a id="v1"></a>
### V1. A capability and negative suite that leads with false `done`

- **Idea**: small public tasks per capability (iframe form, new window, upload, infinite scroll, drag), negative tasks
  (bad password, missing page, disabled field, missing option, sign-in wall) and guard tasks (sign-in must not stop for
  confirmation, placing the order must). Any `done` whose ground-truth check fails counts as a false done, reported
  first.
- **Seen in**: Ying-Kai-Liao `bench/tasks.mjs:90-145`, false-done count `bench/run.mjs:58`.
- **Today**: every suite judges app state, but none reports a false-done count.
- **Value**: med (high as acceptance tests for C1–C4). **Effort**: ½ day.

<a id="v2"></a>
### V2. A baseline route in `verify:agent`

- **Idea**: run the same chores with the calling agent on chrome-devtools alone, interleaved with the jev-browse route;
  report cold and warm prompt-cache runs apart, cost with cache writes priced at the read rate, and Jev's spend added to
  the agent's. Hash the run config and refuse a baseline from a different one.
- **Seen in**: wingman `README.md:9-17`, `:277-287`, `bench/run.ts:870-875`, `bench/CLAUDE.md`.
- **Today**: `verify/agent.ts:453` records `total_cost_usd` only.
- **Value**: high (the number that says whether jev-browse pays off). **Effort**: 1 day.

<a id="v3"></a>
### V3. Replay recorded Jev answers offline

- **Idea**: a proxy stores each Jev response under the sha256 of the canonical request; a request never recorded gets a
  404 plus a diff against the nearest recorded one. Loop and guard changes then regression-test without credits.
- **Seen in**: fastbrowse `bench/README.md:8-27`, `:36-58`.
- **Today**: offline unit tests, but every end-to-end run is live and paid.
- **Notes**: Forgejo and Vikunja pages need CSRF tokens and timestamps normalised first.
- **Value**: med. **Effort**: 1–2 days.

## Distribution

<a id="d1"></a>
### D1. Publish and one-line installs

- **Idea**: publish to npm; one-liners for `claude mcp add … -- npx -y jev-browse-mcp`, Codex TOML and OpenCode; note
  that some clients filter the environment, so pass `TYPESAFE_API_KEY` explicitly.
- **Seen in**: jkudish/jev-browser `README.md:38-120`; wy-coliney `README.md:17-62`.
- **Today**: `pnpm build` plus a hand-edited absolute path; README says "once the package is published".
- **Value**: high for adoption. **Effort**: ½–1 day.

<a id="d2"></a>
### D2. Claude Code plugin packaging

- **Idea**: `.claude-plugin/plugin.json`, `marketplace.json` and `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`, so one
  install brings the MCP server and the skill; `npx skills add` for the skill alone.
- **Seen in**: MaciejWiatr `.claude-plugin/`, `.mcp.json`; nexibeo `.claude-plugin/marketplace.json`,
  `mcp/.claude-plugin/plugin.json`.
- **Today**: `skill/jev-browse/` is copied by hand. Needs [D1](#d1).
- **Value**: med. **Effort**: 1–2 h.

<a id="d3"></a>
### D3. An install guide written for agents

- **Idea**: a file an agent follows to install: rules (show a diff before editing MCP config, never relaunch a browser
  it didn't start, never ask for the key in chat; keep it in a `~/.config` env file) and checkable outcomes.
- **Seen in**: wingman `INSTALL-FOR-AGENTS.md:1-90`; wy-coliney `INSTALL.md`,
  `skills/jev-browser-use/references/provider-configuration.md:16-24`.
- **Today**: none. **Value**: med. **Effort**: 2 h.

<a id="d4"></a>
### D4. A `doctor` command

- **Idea**: tells apart no key, no browser, remote debugging not allowed and a host policy, and makes one Jev round
  trip; `--plan` prints the steps still missing.
- **Seen in**: wingman `src/cli/doctor.ts`, `src/cli/detect.ts`, `src/cli/setup-plan.ts`; jiawei686
  `jev_ultrafast_mcp/server.py:692-757`.
- **Today**: none. **Value**: med. **Effort**: ½–1 day.

<a id="d5"></a>
### D5. Skill wording

- **Idea**: an "observation → correct conclusion" table; "before repeating a write, check whether it already
  happened"; continue a session that made progress instead of starting over.
- **Seen in**: wy-coliney `skills/jev-browser-use/SKILL.md:102-110`; fastbrowse `skills/fastbrowse/SKILL.md:89-90`;
  wingman `src/surfaces/tool-text.ts:44`.
- **Today**: `skill/jev-browse/SKILL.md` covers the split and the consent rule. **Value**: low. **Effort**: 1 h.

<a id="d6"></a>
### D6. Keep the other browser server's action tools away from the agent

- **Idea**: cheap form: ship a permissions deny list for chrome-devtools' click, fill and navigate tools with the skill.
  Full form: a stdio proxy that hides a wrapped browser server's page-action tools by capability class and keeps its
  read, tab, dialog and wait tools.
- **Seen in**: wingman `src/cli/with-chrome.ts:121-122`, `:302-341`, `profiles/playwright-mcp.json`,
  `src/core/classify-tools.ts:48-115`.
- **Today**: the split is instruction-only (`skill/jev-browse/SKILL.md`).
- **Value**: med. **Effort**: 1 h (deny list), 2–3 days (proxy).

## Later, with conditions

<a id="l1"></a>
### L1. Replay a recorded run before exploring

- **Idea**: staged runs: already done → replay a recorded run with no model calls → explore with Jev and record. Replay
  refuses weak or near-tied matches.
- **Seen in**: jiawei686 `jev_ultrafast_mcp/macros.py:173-248` (tie margin at `:242`), `scripts/checkin.py:150-200`.
- **Today**: journeys replay by exact label but take the first match (`src/journeys/journey-session.ts:459-472`); the tie
  refusal is worth taking there on its own.
- **Conditions**: resolve each step on a fresh observation (jiawei686 resolves all steps up front, which breaks
  multi-page replays); store value keys, never values; a replayed risky click either asks the per-element risk question
  or hands back `needs_confirmation` wherever the recorded run needed one.
- **Value**: med (determinism, keyless runs). **Effort**: 3–5 days.

<a id="l2"></a>
### L2. Per-page-type memory, as a hint only

- **Idea**: remember which control led to `done` per host and path template, and feed it into history as a hint.
- **Seen in**: MaciejWiatr `server/memory.py:1-16`, `:147-166`.
- **Conditions**: their `act` and `run_workflow` click with no risk gate, a second decision authority beside Jev. Only
  the hint form fits. **Value**: low-med. **Effort**: 1–2 days.

## Considered and rejected

| Idea | Seen in | Why not |
| --- | --- | --- |
| A second model writes the text to type | jkudish/jev-browser `src/navigate.ts:212-253`; jiawei686 `policy.py` (`text_for`); nexibeo `extension/lib/agent.js:101-126` | Breaks "TYPE_TEXT types only `values[key]`"; jkudish's README reports keyword fragments typed into a username field |
| Password fill as a model-visible action, seed cookies | jkudish/jev-browser `src/lib.ts:76-88` | Breaks "password fields are never listed"; `auto` mode already uses the signed-in Chrome |
| Withhold every value from Jev | wingman `src/core/withhold.ts` | Breaks the verified `value_for_` heads; [S4](#s4) is the opt-in form |
| Operator scripts Jev can pick (`RUN_TOOL`) | forvela `src/browser.js:69-77` | Skips every executor guard; per-site scripts break "guards are generic"; its main use is fixed by [C1](#c1) |
| agent-browser as the executor | forvela `src/browser.js:21-110` | A process per command; loses Box, rect-based marks, the input-delivery counter and dialog handling |
| A Chrome extension as the driver | nexibeo `extension/` | Needs `<all_urls>` and `debugger`, an unpacked install, and breaks sharing the Chrome with chrome-devtools; focus is already kept (`src/browser/tab.ts:126-137`, `:268`) |
| Human-like cursor | MaciejWiatr `server/browser_tools.py:673-760` | Exists to get past bot detection, which the skill rules out |
| Tab groups | MaciejWiatr, nexibeo | Cosmetic, needs an extension |
| WebMCP page tools | Ying-Kai-Liao `src/webmcp.mjs` | Page JavaScript skips the input-delivery check; the consent rule checks page text, not what a tool does; their shim fakes `modelContext` |
| Jev decides whether to accept a confirm dialog | Ying-Kai-Liao `src/session.mjs:665-677` | Weaker than ours: OK only for the confirmed click's own dialog naming the target |
| Auto-click a close control on a covering overlay | Ying-Kai-Liao `src/page-model.mjs:15-24` | Escape, the outside press and naming the covering layer's controls (plan 087) cover it without clicking on our own |
| Wait for network idle | Ying-Kai-Liao `src/session.mjs:187-198` | Slower than the placeholder and change waits |
| Two-stage selection on big pages | Ying-Kai-Liao `src/session.mjs:412-430`; fastbrowse `docs/jev.md:143-159` | On-screen listing keeps us far under the option limit |
| `likely_done` bands, "needs verification" results | Ying-Kai-Liao `src/session.mjs:705-724`; wy-coliney | `done_when` plus the screenshot look already gate done |
| Regex risk gates | jiawei686 `safety.py:57-65`; nexibeo `extension/lib/policy.js:49` | Weaker than the model-judged risk and its verified baseline |
| A run-wide authorization flag | fastbrowse | Conflicts with one confirmed click per answer |
| Switch to the runner-up option on repeats | jkudish/jev-browser | Bypasses the feedback and hand-back path |
| HTML, markdown or ARIA output; Jev-ranked long reads; parallel page reads | jkudish/jev-browser; Ying-Kai-Liao `src/prune.mjs`; MaciejWiatr | chrome-devtools covers deep reading; viewport `page_text` is deliberate |
| Stateless HTTP MCP, several model transports | jkudish/jev-agent-tools | Sessions keep a tab across calls; OpenRouter drops screenshot `assets`, so Box would not run |
| Stable refs and delta tables for the caller | jiawei686 | Built for an agent clicking step by step, not for Jev |
| Research and classification profiles, pacing, config file | forvela | Out of scope |
| A multi-client installer and `.mcpb` bundle | jiawei686 `install.py` | [D1](#d1) one-liners cover it with less to maintain |
