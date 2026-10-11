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
