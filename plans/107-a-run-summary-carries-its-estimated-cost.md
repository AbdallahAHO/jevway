# Plan 107: A run summary carries its estimated cost and the model it used

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/task/run-task.ts` must declare `jev: { requests: number; input_tokens: number; median_latency_ms: number; screenshots: number };`
>   in `TaskSummary`, and build the `jev` block in two places: `stop()` (`input_tokens: this.#inputTokens - tokensBefore`)
>   and the evidence request's `counted` summary (`input_tokens: summary.jev.input_tokens + inputTokens`).
> - `src/jev/model.ts` must export `MODELS`, `resolveModel` and `profileOptions`.
> - `verify/jobs/report.ts` must have the run fact `fact('Cost', …)` and the overview `figures` block.
>
> Otherwise STOP.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW (two new summary fields and report text; no request, decision or
  guard changes) · **Category**: observability
- **Planned at**: commit `e158571`, 2026-11-01

## Why this matters

A caller and a reviewer can see how many tokens a run used (`summary.jev.input_tokens`), but not what that costs, nor
which model answered: the model shows only in a report's footer, never in a summary. Every cost figure in our plans is
worked out by hand (plan 102: "1.68M input tokens (~$0.07)"; plan 100: "median 1.4k, about $0.00006 each").

- `docs/prior-art.md` [K5](../docs/prior-art.md#k5): "`est_cost_usd` from tokens and a per-profile price, the model the
  API reports back". Seen in jkudish/jev-browser `src/navigate.ts:127-136`, which computes
  `(input_tokens / 1e6) * PRICE_PER_MTOK_IN`, with the price from `src/lib.ts:207-208`:
  "jev-1.12 published pricing: input $0.042 per M tokens, output free."
- Our own arithmetic matches that rate: 1.68M tokens at $0.042/M is $0.0706 (plan 102's "~$0.07"); 1.4k at $0.042/M is
  $0.0000588 (plan 100's "about $0.00006").

**Source note:** the brief for this plan said `docs/prior-art.md` cites $0.042. It doesn't: K5 names the idea and
points at jkudish's code, where the rate is written. That code (and plans 100 and 102, which used the same rate) is the
only place a price is written down in this repo or its prior art.

## Current state

- `src/task/run-task.ts:93`: `jev: { requests, input_tokens, median_latency_ms, screenshots }`.
- **How tokens are summed today:** `decide()` (`src/jev/decide.ts:168-176`) adds the decision request's
  `usage.input_tokens` and every follow-up's (the value and file heads, Box's target check and rescue, per-element
  commit risk) into `decision.inputTokens`. `run-task.ts` adds that once per decision (`this.#inputTokens +=
  decision.inputTokens`), and the done's evidence request separately (`this.#inputTokens += inputTokens`, then the
  `counted` summary). A screenshot rides inside its decision request: it is not a separate request. So `input_tokens`
  already covers every request, each once.
- The SDK (`@typesafe-ai/sdk` 0.7, `Usage`) reports `input_tokens` and `output_tokens`, both `number | null`, and the
  result's `model`. Our `Ask` type keeps only `usage.input_tokens`.
- `BrowserTask` never sees the profile: `profileOptions(profile)` is spread into its options (`start-task.ts`, every
  verify harness).
- `src/mcp.ts` and `src/cli.ts` print the whole summary as JSON. The tool description lists no `jev` field.
  `README.md:98` shows a `jev` block.
- `verify/jobs/report.ts`: a run's `Cost` fact is "N Jev requests · Nk input tokens · s · ms median request"; the
  overview has four figures (pass rate, flaky jobs, median run, requests per run).

## Decisions

1. **Price table** in `src/jev/model.ts`, next to `MODELS`, keyed by **model id** (what `profile.model` resolves to),
   USD per 1M input tokens. Keyed by id, not profile name, so Jev's two routes can be priced apart.
   - `jev-1.14.0` (Jev on the TypeSafe API): **$0.042**. Comment: Jev's published rate (written for jev-1.12 in
     jkudish/jev-browser `src/lib.ts:207`, prior art K5; output free), applied to 1.14 as an estimate, not billing.
   - `typesafe/jev-1.14` (Jev through OpenRouter): **$0.042** too, decided on review (2026-11-01): OpenRouter passes the
     provider's price through; any margin it adds is unchecked, so it is an estimate like the direct route.
   - Clef, Clef-flash, Clef-omni, pplx-decider, GPT-6 Luna: **no price** (none written in the repo). Cost `null`.
2. **Input tokens only.** Jev's published output price is free, and no other model has a price, so an output column
   would be dead code. Summing `output_tokens` would also widen `Ask` and touch `decide.ts`. Follow-up if a priced
   model ever bills output.
3. **`model` is `profile.model`**, the id every request is sent with, passed through `profileOptions` as a new
   `TaskOptions.model`. A task built without one (unit tests, a harness that builds options by hand) reports `null`.
   The API's own `model` echo is not used (it would widen `Ask`).
4. **`est_cost_usd`**: `input_tokens × price / 1e6`, rounded to 6 decimals; `null` with no price. Computed in both places
   the `jev` block is built, from that block's own `input_tokens`, so the evidence request is in it.
5. **Report**: a run's cost is the sum over its calls' `est_cost_usd`; one call without it (`null`, or a summary saved
   before this plan) makes the run's cost unknown, since a partial sum would read as the whole. The Cost fact gains
   "est. $…" or "est. cost unknown". The overview's fourth figure slot keeps four figures in the four-column grid: the
   requests figure moves into the median-run figure's label, and the fourth shows the median est. cost per run with
   the total in its label ("est. per run, median · $… total"), or "unknown" when no run has one; when only some runs
   have one, the label says over how many. `results.json` keeps its shape; old folders render unknown.

## Scope

**In scope:**
- `src/jev/model.ts`: the price table, `estimateCostUsd`, `model` in `profileOptions`.
- `src/task/run-task.ts`: `TaskOptions.model`, the two `jev` fields in both builders. Nothing else.
- `verify/jobs/report.ts` (and `report-page.ts` only if a style is needed).
- Tests: `test/cost.test.ts` (new), one `describe` in `test/jev-browse.test.ts`, `test/report.test.ts`.
- `README.md` (the `browser_task` return example, the report paragraph), `AGENTS.md` (layout line for `model.ts`).

**Out of scope:**
- Jev's requests, decisions, thresholds, `GUARDS`. `decide.ts` and the `Ask` type.
- Journeys' `jev` block (`journey-session.ts`), `recording.ts`'s request count, `verify/agent.ts`'s report.
- Anything Vikunja (`verify/vikunja.ts`, `verify/apps/vikunja/`).
- Live suites: none are run for this plan.

Never read `.env`.

## Git workflow

Branch `wt/exec-cost`. Commits:
1. `docs: add plan 107 a run summary carries its estimated cost`
2. `test: a run summary and the report carry the estimated cost`
3. `feat: report each run's estimated cost and the model it used`
4. `docs: describe est_cost_usd and the model in summaries and reports`

Lowercase conventional commits. No attribution trailers of any kind. Do NOT push, do NOT merge.

## Steps

### 1. Tests first

- `test/cost.test.ts`:
  - 1M input tokens on `jev-1.14.0` cost 0.042; 7,534 cost 0.000316 (6 decimals); 0 cost 0.
  - `typesafe/jev-1.14` costs the same as `jev-1.14.0`; `cloudflare/clef-omni` and an unknown id cost `null`.
  - `profileOptions` of the direct Jev route carries `model: 'jev-1.14.0'`; of the OpenRouter route `typesafe/jev-1.14`.
- `test/jev-browse.test.ts`, a new `describe` after "model choice": a scripted run (100 tokens per request) with
  `model: 'jev-1.14.0'` and a done with evidence: `summary.jev` has `model: 'jev-1.14.0'`, `input_tokens: 200`,
  `est_cost_usd: 0.000008`; the same run with an unpriced model gives `est_cost_usd: null`; without `model`, `model: null`.
- `test/report.test.ts`: the fixture summary gains `model` and `est_cost_usd`; the run's Cost fact shows "est. $…";
  the overview shows the median per run and the total with "est."; a run whose summary has no `est_cost_usd` (an old
  folder) shows "est. cost unknown"; re-rendering a saved `results.json` without the fields still renders, unknown.

Run red. Commit 2.

### 2. Implement

As in Decisions. `pnpm typecheck`, `pnpm test`. Commit 3.

### 3. Docs

`README.md`: the `jev` block in the example gains `"screenshots": 0, "model": "jev-1.14.0", "est_cost_usd": 0.000316`, and
one sentence on what `est_cost_usd` is (an estimate from the published input rate; `null` for a model without one).
The report paragraph mentions est. cost per run, median and total. `AGENTS.md`: the `model.ts` layout entry names the
price table. Commit 4.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first
- [ ] no price in the table that isn't written in this repo or its cited prior art
- [ ] `pnpm report:render` on an old folder (or the re-render test) shows unknown, not $0
- [ ] `git diff --stat main` lists only the in-scope paths

## STOP conditions

- Summing the cost would need a change to `decide.ts`, the `Ask` type or any request.
- A price would have to be guessed.

## Maintenance note

The table is an estimate from a published rate, not billing. When TypeSafe or OpenRouter publish a different rate (or
Jev starts billing output), change the table entry and its comment; old summaries keep the cost they were run with.
