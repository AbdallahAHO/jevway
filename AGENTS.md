# jev-browse

MCP server + CLI that hands browser goals to TypeSafe Jev (one `/v1/systemone` request per step) and returns a short summary to the calling agent.

## Commands
- `pnpm test`: offline unit tests (vitest), no key needed
- `pnpm typecheck` / `pnpm build` (emits `dist/`, copies `snapshot.js`)
- `pnpm verify`: live, headless Chrome + real Jev; needs `TYPESAFE_API_KEY` (costs credits, about 30 s). `JEV_MODEL=<profile>` runs it on another model via `OPENROUTER_API_KEY` (also Jev without `TYPESAFE_API_KEY`); `JEV_VERIFY_MIN_CONFIDENCE` overrides the threshold for experiments
- `pnpm mcp` / `pnpm cli -- --help`: run from source (Node ≥24 strips types natively)

## Layout
- `src/browser/`: CDP over the global WebSocket (`cdp.ts`), Chrome connect/launch (`chrome.ts`), guarded tab executor (`tab.ts`), and `snapshot.js` (vendored from jev-ultrafast; keep it diffable)
- `src/jev/`: action space, instructions, `decide.ts` (one request: operation + speculative target/value/commit-risk/done-check heads), and `model.ts` (decision model profiles: Jev direct or via OpenRouter, plus Clef, Perplexity and GPT-6 Luna deciders: route, threshold, rules, screenshots, per-element risk)
- `src/task/`: `run-task.ts` loop and hand-back rules; `start-task.ts` connects the browser
- `src/mcp.ts`, `src/cli.ts`: entry points; `skill/`: the agent-facing skill; `verify/`: live e2e plus the fixture

## Invariants
- Model output only selects observed ids/keys. Never turn it into selectors, coordinates, scripts, or typed text.
- TYPE_TEXT types only `values[key]` from the caller. A missing value becomes `needs_input`.
- `done` requires the `done_when` Noul ≥ 0.5 when `done_when` is given.
- Verification asserts ground truth (`window.__fixture`, URL), never the agent's own status alone.
- Screenshot marks come only from snapshot rects and are removed before any input. The image never yields coordinates.
- Thresholds and rules are tuned per model. Jev's `NEXT_ACTION`, 0.3 and page-level commit risk are its verified baseline, so don't retune them on other models' data.
