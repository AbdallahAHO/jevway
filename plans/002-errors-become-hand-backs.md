# Plan 002: Browser and model errors end a run with a status instead of a crash

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6073e83..HEAD -- src/task/run-task.ts test/jev-browse.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the
> live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (touches the main task loop; covered by unit tests)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `6073e83`, 2026-10-15

## Why this matters

`BrowserTask.run()` drives a browser tab with one model decision per step and returns a `TaskSummary` whose
`status` tells the calling agent what to do next (`done`, `needs_input`, `blocked`, …). Today any error that
is not a `StalePage` escapes `run()` as an exception: a page that never settles (`observe()` gives up after
1 s), a Chrome DevTools error, or a model API error (seen live: HTTP 400 `max_tokens_exceeded`; also timeouts
and 5xx). Over MCP that becomes a tool error and the agent loses the session's context and history. A solid
release must never crash on a flaky page or a model hiccup: transient model errors get one retry, and
everything else ends the run as `blocked` with a clear reason, keeping the session usable.

## Current state

- `src/task/run-task.ts` — the task loop. `run()` wraps `#loop()` with recording (lines 145–150):
  ```ts
  async run(): Promise<TaskSummary> {
    await this.#recording?.start(this.#tab);
    const summary = await this.#loop();
    await this.#recording?.finish(this.#tab, summary);
    return summary;
  }
  ```
- `#loop()` starts with an unguarded observe (line ~159) and defines the `stop` closure that builds every
  `TaskSummary` (lines ~170–186):
  ```ts
    let page = await this.#tab.observe();
    ...
    const stop = (status: TaskStatus, reason: string, decision?: Decision): TaskSummary => ({
      status,
      reason,
      url: page.url,
      title: page.title,
      elapsed_ms: elapsed(),
      ...
    });

    while (executed < maxSteps) {
      if (++decisions > maxSteps * 2) return stop('step_budget', `Made ${maxSteps * 2} decisions without finishing`);
      let decision: Decision;
      try {
        decision = await this.#decide(page);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        page = await this.#tab.observe();
        continue;
      }
  ```
  and, around the action (lines ~270–276):
  ```ts
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
  ```
  Every other `await this.#tab.observe()` inside the loop is also unguarded.
- `src/browser/tab.ts:246` — `observe()` throws `new StalePage('Page did not settle within 1s')` after 25
  attempts; because it is a `StalePage`, the action catch above treats it as "re-observe", which calls
  `observe()` again outside any `try` and throws out of `run()`.
- Model calls: `#decide(page)` → `decide(ask, …)` in `src/jev/decide.ts`; `ask` is
  `client.systemOne(request)` from `@typesafe-ai/sdk`. Errors are SDK errors whose `message` starts with the
  HTTP status (e.g. `400 {"detail":{"error_type":"max_tokens_exceeded"}}`) or are network/timeout errors.
- `TaskStatus` = `'done' | 'needs_input' | 'needs_confirmation' | 'uncertain' | 'blocked' | 'step_budget'`.
  Do not add a new status (the MCP contract and docs list exactly these).
- Tests: `test/jev-browse.test.ts` with helpers `scriptedJev(steps)` (line 73; a fake `ask` that answers each
  request from a script) and `fakeTab(pages)` (line 92; a fake `Tab` whose `observe` returns pages in order).
  Pattern to copy — `test/jev-browse.test.ts:245-254`:
  ```ts
  it('waits and re-decides when the completion check rejects DONE', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'DONE', done_check: 0.1 },
      { operation: 'DONE', done_check: 0.97 },
    ]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Search', doneWhen: 'Results listed' }).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.97 });
    expect(requests).toHaveLength(2);
  });
  ```

Conventions: module-level `const` for tunables with a one-line comment above each (see `MAX_UNREACHABLE` in
`run-task.ts`); arrow helpers at the bottom of the file (see `repeatingWithoutEffect`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (61 at the planned commit + new ones) |

## Scope

**In scope**: `src/task/run-task.ts`, `test/jev-browse.test.ts`.

**Out of scope**: `src/browser/tab.ts` (do not change `observe()`'s 1 s budget), `src/jev/decide.ts`,
`src/mcp.ts`, `src/cli.ts`, any other file.

## Git workflow

- Branch: `advisor/002-errors-become-hand-backs`
- Conventional commits, lowercase, e.g. `fix: end runs as blocked on browser and model errors`. No AI
  attribution. Do NOT push.

## Steps

### Step 1: Retry a transient model error once

Add a private helper in `BrowserTask` used by `#decide`'s single call site in `#loop` (wrap the
`await this.#decide(page)` call, not `decide()` itself):
- A **transient** error: message matches `/^(5\d\d|429)\b|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i`.
- On a transient error, wait `MODEL_RETRY_MS` (const, 800, with a one-line comment) and call once more.
- Any other error (including 4xx such as 400 `max_tokens_exceeded`) is not retried.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Turn every non-recoverable error into `blocked`

Inside `#loop()`:
- Wrap the initial `let page = await this.#tab.observe();` so a failure returns a summary. Because `stop`
  reads `page`, initialise `page` with a minimal fallback before the first observe:
  `{ url: '', title: '', text: '', w: 0, h: 0, actions: [], marker: null, page_key: null, guards: {}, omitted_actions: 0, fingerprint: '' }`
  (typed as `PageState`), then assign the real page inside a `try`.
- Wrap the **whole** `while` loop body's error escape: put the `while (...) { ... }` inside
  `try { ... } catch (error) { return stop('blocked', describeError(error)); }` so any error thrown anywhere
  in an iteration (a re-observe, a non-`StalePage` action error, a non-transient model error, a second
  transient failure) ends the run with `status: 'blocked'`.
- Add `describeError(error)` at the bottom of the file: returns `Browser error: <message>` for errors from
  the tab and `Model error: <message>` for errors raised by the model call. Simplest honest way: tag model
  errors where you catch them in step 1 (e.g. rethrow `new ModelCallError(message)` — a small class defined in
  `run-task.ts`), and treat everything else as a browser error. Truncate the message to 200 chars.

Do not change any existing `return stop(...)` or the `StalePage` → re-observe behaviour for the first, normal
case; this step only catches what currently escapes.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all existing tests pass.

### Step 3: Tests

Add a `describe('errors become hand-backs', ...)` block to `test/jev-browse.test.ts` with:
1. **Settle timeout on the first observe** — a tab whose `observe` throws
   `new StalePage('Page did not settle within 1s')` → `run()` resolves with `status: 'blocked'` and a reason
   containing `did not settle`.
2. **Settle timeout after an action** — `observe` returns a page once, then throws on the next call; script a
   `CLICK` → resolves `blocked`, `steps` has 0 or 1 entries (no throw).
3. **Model 400** — an `ask` that throws `new Error('400 {"detail":{"error_type":"max_tokens_exceeded"}}')` →
   `blocked`, reason starts with `Model error: 400`, and `ask` was called exactly once (no retry).
4. **Transient model error retried** — an `ask` that throws `new Error('503 Service Unavailable')` on the first
   call and then answers `{ operation: 'DONE' }` (wrap `scriptedJev`'s ask) → `status: 'done'`, 2 calls.
5. **Two transient errors** — throws `503` twice → `blocked` with `Model error: 503`.
6. **Non-StalePage action error** — a tab whose `act` throws `new Error('Dropdown execution was not confirmed; inspect before retrying.')`
   on a `CLICK` → `blocked`, reason contains `Dropdown execution`.
Use `vi.useFakeTimers()` or keep `MODEL_RETRY_MS` small enough; if you use real timers, the suite must stay
under 2 s extra.

**Verify**: `pnpm test` → all pass, including 6 new tests.

## Test plan

The six tests in step 3, modelled on the `waits and re-decides when the completion check rejects DONE` test.
Each asserts the returned status and reason, and that `run()` resolves (never rejects).

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 with 6 new tests in `errors become hand-backs`
- [ ] `grep -n "throw error" src/task/run-task.ts` shows no remaining rethrow that can escape `run()` (any
      remaining `throw` must be inside the new outer `try`)
- [ ] `git diff --stat 6073e83..HEAD` lists only `src/task/run-task.ts` and `test/jev-browse.test.ts`
- [ ] `plans/README.md` status row updated (unless your reviewer maintains it)

## STOP conditions

- The excerpts above don't match `src/task/run-task.ts`.
- Making errors return a status appears to need a new `TaskStatus` value or a change in `src/browser/tab.ts`.
- Any existing test's expected status would have to change.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `blocked` with `Browser error:` / `Model error:` prefixes is the contract for "something broke"; the MCP
  server already returns the summary as-is, so agents see the reason and can retry the same session.
- If a new failure mode appears (e.g. CDP disconnect), it lands in the same catch; add a test rather than a
  new branch.
- Retry is deliberately once and only for transient errors; do not add exponential backoff here.
