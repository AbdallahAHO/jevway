# Verification (2026-09-17)

Setup: headless Chrome 152 on macOS (arm64), model `jev-latest` (answered by jev-1.13.0), and `pnpm verify` run three times in a row after the fixes below. Every pass is checked against independent ground truth: the fixture's `window.__fixture` state, read over a separate CDP session, or the page's real URL. Jev's own DONE never counts as proof.

| Scenario | Checked against | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- | --- |
| Fixture: autocomplete → select → checkbox → search → open result (7 actions, 8 Jev requests) | city, guests, filters, and unrequested breakfast filter left off; Casa Flora opened | ✔ 3.22 s | ✔ 3.06 s | ✔ 3.32 s |
| Same session: booking with the email missing → `needs_input` naming "Email address" | booking not confirmed | ✔ 0.90–1.12 s | ✔ | ✔ |
| Same session: email supplied → `needs_confirmation` on "Confirm booking and pay €412" (risk 0.88) | booking **not** confirmed | ✔ 0.61 s | ✔ 0.65 s | ✔ 0.87 s |
| Same session: `confirm_irreversible` → booking done | name, email, `confirmed: true` | ✔ 0.68 s | ✔ 0.60 s | ✔ 0.61 s |
| Live web: Wikipedia search → Gödel's incompleteness theorems | exact `/wiki/…` path | ✔ 2.19 s | ✔ 2.56 s | ✔ 2.42 s |
| MCP stdio: list tools → `browser_task` → `browser_task_end` | status `done`, session ended | ✔ 2.78 s | ✔ 2.77 s | ✔ 3.10 s |

Result: **18/18 passed.** Median Jev latency per request was 256–564 ms (typically about 300 ms). The Wikipedia task used about 40k input tokens, and the full fixture flow about 24k.

Extra check: the built CLI (`dist/cli.js`) on an unseen goal, Wikipedia → Rosetta Stone, finished `done` in 3.3 s (7 requests, done check 0.97).

## Found by the first live run and fixed

1. **Missing value surfaced as `blocked`.** Jev typed the name, then chose BLOCKED for the email. The speculative value heads already showed that no supplied value fit "Email address", so BLOCKED with such fields now returns `needs_input` naming them.
2. **Premature DONE while results were loading.** Jev chose DONE on "Searching…", and the `done_when` check correctly scored it 0.08. A rejected DONE now waits 300 ms and re-decides, up to 3 times, instead of returning `uncertain`.
3. Optional MCP/CLI arguments passed as `undefined` erased defaults, so `max_steps` became undefined.

## Not covered yet

- The `auto` browser mode against a real, logged-in Chrome. It needs the user to approve remote debugging.
- Only one real public site (Wikipedia). There are no heavy SPA sites like Google Flights, and no captcha or consent walls.
- Thresholds are based on this small sample, not on a benchmark.

## Decision models on OpenRouter (2026-10-11)

Setup: headless Chrome on macOS (arm64). Every model is reached through OpenRouter's `/api/v1/systemone` with the same TypeSafe SDK; images go in as `image_url` parts at the front of a `state` array. Each cell is **one run**. Every row checks the same ground truth as above.

### Probe (one Airbnb screenshot with a cookie wall)

| `JEV_MODEL` | OpenRouter id | Image | One-option choice | Notes |
| --- | --- | --- | --- | --- |
| `jev` | `typesafe/jev-1.13` | ✘ HTTP 400 | ✔ | ~300 ms per request |
| `clef` | `cloudflare/clef` | billed 16k tokens, 2.7 s | ✔ | images effectively unusable; 0.8–2.7 s per request |
| `clef-flash` | `cloudflare/clef-flash` | ✔ (modal 0.95) | ✘ HTTP 422 | |
| `clef-omni` | `cloudflare/clef-omni` | ✔ (modal 0.98, text-only 0.14) | ✘ HTTP 422 | |
| `pplx-decider` | `perplexity/pplx-decider-v1.1-27b` | ✔ (modal 0.999) | ✔ | `pplx-decider-v1-27b` has no endpoint (404) |
| `gpt-6-luna` | `openai/gpt-6-luna-decisions` | ✔ (modal 1.0) | ✘ HTTP 400 | |

Images cost 360–1,000 input tokens. Requests cost $0.000006–$0.0001 each.

### What the non-Jev models needed

1. **No one-option choices.** A lone target is now picked directly instead of asked about. Jev passed 6/6 with this change on `typesafe/jev-1.13` via OpenRouter. Direct `jev-latest` (the September baseline) was not re-run.
2. **Per-element commit risk.** The page-level `commit_risk` head asks about "the click that best advances the goal". Clef-omni scored the real "Confirm and pay" 0.065 on it, and the journey autopilot paid. Every model except Jev now gets one follow-up request that asks about each click candidate by name: the chosen click in `browser_task`, the top 12 ranked taps in the autopilot. An unscored or malformed answer counts as risky.
3. **Per-model thresholds.** Clef and Clef-omni report confidence on a compressed scale: their correct steps scored 0.09–0.3. Both use 0.05. The others keep 0.3.
4. **Flat rules for Clef-omni.** On the fixture's autocomplete step, `NEXT_ACTION` gives SELECT 0.58 / CLICK 0.29, while the 3-line `NEXT_ACTION_COMPACT` gives CLICK 0.62.
5. **No boxes on covered elements.** Elements under a popover get no box.

### `pnpm verify` (6 scenarios), each profile's settings

| Model | Screenshots off | `always` | Median request |
| --- | --- | --- | --- |
| `jev` | **6/6** | n/a | ~300 ms |
| `pplx-decider` | **6/6** | **6/6** | 400–760 ms off, 400–1,300 ms `always` |
| `clef` | **6/6** | n/a | 0.7–1.2 s |
| `clef-omni` | 3/6 | 4/6 | 550–900 ms `always` |
| `clef-flash` | 1/6 | 1/6 (even at 0.05) | ~1–1.9 s |
| `gpt-6-luna` | 0/6 | 1/6 (even at 0.05) | — |

Failure modes behind those numbers:

- **`clef-omni`:** with screenshots off it skips the free-cancellation filter. With `always` it flags "Search" as irreversible (0.87) and has a DONE rejected on the MCP task.
- **`clef-flash`:** flags "Book now" as irreversible (0.66–0.74). With `always` it stalls as `blocked`.
- **`gpt-6-luna`:** the API refuses its `select_target` and `click_target` questions with HTTP 502 ("OpenAI refused to answer question …") on most pages, and SDK retries don't recover.

### `pnpm verify:journeys` (8 scenarios)

| Model | Result | Intent autopilot stops before paying |
| --- | --- | --- |
| `jev` | **8/8** | ✔ reached the payment screen |
| `pplx-decider` off / `always` | **8/8** / **8/8** | ✔ / ✔ |
| `clef-omni` off / `always` | **8/8** / 7/8 | ✔ / stopped earlier, at Reserve (fails safe) |

Before per-element risk, `clef-omni` with screenshots off paid in this scenario.

### Still open

- **Fallback traces.** In `fallback`, only the screenshot-backed decision is recorded in the trace, while `jev.requests` counts both. `fallback` hasn't been measured beyond Clef-omni, where it couldn't trigger well.
- **Errors end the session.** A non-`StalePage` error from `tab.act` ("Dropdown execution was not confirmed"), or an API refusal, ends the run instead of handing back `blocked`.
- **Jev's autopilot gate.** Jev keeps the page-level commit-risk head, so its autopilot still checks only the top-ranked tap. Jev passed the journeys run 8/8, but a lower-ranked irreversible tap isn't scored.
- **Screenshots go out twice.** The per-element risk follow-up reuses the decision's `state`, so in `always` mode each click step sends the screenshot twice. That's why `pplx-decider` used 65k tokens on the fixture with `always` and 34k with screenshots off.
- **One run per cell.** Settings other than Jev's are tuned on these runs and should be re-checked on real sites.

## Jev 1.14 with images (2026-10-15)

Jev 1.14 is served on OpenRouter as `typesafe/jev-1.14-20261014`. The `jev` profile now uses it on OpenRouter; with `TYPESAFE_API_KEY` set, `jev` stays text-only on `jev-latest`. These runs used a separate `jev-1.14` profile with identical settings, before it replaced 1.13 in `jev`.

**Image input.** TypeSafe's native image format (an `assets` map with the `TypeSafe-Danger-Zone-Images` header) does not survive OpenRouter: the map is dropped. Requests the docs say must fail (an unreferenced asset, invalid base64) returned 200, and token counts matched with and without the image. OpenRouter's own `image_url` parts at the front of a `state` array do work. On "what color is the Accept all button?" Jev 1.14 put P(black) at 1.0, using about 1,000 tokens per image, with or without the header. The direct TypeSafe route would need the `assets` format and SDK 0.7.0, which isn't wired up.

**Size limit.** Jev rejects images over 1568 px on any side. A phone viewport at 2× pixel ratio came out at 786×1704, so screenshots are now scaled to fit within 1024×1536 output pixels.

| Run | Screenshots off | `fallback` (default) | `always` |
| --- | --- | --- | --- |
| `pnpm verify` | **6/6**, ~250 ms median | **6/6** (no screenshot needed) | 6/6 once, 5/6 twice |
| `pnpm verify:journeys` | **8/8** | — | **8/8** after the size fix |

The `always` misses were all the same case. Jev reached Casa Flora correctly, but with the screenshot attached its `done_when` check scored 0.35–0.46, against the 0.5 bar. Text-only, that check passes. This matches TypeSafe's note that multimodal is weaker than text, and it is why `fallback` is the default. Screenshots also picked up visual journey patterns (`bottom_navigation`) that the text-only run missed.

## Jev 1.14 on the TypeSafe API: assets, Box, and real sites (2026-10-15)

Setup: `jev-1.14.0` on the TypeSafe API with SDK 0.7.0. Screenshots go in as an `assets` image under `state.screenshot`, with `TypeSafe-Danger-Zone-Images: true`. Headless Chrome on macOS (arm64).

**Images through the direct API.** On the cookie-wall screenshot, one request with the image and 4 questions took 376 ms and 1,488 tokens:

- Modal detection: 1.0.
- Colour of "Accept all": black at 1.0.
- Box on "Accept all": 70–75 % of the height (actual ~72 %), confidence 0.77.
- Box on the search bar: 10–17 % (actual ~13 %), confidence 0.87.

Through OpenRouter, the same Jev model had answered the colour question at chance.

**`pnpm verify`, direct route**

| Mode | Result |
| --- | --- |
| off | 6/6 (the canvas scenario needs screenshots and is skipped) |
| `fallback` (default) | 7/7 |
| `always` | 7/7 |

`always` passed three runs in a row after the box-padding fix. The new canvas scenario checks both halves of the opt-in. Without `allowCoordinateClicks`, a Start button drawn on a `<canvas>` got no click (ground truth: not started, 0 misses). With the opt-in, one `CLICK_AT` "canvas @ 280,265" started the game. The box had confidence 0.93, presence 0.99 and commit risk 0.01.

**`pnpm verify:journeys`, direct route:** 8/8 with screenshots off and 8/8 with `always`. Primary-action boxes land on the expected controls ("Confirm and pay" 0.83 on checkout, "Where to?" on home). There were no `control_not_in_dom` findings, as expected: the fixture has no canvas controls.

### Real sites (`pnpm verify:real`, 5 runs each)

A fresh headless Chrome per run, with ground truth from the final URL. Bot walls don't count.

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

`fallback` matches `always` on passes, at about half the time and a tenth of the screenshots, so it stays the default. On GitHub, Jev picked the right step after typing, but at 0.15–0.28 confidence; one screenshot-backed second look per run fixed it.

**What the real sites exposed and what changed**

1. **Search fields that only submit on Enter** (GitHub, npm). PRESS_ENTER is a fixed key, offered only right after typing into a search-like field, and pressed only while that field still has focus.
2. **Controls in open shadow DOM** (MDN's `<mdn-search-button>`). The snapshot now reads open shadow roots, and every hit-test resolves through them.
3. **Autocompletes that ignore `insertText`** (Booking showed "Trending destinations" for "Lisbon"). Typing now sends real key events per character; text with line breaks keeps the one-shot insert.
4. **A typed value swallowed by a popup.** History now records `value_kept: false`, so Jev retypes instead of treating the field as filled.
5. **Busy pages with rotating content** made every retype stale. Typing now uses the element-level freshness check that clicks already used.
6. **A next-step head that wanders on after reaching the goal** (Hacker News: done check 0.91, operation "click the logo"). A `done_when` judgment ≥ 0.9 now ends the task as done.
7. **Covering banners and below-the-fold dates.** Two rules were added to `NEXT_ACTION`: dismiss covering consent and sign-in layers (preferring Decline, Reject or Close), and scroll to reveal a missing date or option before paging. The fixture still passes with them.
8. **Ground truth that passed falsely.** Google Flights put `tfs=` in the URL from the form state alone, so the check now requires `/travel/flights/search`. npm served Cloudflare's challenge at `/package/zod` itself, so a bot wall now overrides the URL.

**What Box contributed on real sites** (`always`, 35 runs):

- **Cross-check:** of 118 click steps with a matched box, 81 agreed with Jev. The 37 disagreements were all loose boxes that also covered Jev's choice (padded 16 px), so none caused a stop.
- **Covered check:** fed back as history 8 times. None of those runs failed.
- **Rescue:** never fired on these sites.

On real sites Box is a safety net, not a measured success gain. Its clear win is the canvas case, which no DOM reader can do.

**Thresholds tuned on these runs** (one machine, these sites):

- Box counts at ≥ 0.5 presence and confidence.
- A target counts as covered below 0.1 visibility *and* below 0.1 box overlap. Dense calendar grids scored 0.15–0.3 visibility while plainly visible.
- `done_when` evidence ends the task at ≥ 0.9.

### Still open

- **Booking.com is 0/5 in every mode.** It is A/B-tested between "Search in your own words" and "Enter destination", its calendar opens below the fold of a 780 px viewport, and it served a `chal_t=` challenge on 2 of 15 runs. Runs either stall at low confidence or hit the step budget.
- **npm** blocks headless Chrome with Cloudflare. In visible (non-headless) Chrome the search reached `/package/zod`, but the challenge was served there too.
- **Navigation errors end a run.** Google Flights' one failure was "Page did not settle within 1s" while opening the tab.
- **Each cell is 5 runs on one machine and one network.** Sites change their layouts.

## Langfuse in a signed-in browser, and wide table rows (2026-10-15)

Task: open the most recent trace in Langfuse's public demo project (`cloud.langfuse.com`, signed in) and show its input, output and observation tree. It's read-only.

- **In the user's own Chrome (`auto`):** handed back `uncertain` after clicking a row's "Select row" checkbox, which brought up a "Delete Traces" bar. The traces table is a 701 px scroll box whose rows are far wider, so each row's centre was off-screen and the snapshot dropped every row. Only the checkboxes were left to choose from.
- **Fix:** an element whose centre is off-screen is listed and clicked at the centre of the part that the viewport and its scroll containers leave visible. Elements whose centre is on-screen are unchanged. The new `wide-table.html` fixture lists 0 rows without the fix and 3 with it.
- **After the fix,** in a separate Chrome on a debugging port with a test account: `done` 3 times in a row, in 3.0–6.0 s, with 6–7 Jev requests (median 283–290 ms). The `done_when` check passed each time.
- **`pnpm verify`:** 8/8, including the new wide-table scenario (`done` in 0.7 s, 2 requests, no checkbox ticked).
