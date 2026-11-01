# Plan 088: A run stops when the caller cancels or a time budget passes, never mid-input

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/mcp.ts`: the `browser_task` handler is `async ({ goal, url, tab, … record_dir }) => {` with no second argument,
>   and calls `await entry.task.run()`.
> - `src/task/run-task.ts`: `while (executed < maxSteps) {` and `return stop('step_budget', \`Reached ${maxSteps} actions without finishing\`)`.
> - `src/jev/decide.ts`: `export type Ask = (\n  request: SystemOneRequest,\n) => Promise<…>` and `client.systemOne(request)`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (touches the loop's waits and every Jev request; no new action) · **Category**: safety
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

`docs/prior-art.md` S1: "A client that times out leaves the run clicking." Today:
- The `browser_task` handler takes no `extra` (`src/mcp.ts:74`), so the MCP SDK's per-request `signal`
  (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:177`) is ignored. The SDK aborts it on
  `notifications/cancelled` and on transport close (`dist/esm/shared/protocol.js:174`, `:259`).
- The loop is bounded only by `max_steps` (`src/task/run-task.ts:350`): up to 40 actions and 80 decisions.
- The SDK client's own default request timeout is 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC`, `protocol.js:8`). Our longest
  recorded call took 59.6 s (below), so a default client can give up while the run keeps acting in the user's Chrome
  (`auto` mode), with nobody reading the result.
- The TypeSafe SDK (0.7.0) retries 408/429/5xx twice and honours `Retry-After` up to 60 s (`maxRetryAfterMs: 6e4`,
  `node_modules/@typesafe-ai/sdk/dist/index.mjs:54-67`); its backoff `sleep` and each attempt honour a caller `signal`
  (`RequestOptions.signal`, `index.d.mts:228-231`; `index.mjs:101-113`, `:1061`). We pass none (`src/jev/model.ts`,
  `askWith` in `src/jev/decide.ts:135-138`).

Seen elsewhere: jkudish `src/navigate.ts:593-614` (signal + deadline, Retry-After capped at 5 s), forvela
`src/loop.js:226-240`, nexibeo `extension/lib/agent.js:47-50`.

## Current state

- `BrowserTask.run()` → `#loop()`; waits: `#awaitChange` (`changeWaitMs`, 1.5 s, polling `observe()`), a 300 ms sleep
  after a rejected DONE, `MODEL_RETRY_MS` (800 ms) before the one retry of a transient model error.
- Jev requests: `#decide` → `decide(this.#ask, …)`; `decide` may send follow-ups through the same `ask`. Every rejection
  is wrapped in `ModelCallError` → `Model error: …`. `#lastLook` swallows errors.
- Inputs: `tab.act`, `tab.clickAt`, `tab.dismissPopup` (twice: the covered-target Escape, `closeMenuBeforeDone`).
- `#awaitChange` is called after every executed action and before a `needs_input`/`blocked` hand-back.
- Screenshots: `tab.markedScreenshot` inside `#decide` (model) and `Recording.step` (for people, before each input).

Run durations measured over every summary in `verify/out/` (n = 26 164 calls, all suites to 2026-10-18): p50 2.4 s,
p95 10.0 s, p99 16.6 s, p99.9 27.0 s, **max 59.6 s**.

## Decisions

1. **One stop signal per call.** `run({ signal })` takes the caller's optional `AbortSignal`. `#loop` builds its own
   `AbortController` that aborts when the caller's signal does, or when a `setTimeout` of `maxSeconds` fires (a plain
   timer, so tests can fake it; cleared when the call ends). Which one fired picks the stop:
   - caller → `blocked`, reason `Cancelled by the caller`.
   - time → `step_budget` (the `TaskStatus` set is unchanged), reason
     `Reached the time budget of ${maxSeconds} s (max_seconds) after ${executed} actions without finishing`.
   The budget is per call, like `max_steps`. The signal is not stored past the call, so the session's next call starts
   with a fresh one and works normally.
2. **`max_seconds`, default 300.** MCP `max_seconds` (integer 1–3600), CLI `--max-seconds`, `TaskOptions.maxSeconds`
   (`update()` can change it like `maxSteps`). 300 s is 5× the longest call ever measured (59.6 s) and above a 40-step
   worst case (80 decisions × ~2.5 s plus waits), so it never clips a healthy run; it is a backstop for a caller that
   neither cancels nor disconnects.
3. **Where the run checks.**
   - At the top of every loop iteration (before each decision).
   - Right before every input (`act`, `clickAt`, each `dismissPopup`). A stop found there discards the step's recording
     shot (the action never ran).
   - Inside waits: `#awaitChange`, the rejected-DONE pause and the model-retry pause end early on the signal (they
     resolve, they don't throw), and the next check stops the run.
   - Jev requests: `#decide` hands `decide` an `ask` bound to the signal: the signal goes into the SDK's
     `RequestOptions.signal` (cancels the HTTP request, its retries and any `Retry-After` sleep), and the promise is also
     raced against the signal, so a client that ignores it still can't hold the run. An aborted request becomes the
     stop, never `Model error`. `#decideWithRetry` and `#lastLook` pass the stop through instead of retrying or
     swallowing it.
   - Model screenshots in `#decide` are raced against the signal too (the overlay removal in `markedScreenshot`'s
     `finally` still runs).
4. **Never mid-input.** `act`, `clickAt` and `dismissPopup` never see the signal and are never raced. An input in
   flight finishes; the observe after it runs (its change-wait ends early), so the step is reported with
   `page_changed`, then the run stops. This keeps the `InputNotDelivered` rule: nothing is retried, nothing is cut.
5. **Protocol timeouts keep their path.** `observe()` and CDP calls are not raced; a protocol call that times out is
   still `Browser error: …`. `observe()`'s own waits are bounded already (placeholders 1.5 s, settle deadline).
6. **MCP.** The handler takes `extra` and passes `extra.signal` to `run`. Each session keeps the promise of its running
   call; a later call on the same session waits for it before `update()`, so a cancelled run that is still winding down
   (an input in flight) never overlaps the next call or sees its options. A cancelled request gets no response (the SDK
   drops it); the stop still lands in the recording (`summary.json`, `index.html` heading) and in the session history.
7. **CLI.** `--max-seconds`; Ctrl-C (SIGINT) aborts the run once, so it ends `blocked` "Cancelled by the caller", prints
   the summary and closes its tab.
8. **`decide.ts` stays almost untouched**: only `Ask` gains an optional second argument `{ signal }` and `askWith`
   passes it to `client.systemOne`. `decide()` itself is not changed.

## Scope

**In scope:** `src/task/run-task.ts` (options, `run`, the checks, waits, `#decide`), a small new
`src/task/run-limit.ts` (the per-call stop signal), `src/jev/decide.ts` (`Ask`, `askWith`), `src/mcp.ts`, `src/cli.ts`,
`test/`, `verify/run.ts` + a fixture page, `src/browser/chrome.ts` (expose the debugging endpoint for the live
scenario), `AGENTS.md`, `README.md`, `skill/jev-browse/SKILL.md`.

**Out of scope:** cancelling `runner.start()` (opening the tab, ≤15 s navigation); journeys; any new status.

Never read `.env`.

## Git workflow

1. `docs: add plan 088 stop on cancel or time budget`
2. `test: a run stops on cancel or time budget, never mid-input`
3. `feat: stop a run when the caller cancels or max_seconds passes`
4. `test: cancel a live MCP run and check nothing ran after it`

Lowercase conventional commits; no AI attribution; do not push.

## Steps

### 1. Tests first (`test/jev-browse.test.ts`, new `test/mcp.test.ts`)

- Aborted before a step: no Jev request, no action, `blocked` "Cancelled by the caller".
- Aborted during a wait (WAIT on an unchanged page, `changeWaitMs` 30 s): the run ends within a second.
- Aborted during a Jev request (an `ask` that never answers): `blocked` "Cancelled by the caller", the `ask` got a signal
  and it is aborted; never `Model error`.
- Budget hit mid-run (fake timers, each decision 1 s, `maxSeconds` 2.5): `step_budget`, reason names the time budget,
  two actions ran.
- An input in flight finishes: `act` takes 500 ms and the cancel lands during it; the action is in `steps`, no other
  action runs, `blocked` "Cancelled by the caller".
- The session's next call after a cancel runs normally and ends `done`.
- MCP: `browser_task` passes `extra.signal` to `run`; a client cancel aborts it (mocked runner, in-memory transport).

### 2. Implement (decisions above). `pnpm typecheck`, `pnpm test`.

Docs: AGENTS.md Invariants (a new clause), README (`browser_task` arguments, CLI, status table), SKILL.md (status table),
the `max_seconds` zod description.

### 3. Live check

New `pnpm verify` scenario "MCP stdio: a cancelled browser_task stops acting": a fixture page with ten "Step N" buttons
recording each press with its time in `window.__fixture`. The MCP server shares the verify Chrome (`JEV_BROWSER` = its
endpoint). Call 1 presses Step 1 (gets the session). Call 2 on the session presses the rest and is cancelled once
`__fixture` shows two more presses. Ground truth: at most one press (the one in flight) lands after the cancel, none
later than 1 s after it, and the run's `summary.json` (record_dir) ends `blocked` "Cancelled by the caller" with as many
executed steps as presses. Call 3 on the same session ends `done`.

## Done criteria

- [ ] new tests red first; `pnpm typecheck`, `pnpm test` exit 0
- [ ] `pnpm verify` all pass including the new scenario; red-team 0 violations; gotchas strict per profile
- [ ] no input is raced or aborted (review `act`/`clickAt`/`dismissPopup` call sites)

## STOP conditions

- A cancel or time stop reported as `Model error` or `Browser error`.
- Ground truth shows an action that started after the cancel.
- A red-team violation.

## Maintenance note

Every new wait in the loop must use the run's pause (`limit.pause`), and every new input must be preceded by the stop
check; a new model call goes through `#decide`. `runner.start()` (opening the start URL) is not cancellable; if callers
cancel during slow navigations, thread the signal into `Tab.navigate` next.
