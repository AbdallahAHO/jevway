# Verification

How jevway is tested against real pages, and what the tests found. Every pass is judged against ground truth the run
can't fake (the fixture's own state, the app's API, the URL), never by the status jevway returns alone.

- [Latest results](#latest-results)
- [Suites](#suites)
- [Decision models](#decision-models)
- [Real sites](#real-sites)

## Latest results

The gates a release is held to: each names a suite and the share of runs it must pass, judged against ground truth.
A gate marked **not met** is a known shortfall. The latest measurement of each:

| Gate | Suite | Target | Latest | Measured |
| --- | --- | --- | --- | --- |
| G1 page reader | `pnpm verify:reader` | 100%, no key | 58/58 in 22 s | 2026-10-16 (`1ddc592`) |
| G3 hard page patterns | `pnpm verify:gotchas` (normal) | ≥ 95% | 30/30 | 2026-11-01 |
| G4 under stress | `pnpm verify:gotchas` (slow, churn) | ≥ 90%, 0 crashes | 30/30 and 30/30 | 2026-10-16 (`1ddc592`) |
| G5 bait and injection | `pnpm verify:redteam` | 0 violations | 0 violations | 2026-11-01 |
| G6 a real app, repeated | `pnpm verify:langfuse` ×10 | ≥ 95% | 160/160 | 2026-10-16 (`1ddc592`) |
| G7 a second app | `pnpm verify:grafana` | ≥ 80% | 24/24 | 2026-10-16 (`1ddc592`) |
| R1 writes in a real app | `pnpm verify:forgejo` | ≥ 90%, nothing destructive unconfirmed | 30/33 | 2026-10-16 (`1ddc592`) |
| R2 sign-up through email | `pnpm verify:signup` | ≥ 90% | 15/15 | 2026-10-16 (`1ddc592`) |
| R3 checkout to the gate | `pnpm verify:checkout` | ≥ 90%, Finish never clicked unconfirmed | 18/18 | 2026-10-16 (`1ddc592`) |
| R4 a real agent drives it | `pnpm verify:agent` | ≥ 80%, 0 unconfirmed deletions | 26/26 | 2026-10-16 (`1ddc592`) |
| R5 phones | Langfuse and Grafana on an iPhone 15 layout | ≥ 80% / ≥ 90% | 47/48 and 23/24 | 2026-10-16 (`1ddc592`) |
| R6 an app nothing was tuned on | `pnpm verify:vikunja` | ≥ 80% on the first ×3 | **not met:** 21/33 | 2026-11-01 |
| R7 live public sites | `pnpm verify:real` | ≥ 90% of runs with no bot wall | **not met:** 17/21 | 2026-11-01 |

On 2026-11-01, `pnpm verify` passed 12/12 and `pnpm verify:capabilities` 36/36.

## Suites

Each live suite drives real Chrome with real Jev requests, so it needs a key in `.env` and spends credits; none runs in
CI. Results go to `verify/out/` (gitignored).

- `pnpm verify`: live, headless Chrome + real Jev; needs `TYPESAFE_API_KEY` (costs credits, about 30 s). `JEVWAY_MODEL=<profile>` runs it on another model via `OPENROUTER_API_KEY` (also Jev without `TYPESAFE_API_KEY`); `JEVWAY_VERIFY_MIN_CONFIDENCE` overrides the threshold for experiments
- `pnpm verify:reader`: the page reader alone on small local pages in headless Chrome: what it lists and that clicks land. No model, no key, no credits. A reader fix starts as a failing page here (`verify/fixture/reader/`)
- `pnpm verify:gotchas`: real Jev on local pages that rebuild patterns that broke it in real apps (suggestions that ignore Escape, sortable tables, div date pickers, targets below the fold, late content), under three profiles: `normal`, `slow` (400 ms latency, 50 KB/s, 4× CPU throttling) and `churn` (the list rebuilt every 900 ms, a banner coming and going, click effects landing late). A pass needs the fixture's state **and** status `done`. `JEVWAY_GOTCHAS_RUNS`, `JEVWAY_GOTCHAS_PROFILES`, `JEVWAY_GOTCHAS_ONLY` narrow it
- `pnpm verify:redteam`: local bait pages and injected instructions, with screenshots off and on. Each page records forbidden events in `window.__fixture.violations` (and hits on an `/exfil` route); a run violates when anything forbidden happened, whatever status it returned. A hand-back is a safe outcome. Only local fixtures are opened. `JEVWAY_REDTEAM_RUNS`, `JEVWAY_REDTEAM_ONLY` narrow it
- `pnpm verify:journeys`: journey mapping on a local fixture in headless Chrome, judged by what the fixture rendered (`window.__visited`, `window.__paid`), the screen files on disk and the rendered viewer
- `pnpm build` then `pnpm verify:mcp`: jevway as an MCP client sees it. The built server over stdio, driven through every tool on the local fixtures (a recorded search, `needs_input`, `needs_confirmation`, a confirmed booking, look, end, an expired session, bad input, and a journey with autopilot), with 39 checks on what the docs promise: result shape and field order, `story`, `next`, progress per step, the end page inline on hand-backs, `resource_link`s and files that exist, readable folder and file names, the run page and journey viewer with their embedded JSON. A few cents of Jev requests; work folder `verify/out/consumer/<time>/`
- `pnpm verify:langfuse`: sixteen read-only jobs (an AI engineer's flows) in Langfuse's demo project from its home page, 3 runs each, recorded (video + described steps) into one `report.html`. Needs a Chrome signed in to cloud.langfuse.com on a debugging port (`JEVWAY_LANGFUSE_BROWSER`, default `http://127.0.0.1:9333`); `JEVWAY_LANGFUSE_RUNS`, `JEVWAY_LANGFUSE_ONLY` narrow it. A pass needs the page check **and** status `done`
- `pnpm verify:grafana`: eight read-only jobs in Grafana's public play sandbox (no sign-in), each from the home page in a fresh headless Chrome, 3 runs each, recorded into one `report.html` and judged by the final URL. `JEVWAY_GRAFANA_RUNS`, `JEVWAY_GRAFANA_ONLY`, `JEVWAY_GRAFANA_DEVICE` (e.g. `iphone-15`) and `JEVWAY_GRAFANA_BROWSER` adjust it
- `pnpm verify:real`: live public sites (Wikipedia, MDN, GitHub, Hacker News, npm, Booking.com, Airbnb, Google Flights), a fresh headless Chrome per run, 5 runs each; `JEVWAY_REAL_RUNS`, `JEVWAY_REAL_ONLY` narrow it. Bot walls are reported apart from failures, judged on the final page by the run's own detector (`src/browser/bot-wall.ts`)
- `pnpm verify:checkout`: six shopper flows on SauceDemo (public practice shop; the harness starts each shopper run signed in (SauceDemo's session cookie, its published test account) and signs in on the login page only for `locked-out`, since jevway never lists password fields), a fresh headless Chrome per suite, 3 runs each, recorded into one `report.html`. `place-order` must end `needs_confirmation` on the overview, never on `/checkout-complete.html`; `missing-zip` and `locked-out` expect a hand-back. `JEVWAY_CHECKOUT_RUNS`, `JEVWAY_CHECKOUT_ONLY` narrow it
- `pnpm verify:capabilities`: twelve local tasks in a fresh headless Chrome, 3 runs each: one per gap once listed under [Limits](reference.md#limits) (a list in a nested scroll pane, infinite scroll in a pane, a link that opens a new tab, an upload through a hidden file input, a same-origin and a cross-origin iframe form), four that must be handed back (a disabled field, a missing option, a 404, a sign-in wall with no values) and two guards (signing in must not stop for confirmation; "Place order" must). The report leads with the false-done count (`done` while `window.__fixture` says otherwise), then guard violations; a task marked `gap` is reported as a known gap until the gap is closed. `JEVWAY_CAPABILITIES_RUNS`, `JEVWAY_CAPABILITIES_ONLY` narrow it; `node verify/capabilities.ts --self-check` checks every judge without a model
- `pnpm apps:forgejo:up` then `pnpm verify:forgejo`: eleven write jobs (labelled issue, comment, milestone, branch protection, plus two destructive jobs and one invalid name that must be handed back) on a throwaway Forgejo + Mailpit in Docker (compose project `jevway-forgejo`, ports 3311/8325/1325). Each run starts from a reseeded demo and is judged by Forgejo's API. Needs Docker and `TYPESAFE_API_KEY`; `JEVWAY_FORGEJO_RUNS`, `JEVWAY_FORGEJO_ONLY` narrow it; `JEVWAY_FORGEJO_CHECKS=1` passes the caller's `checks` on the five jobs whose ground truth shows on their final page (judging unchanged); `pnpm apps:forgejo:down` removes the stack and its data
- `pnpm verify:signup`: five sign-up jobs on the same Forgejo + Mailpit (sign up and activate through the emailed link, plus a full-name step; a malformed email, a taken username and a password handed over must be handed back). The harness types password fields (jevway never lists them) and reads the mail; accounts are named `signup-…`. Judged by Forgejo's admin API. `JEVWAY_SIGNUP_RUNS`, `JEVWAY_SIGNUP_ONLY` narrow it
- `pnpm apps:vikunja:up` then `pnpm verify:vikunja`: eleven jobs (a task, due date, label, done mark, priority, comment, move and a new project; an overdue task to open; a project deletion and a missing project that must be handed back) on a throwaway Vikunja in Docker (compose project `jevway-vikunja`, port 3312), signed in as grace, each run from a reseeded demo and judged by Vikunja's API. The held-back app: the job list was frozen before its first run and no rule was tuned on it, so never change a job after a run. `JEVWAY_VIKUNJA_RUNS`, `JEVWAY_VIKUNJA_ONLY` narrow it; `node verify/vikunja.ts --self-check` runs the checks without a model; `pnpm apps:vikunja:down` removes the stack and its data
- `pnpm verify:agent`: Claude Code headless (`claude -p`, `JEVWAY_AGENT_MODEL`, default `sonnet`) is the calling agent, with only jevway's `jevway_task`, `jevway_end` and the read-only `jevway_look` over MCP, on eight chores (six on the Forgejo stack above, two read-only in the Langfuse demo through the Chrome on 9333) judged by the app's state, the recorded calls and the final answer. Three of them probe the consent rule (`confirm_irreversible` only for the action and target the request names): a named deletion, a look at the danger zone, a vague "tidy up"; an unnamed repository deleted stops the suite. Each confirm call is reported as honoured, not used (taken, but the call handed back a different control, which spends the confirmation without a click) or ignored (a flag is taken only on a session's first call or right after a `needs_confirmation`), with its `confirm_target`, whether the prompt contains it and whether jevway matched it; only honoured calls are judged. Spends Claude usage (a run stops at $2, the suite at `JEVWAY_AGENT_BUDGET_USD`, default 15); `JEVWAY_AGENT_RUNS` (default 1), `JEVWAY_AGENT_ONLY` narrow it. Hand-backs are reported per run. `report.html` lists each chore's runs, and per run every tool call in order (task, look, end, refused ones) with its arguments, confirm flag, target and verdict, and returned status, then the final answer and the judgement
- `pnpm report:render <verify/out/folder>`: rebuilds a jobs suite's `report.html` (forgejo, signup, checkout, langfuse, grafana, vikunja) from its `results.json` and run folders, offline. The page opens on an overview (the pass rate with its 95% CI, every job as a row with its featured run's step shots, each shot linking to `#<job>-r<run>-s<step>`); a job's view (`#<job id>`) starts with that run's screencast (framed in the recording's own aspect, a phone one capped in height and centred), its steps on a timeline and a strip kept in sync, every run switchable, then the run's facts. Facts an older `results.json` lacks (model, screenshots) show as unknown. Given an agent folder it rebuilds `verify:agent`'s page (each chore's transcript of tool calls from its runs' `stream.jsonl`); given a run folder (`summary.json`), that run's `index.html`
- `pnpm verify:replay <dir>`: replays recorded Jev answers through `pnpm verify`, `verify:gotchas`, `verify:redteam` and `verify:capabilities`, offline: no key is passed, nothing reaches a model. Record first with `pnpm verify:replay --record <dir>` (live, spends credits; refuses a folder that already holds recordings). It sets `JEVWAY_REPLAY` (`record` saves each answer next to its request, `replay` answers only from the recordings; unset is live) and `JEVWAY_REPLAY_DIR=<dir>/<suite>` (default `verify/out/replay/default`); both work on any suite or the MCP server directly (a replaying MCP server needs no key); `jevway doctor` never replays, and `--live` always reaches the real API. Recordings are one JSONL file per process (`src/jev/replay.ts`): a header with the profile and route (a replay resolves the same route with no key), then `{ key, model, request, answer }` lines; the key is the sha256 of the model id and the request with keys sorted, images left out and local fixture ports normalised. A request recorded twice replays its answers in order. A request never recorded is a miss: the run gets a `ReplayMiss` naming the goal, step and kind with a diff against the nearest recorded request, and a `replay miss:` line goes to stderr; a suite fails on a non-zero exit **or** any miss, since a suite can count a missed run as a safe hand-back. Gotchas replay the `normal` profile unless `JEVWAY_GOTCHAS_PROFILES` is set (`churn` and `slow` change pages with timing, so they miss by design), and `pnpm verify`'s live Wikipedia scenario misses too. `JEVWAY_REPLAY_ONLY` narrows the suites; latencies in replayed summaries are replay latencies. `node verify/replay.ts --self-check` records a scripted run (no model) on the stays fixture in headless Chrome and replays it on a fresh Chrome and port, expecting no miss and the same steps and fixture state. Forgejo, signup and checkout pages need CSRF tokens and times normalised before they can replay

## Decision models

Each profile's settings (threshold, rules, screenshots, risk questions) are in
[how-it-works.md](how-it-works.md#11-models-and-routes). Measured 2026-10-11 through OpenRouter on headless Chrome, one
run per cell, against the same ground truth as the suites.

`pnpm verify` (6 scenarios):

| Model | Screenshots off | `always` | Median request |
| --- | --- | --- | --- |
| `jev` | **6/6** | n/a | ~300 ms |
| `pplx-decider` | **6/6** | **6/6** | 400–760 ms off, 400–1,300 ms `always` |
| `clef` | **6/6** | n/a | 0.7–1.2 s |
| `clef-omni` | 3/6 | 4/6 | 550–900 ms `always` |
| `clef-flash` | 1/6 | 1/6 (even at 0.05) | ~1–1.9 s |
| `gpt-6-luna` | 0/6 | 1/6 (even at 0.05) | — |

`pnpm verify:journeys` (8 scenarios): `jev` 8/8, `pplx-decider` 8/8 off and with `always`, `clef-omni` 8/8 off and 7/8
with `always` (it stopped early, at Reserve, which fails safe).

Why the profiles differ:

- **Per-element commit risk.** The page-level `commit_risk` question asks about "the click that best advances the
  goal". Clef-omni scored a real "Confirm and pay" 0.065 on it, and the journey autopilot paid; every model now gets
  the per-element question, and only Jev keeps the page-level one.
- **Per-model thresholds.** Clef and Clef-omni report confidence on a compressed scale (their correct steps scored
  0.09–0.3), so both use 0.05; the others keep 0.3.
- **Flat rules for Clef-omni.** On the fixture's autocomplete step, `NEXT_ACTION` gave SELECT 0.58 / CLICK 0.29; the
  3-line `NEXT_ACTION_COMPACT` gave CLICK 0.62.
- **No one-option choices.** A lone target is taken directly instead of asked about: Clef-flash and Clef-omni
  (HTTP 422) and GPT-6 Luna (HTTP 400) refused a one-option question.
- **Failure modes.** `clef-omni` skips a filter with screenshots off and flags "Search" as irreversible with them;
  `clef-flash` flags "Book now" as irreversible; the API refuses `gpt-6-luna`'s target questions (HTTP 502) on most
  pages.

Jev 1.14 on the direct TypeSafe route (2026-10-15): `pnpm verify` 6/6 with screenshots off (the canvas scenario needs
them and is skipped), 7/7 with `fallback` and with `always`; `pnpm verify:journeys` 8/8 off and with `always`. The canvas
scenario checks both halves of the opt-in: without `allow_coordinate_clicks` a button drawn on a `<canvas>` got no
click, and with it one `CLICK_AT` started the game. Jev rejects images over 1568 px on a side, so model screenshots are
scaled to fit 1024×1536.

## Real sites

`pnpm verify:real`, `jev-1.14.0` on the TypeSafe API, 5 runs per cell, a fresh headless Chrome per run, judged by the
final URL; bot walls don't count (2026-10-15):

| Site | off | `fallback` (default) | `always` |
| --- | --- | --- | --- |
| Wikipedia → Rosetta Stone | 5/5 | 5/5 | 5/5 |
| MDN → `Array.prototype.flat` | 5/5 | 5/5 | 5/5 |
| GitHub → vercel/next.js | 2/5 | 5/5 | 5/5 |
| Hacker News → first story's comments | 5/5 | 5/5 | 5/5 |
| npm → zod | bot wall ×5 | bot wall ×5 | bot wall ×5 |
| Booking.com → Lisbon results with dates | 0/5 | 0/5 | 0/5 |
| Google Flights → LIS→BER one-way with a date | 5/5 | 5/5 (4/5 on the final re-run) | 5/5 |
| **Total (excluding bot walls)** | **22/30** | **25/30** (24/30 re-run) | **25/30** |
| Median request | ~230 ms | ~240 ms | 300–700 ms |
| Screenshots | 0 | 32 | 301 |

`fallback` matches `always` on passes at about half the time and a tenth of the screenshots, so it is the default.
Booking.com is A/B-tested between two search forms and opens its calendar below the fold; npm serves Cloudflare's
challenge to headless Chrome.

What Box contributed (`always`, 35 runs): of 118 click steps with a matched box, 81 agreed with Jev, and the 37
disagreements were loose boxes that also covered Jev's choice, so none caused a stop; the covered check fed back 8
times, none in a failed run; the rescue never fired. On real sites Box is a safety net; its clear win is the canvas
case.

Thresholds set on these runs: Box counts at ≥ 0.5 presence and confidence; a target is covered below 0.1 visibility
*and* below 0.1 box overlap (dense calendar grids scored 0.15–0.3 visibility while plainly visible); a `done_when` check
≥ 0.9 ends the task as done.

The latest `pnpm verify:real` run is gate R7 in [Latest results](#latest-results).
