# Plan 016: Closing a launched Chrome never hangs, even when Chrome already exited

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat bbfae1d..HEAD -- src/browser/chrome.ts test/`
> On any output for `src/browser/chrome.ts`, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (process shutdown only; unit-tested with real child processes)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `bbfae1d`, 2026-10-16

## Why this matters

jev-browse can launch its own throwaway Chrome (`--browser launch` / `launch-headless`, the default for every
headless suite and CI). Closing it waits for the child's `exit` event **after** sending the kill signal. If Chrome
already exited (crashed, was killed, or closed itself), that event fired earlier and never fires again, so `close()`
waits forever.

Where users hit it: the MCP server's shutdown (`src/mcp.ts`) is
```ts
const shutdown = async () => {
  await runner.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
```
and `runner.close()` (`src/task/start-task.ts`) awaits the Chrome handle's `close()`. So when a launched Chrome dies
during a session, the MCP server never exits after its client disconnects: an orphan Node process per crash. The CLI
and every verify suite (`await chrome.close()` in a `finally`) hang the same way. A related leak in the same function:
if Chrome starts but never prints its DevTools address within 15 s, the launch fails but the Chrome process and its
temporary profile directory are left behind.

The protocol client (`src/browser/cdp.ts`) was already made never-hang in an earlier plan (calls on a closed socket
reject at once; every call times out after 30 s). This plan gives the process handle the same guarantee.

## Current state

- `src/browser/chrome.ts` (104 lines) — `launchChrome`:
  ```ts
  const launchChrome = async (headless: boolean): Promise<ChromeHandle> => {
    const profile = mkdtempSync(join(tmpdir(), 'jev-browse-'));
    const args = [ `--user-data-dir=${profile}`, '--remote-debugging-port=0', /* … */ 'about:blank' ];
    const chrome = spawn(chromeExecutable(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await readDevToolsEndpoint(chrome);
    const cdp = await CdpConnection.open(endpoint);
    return {
      cdp,
      close: async () => {
        cdp.close();
        chrome.kill();
        await new Promise((resolve) => chrome.once('exit', resolve));
        rmSync(profile, { recursive: true, force: true });
      },
    };
  };

  const readDevToolsEndpoint = (chrome: ChildProcess) =>
    new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome did not start within 15s')), 15_000);
      chrome.stderr!.on('data', (chunk) => { /* resolve on "DevTools listening on ws://…" */ });
      chrome.once('exit', (code) => reject(new Error(`Chrome exited (${code}) before DevTools started`)));
    });
  ```
  `ChromeHandle` is `{ cdp: CdpConnection; close: () => Promise<void> }`. `cdp.close()` calls `WebSocket.close()`, which
  is a no-op on an already-closed socket (safe).
- Node facts the fix relies on: a `ChildProcess` that has exited has `exitCode !== null` or `signalCode !== null`;
  `exit` is emitted once. `child.kill()` sends SIGTERM and returns `false` if the process is already gone.
- Conventions: one-line comments above non-obvious steps; JSDoc with an `@example` on exported functions (see
  `connectChrome` and `CdpConnection.wrap` in `src/browser/cdp.ts`, whose JSDoc says it exists for tests). Tests use
  vitest; the closest exemplar is `test/cdp.test.ts` (one `describe`, short `it` names stating behaviour).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Live repro (step 1, step 5) | the script in step 1 | prints `closed in N ms` (after the fix) |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |

## Scope

**In scope**: `src/browser/chrome.ts`, `test/chrome.test.ts` (new).

**Out of scope**: `src/browser/cdp.ts`, `src/task/start-task.ts`, `src/mcp.ts`, `src/cli.ts`, the verify suites.
Connecting to an existing Chrome (`auto`, `http://…`) is unchanged: its `close()` only closes the socket.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `fix: never hang closing a launched chrome that already exited` (chrome.ts change + its tests)
  2. `fix: stop a launched chrome that never reported devtools`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Reproduce the hang (red)

Save this as a scratch file **outside the repo** (e.g. `$TMPDIR/close-repro.ts`), and run it from the repo root with
`node $TMPDIR/close-repro.ts` (Node ≥ 24 runs TypeScript directly). Replace `<repo>` with the absolute repo path.
```ts
import { connectChrome } from '<repo>/src/browser/chrome.ts';
const chrome = await connectChrome('launch-headless');
// Chrome closes itself, as if it had crashed: the handle's close() must still return.
await chrome.cdp.send('Browser.close').catch(() => undefined);
await new Promise((resolve) => setTimeout(resolve, 1000));
const started = Date.now();
const bail = setTimeout(() => { console.log('HUNG: close() did not return in 15 s'); process.exit(1); }, 15_000);
await chrome.close();
clearTimeout(bail);
console.log(`closed in ${Date.now() - started} ms`);
```
**Verify**: prints `HUNG: close() did not return in 15 s` and exits 1. If it prints `closed in …` instead, STOP
(the bug is not what this plan says).

### Step 2: A stop that returns whatever state the process is in

In `chrome.ts`, add and export:
```ts
/**
 * Stops a launched Chrome and resolves once it is gone, never hanging: a process that already exited returns at
 * once, one that ignores SIGTERM is killed after `graceMs`. Never rejects. Exported for tests.
 *
 * @example
 * await stopChrome(child); // resolves even if Chrome crashed earlier
 */
export const stopChrome = async (child: ChildProcess, graceMs = 5_000): Promise<void> => { … };
```
Behaviour, in this order:
1. If `child.exitCode !== null || child.signalCode !== null`, return.
2. Create the "exited" promise by registering `child.once('exit', …)` **before** sending any signal.
3. `child.kill()` (SIGTERM).
4. Race the exited promise against a `graceMs` timer. If the timer wins, `child.kill('SIGKILL')` and race the exited
   promise against a second, 1 000 ms timer; then return either way.
5. Clear the timers you started so a finished stop leaves no pending timer.

Then change `launchChrome`'s `close` to: `cdp.close()`, `await stopChrome(chrome)`, then
`rmSync(profile, { recursive: true, force: true })` inside a `try { … } catch {}` (a profile that can't be removed,
e.g. a file still locked on Windows, must not make `close()` reject). Add a one-line comment on the `close` saying it
returns even if Chrome already exited.

**Verify**: `pnpm typecheck` → exit 0; re-run the step 1 script → prints `closed in N ms` with N under 1 000.

### Step 3: Unit tests (`test/chrome.test.ts`)

Use real, cheap child processes: `spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })`.
Do not launch Chrome in unit tests. Tests (use real timers):
1. **An already-exited child returns at once**: spawn `-e "process.exit(0)"`, await its `exit` event, then
   `await stopChrome(child)` resolves in under 200 ms.
2. **A running child is stopped with SIGTERM**: spawn `-e "setInterval(() => {}, 1000)"`; `await stopChrome(child)`
   resolves; `child.signalCode === 'SIGTERM'`.
3. **A child that ignores SIGTERM is killed**: spawn
   `-e "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"`, **wait for the `ready`
   line on its stdout before calling stopChrome** (otherwise the handler may not be installed yet), then
   `await stopChrome(child, 200)` resolves; `child.signalCode === 'SIGKILL'`.

Skip test 3 on Windows (`it.skipIf(process.platform === 'win32')`): Windows has no SIGTERM handler semantics.

**Verify**: `pnpm test` → all pass, 3 new tests. Commit 1.

### Step 4: A launch that never reports DevTools cleans up

In `launchChrome`, if `readDevToolsEndpoint(chrome)` rejects (the 15 s timeout, or Chrome exiting early): call
`await stopChrome(chrome)`, remove the profile (same `try/catch` `rmSync`), and rethrow the original error. Also
clear the 15 s timer in `readDevToolsEndpoint` when Chrome exits early (today only the success path clears it).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass. Commit 2.

### Step 5: Measure

1. The step 1 script → `closed in N ms`, N < 1 000 (paste the line).
2. `pnpm verify` → `8/8 scenarios passed` (every suite launches and closes Chrome through this code). The model key is
   in the gitignored `.env`, loaded by the npm script; never read or print it.
3. After `pnpm verify`, `pgrep -fl 'jev-browse-'` shows no leftover headless Chrome from this run. (Report what it
   prints; do **not** kill anything it lists — other suites may be running.)

## Test plan

Three unit tests on real child processes (step 3) cover the three exit states; the live repro (steps 1 and 5) is the
before/after proof on real Chrome. `pnpm verify` guards the normal launch/close path.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0 (3 new tests)
- [ ] Step 1 repro: `HUNG` before the change, `closed in N ms` (N < 1 000) after
- [ ] `pnpm verify` 8/8
- [ ] `git diff --stat bbfae1d..HEAD` lists only `src/browser/chrome.ts` and `test/chrome.test.ts`

## STOP conditions

- Step 1 does not hang before your change.
- A test needs Chrome, network, or a sleep longer than 2 s to pass.
- The fix seems to need changes outside `chrome.ts` (for example in `start-task.ts` or `mcp.ts`).

## Maintenance notes

- `close()` for a launched Chrome now returns within ~6 s in the worst case (5 s grace + 1 s after SIGKILL).
- Never kill Chrome processes by name pattern in tests or scripts: other suites and the user's own signed-in Chrome
  (port 9333 during suite runs) share the machine.
