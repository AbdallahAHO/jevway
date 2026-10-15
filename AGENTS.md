# jev-browse

MCP server + CLI that hands browser goals to TypeSafe Jev (one `/v1/systemone` request per step) and returns a short summary to the calling agent.

## Commands
- `pnpm test`: offline unit tests (vitest), no key needed
- `pnpm typecheck` / `pnpm build` (emits `dist/`, copies `snapshot.js`)
- `pnpm verify`: live, headless Chrome + real Jev; needs `TYPESAFE_API_KEY` (costs credits, about 30 s). `JEV_MODEL=<profile>` runs it on another model via `OPENROUTER_API_KEY` (also Jev without `TYPESAFE_API_KEY`); `JEV_VERIFY_MIN_CONFIDENCE` overrides the threshold for experiments
- `pnpm verify:langfuse`: sixteen read-only jobs (an AI engineer's flows) in Langfuse's demo project from its home page, 3 runs each, recorded (video + described steps) into one `report.html`. Needs a Chrome signed in to cloud.langfuse.com on a debugging port (`JEV_LANGFUSE_BROWSER`, default `http://127.0.0.1:9333`); `JEV_LANGFUSE_RUNS`, `JEV_LANGFUSE_ONLY` narrow it. A pass needs the page check **and** status `done`
- `pnpm verify:real`: live public sites (Wikipedia, MDN, GitHub, Hacker News, npm, Booking.com, Google Flights), a fresh headless Chrome per run, 5 runs each; `JEV_REAL_RUNS`, `JEV_REAL_ONLY` narrow it. Bot walls are reported apart from failures
- `pnpm mcp` / `pnpm cli -- --help`: run from source (Node ≥24 strips types natively)

## Layout
- `src/browser/`: CDP over the global WebSocket (`cdp.ts`), Chrome connect/launch (`chrome.ts`), guarded tab executor (`tab.ts`), and `snapshot.js` (vendored from jev-ultrafast; keep it diffable)
- `src/jev/`: action space, instructions, `box.ts` (Box answers → viewport rects → observed targets), `decide.ts` (one request: operation + speculative target/value/commit-risk/done-check heads), and `model.ts` (decision model profiles: Jev direct or via OpenRouter, plus Clef, Perplexity and GPT-6 Luna deciders: route, threshold, rules, screenshots, per-element risk)
- `src/task/`: `run-task.ts` loop and hand-back rules (incl. Box stops, rescue, Enter after search typing); `start-task.ts` connects the browser; `recording.ts` writes the optional human record (`recordDir`: screencast `run.mp4` via ffmpeg, step shots, `index.html`)
- `src/journeys/`: journey mapping; `screen-boxes.ts` adds Box primary-action hotspots and missing-from-DOM QA
- `src/mcp.ts`, `src/cli.ts`: entry points; `skill/`: the agent-facing skill; `verify/`: live e2e plus the fixture

## Invariants
- `tab.want(values)`: an off-screen link, button or row containing a supplied value is listed anyway (clicking scrolls it in), so a value the caller found in a table isn't lost below the fold.
- Model output only selects observed ids/keys. Never turn it into selectors, coordinates, scripts, or typed text. Box answers are mapped back to observed ids (`matchTarget`). The one exception is opt-in `allowCoordinateClicks`: BLOCKED, a confident box that matches no observed element, a hit-test at its centre, and the commit-risk gate.
- PRESS_ENTER is a fixed key, offered only right after typing into a search-like field, and pressed only while that field still has focus. PRESS_ESCAPE is a fixed key offered only while an observed element is expanded (menu, popover, suggestions).
- Loop guards, generic rather than per site: a target covered by a popup layer (or while something is expanded) gets one automatic `dismissPopup` (Escape to the focused element, then blur and a synthetic outside press on `body`; focus is never moved first, it re-opens search suggestions); a target unreachable on an unchanged page is told to Jev on the 2nd miss and handed back (`blocked`) on the 3rd; an unsure WAIT still waits; one action toggling the page A/B 4×, or the same element used 6 times in 7 actions, is `blocked`; a rejected DONE goes into history as "not visible yet"; 6 executed actions in a row under 0.5 confidence is `uncertain`; `done_when` ≥ 0.9 once, or ≥ 0.75 on 3 consecutive decisions, is `done`.
- TYPE_TEXT types only `values[key]` from the caller. A missing value becomes `needs_input`.
- `done` requires the `done_when` Noul ≥ 0.5 when `done_when` is given.
- Verification asserts ground truth (`window.__fixture`, URL), never the agent's own status alone.
- Screenshot marks come only from snapshot rects and are removed before any input. The image never yields coordinates.
- Recorded (`sharp`) screenshots are for people only and never go into a request.
- Thresholds and rules are tuned per model. Jev's `NEXT_ACTION`, 0.3 and page-level commit risk are its verified baseline, so don't retune them on other models' data. Jev's chosen click is also judged by name (`pageRisk`), and it is risky if either question says so. The loop guards in `GUARDS` (run-task.ts) are Jev-only provisional baselines.
