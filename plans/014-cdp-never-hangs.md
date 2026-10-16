# Plan 014: A dropped or stuck browser connection ends a run with a status, never a hang

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6e31730..HEAD -- src/browser/cdp.ts src/task/run-task.ts verify/jobs/runner.ts test/`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (touches the protocol client every action goes through; unit-tested)
- **Depends on**: none (plans 001–013 DONE)
- **Category**: bug
- **Planned at**: commit `6e31730`, 2026-10-15

## Why this matters

The final 160-run Langfuse confirmation stopped after 110 runs: Node exited with code 13 ("unsettled top-level
await") inside one run, with no results written. Chrome was still alive. Code 13 means every handle closed while a
promise was still pending. The chain this plan closes:
1. The DevTools WebSocket closed mid-run (cause unknown — this plan makes it visible).
2. `CdpConnection` rejects calls pending at close time, but a call made **after** the close goes to
   `socket.send()`, which the WebSocket standard says silently discards on a CLOSING/CLOSED socket — so its promise
   never settles.
3. `BrowserTask.run()` calls `recording.finish()` (a final screenshot) **outside** the error catch added by plan 002,
   so that call over the dead socket hung the process.
A solid release must turn any browser-connection failure into a status (`blocked`, "Browser error: …") and let a
suite continue with the next run.

## Current state

- `src/browser/cdp.ts`:
  ```ts
    socket.addEventListener('close', () => {
      for (const { reject } of this.#pending.values()) reject(new CdpError('Browser connection closed'));
      this.#pending.clear();
    });
  ...
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }
  ```
  The constructor is private; `CdpConnection.open(endpoint)` creates the socket. `CdpError` is exported.
- `src/task/run-task.ts`:
  ```ts
  async run(): Promise<TaskSummary> {
    await this.#recording?.start(this.#tab);
    const summary = await this.#loop();
    await this.#recording?.finish(this.#tab, summary);
    return summary;
  }
  ```
  `#loop()` already converts errors into `stop('blocked', describeError(error))` (plan 002).
- `verify/jobs/runner.ts` — loops jobs × runs on one `connectChrome(browser)` handle; each run opens a tab with
  `Tab.open(chrome.cdp, …)`. A closed connection makes every later run fail.
- Tests: `test/jev-browse.test.ts` (vitest; `fakeTab`, `scriptedJev` helpers). There is no CDP test yet.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Langfuse (shared Chrome :9333) | `CI=1 JEV_LANGFUSE_RUNS=10 pnpm verify:langfuse` | `N/160 runs passed` and a report path |

## Scope

**In scope**: `src/browser/cdp.ts`, `src/task/run-task.ts` (only `run()`), `verify/jobs/runner.ts`, a new test file
`test/cdp.test.ts`, `test/jev-browse.test.ts` (one recording-failure test).

**Out of scope**: `tab.ts`, `snapshot.js`, `src/jev/*`, the job definitions.

## Git workflow

- Commit on the branch your reviewer gave you: `fix: reject browser calls on a closed or silent connection`,
  `fix: keep a recording failure from hanging or failing a run`, `test: reconnect the jobs runner after a dropped browser`.
  No AI attribution. Do NOT push.

## Steps

### Step 1: `CdpConnection` never leaves a call pending

- In `send`: if `this.#socket.readyState !== WebSocket.OPEN`, return `Promise.reject(new CdpError('Browser connection closed'))`.
- Per-call timeout: reject with `new CdpError(\`${method} timed out after ${ms} ms\`)` and delete the pending entry if no
  reply arrives within `CALL_TIMEOUT_MS` (const, 30 000, one-line comment: a stuck renderer or dropped reply must not
  hang a run). Clear the timer when the reply or close arrives.
- On `close`, record the close code and reason; expose a read-only `closed: { code, reason } | undefined` getter and
  include them in the rejection message (`Browser connection closed (code 1006: …)`).
- Add a static test seam: `static wrap(socket: WebSocket)` that builds a connection from an existing socket (used only
  by tests; JSDoc says so).

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Tests for the client (`test/cdp.test.ts`)

Use a minimal fake socket object implementing `addEventListener`, `send`, `close`, `readyState` (cast as `WebSocket`)
passed to `CdpConnection.wrap`:
1. A call made after `close` rejects at once with `Browser connection closed`.
2. A call pending at `close` rejects with the close code in the message.
3. A call with no reply rejects after the timeout (use `vi.useFakeTimers()`; advance 30 s).
4. A normal reply resolves and clears the timer (no rejection after advancing 30 s).

**Verify**: `pnpm test` → all pass, 4 new tests.

### Step 3: Recording can't hang or fail a run

In `run()`: wrap `recording.start` and `recording.finish` each in `try/catch`; a failure is ignored for the run's
outcome (the summary is returned unchanged), and a recording that failed to finish is simply missing its final shot.
Add one test in `test/jev-browse.test.ts`: a task with a recording whose `finish` throws (stub via a fake tab whose
`markedScreenshot` rejects when `sharp` is set, `recordDir` in a temp dir) still resolves with the loop's status.

**Verify**: `pnpm test` → all pass.

### Step 4: The jobs runner survives a dropped browser

In `verify/jobs/runner.ts`, if a run ends with an error whose message contains `Browser connection closed`, close the
handle and `connectChrome(browser)` again before the next run (at most 3 reconnects per suite; then stop the suite
with a clear message). Write `results.json` and the report **even when the suite stops early**, marking runs not
executed as `error: 'not run (suite stopped)'`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 5: Measure

1. `pnpm test`, `pnpm verify` → 8/8.
2. The final confirmation that this plan unblocks: `CI=1 JEV_LANGFUSE_RUNS=10 pnpm verify:langfuse` on the shared
   signed-in Chrome (:9333; use it only through this suite; never sign in or out). Run in the foreground; it takes
   ~30 minutes, so split into two calls with `JEV_LANGFUSE_ONLY` (8 jobs each) if a call would exceed 10 minutes.
   Report pass rate with its 95% CI, failing runs, and any connection close (code/reason) that occurred.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0 (5 new tests)
- [ ] `pnpm verify` 8/8
- [ ] Langfuse 160 runs completed (results.json written); pass rate reported
- [ ] `git diff --stat 6e31730..HEAD` lists only in-scope paths

## STOP conditions

- The connection closes again during step 5 and the reconnect doesn't recover — report the close code/reason.
- A per-call timeout of 30 s rejects legitimate calls in `pnpm verify` (some CDP call takes longer) — report which.

## Maintenance notes

- 30 s is far above any normal CDP reply (screenshots ~100 ms); if a long `Runtime.evaluate` is ever needed, pass a
  larger timeout for that call rather than raising the default.
