# Plan 019: A launched Chrome that can't be connected to is cleaned up, and connecting never hangs

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 5822f71..HEAD -- src/browser/chrome.ts src/browser/cdp.ts test/chrome.test.ts test/cdp.test.ts`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (launch/connect failure paths only; unit-tested offline)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5822f71`, 2026-10-16

## Why this matters

jev-browse can launch its own throwaway Chrome (`launch` / `launch-headless`, used by CI and every headless suite).
A previous plan made closing it never hang and made a launch that never reports its DevTools address clean up after
itself. Two failure paths remain:
1. Chrome reports its DevTools address, but the WebSocket connection to it fails (`CdpConnection.open` rejects): the
   launch throws, and the Chrome process and its temporary profile directory are left behind. Repeated in CI or an MCP
   session, this piles up orphan Chromes (one was found running a day later in this repo's own runs).
2. `CdpConnection.open` has no time limit: an endpoint that accepts the TCP connection but never completes the
   WebSocket handshake (a wedged Chrome, a wrong port that something else holds) makes `connectChrome` wait forever —
   for `auto`, explicit `http://…`/`ws://…` endpoints, and launches alike.

## Current state

- `src/browser/chrome.ts` — `launchChrome` (excerpt):
  ```ts
  const chrome = spawn(chromeExecutable(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await readDevToolsEndpoint(chrome).catch(async (error) => {
    // Chrome started but never reported DevTools: don't leave it or its profile behind.
    await stopChrome(chrome);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
    throw error;
  });
  const cdp = await CdpConnection.open(endpoint);
  return { cdp, close: async () => { cdp.close(); await stopChrome(chrome); try { rmSync(profile, …) } catch {} } };
  ```
  `stopChrome(child, graceMs = 5_000)` is exported (never hangs, never rejects). `chromeExecutable()` honours
  `process.env.CHROME_PATH` first. `readDevToolsEndpoint` resolves on a stderr line `DevTools listening on ws://…`.
- `src/browser/cdp.ts`:
  ```ts
  static open(endpoint: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true });
      socket.addEventListener('error', () => reject(new CdpError(`Cannot connect to ${endpoint}`)), { once: true });
    });
  }
  ```
  `CdpError` is exported. The file already has a per-call timeout `CALL_TIMEOUT_MS` (30 000) with a one-line comment;
  follow that style.
- Tests: `test/chrome.test.ts` (spawns `process.execPath -e …` children; `it.skipIf(process.platform === 'win32')`
  for signal-dependent cases) and `test/cdp.test.ts` (fake socket via `CdpConnection.wrap`). Vitest, real timers unless
  a test needs fake ones.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (92 before) |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |

## Scope

**In scope**: `src/browser/chrome.ts`, `src/browser/cdp.ts` (`open` only), `test/chrome.test.ts`, `test/cdp.test.ts`.

**Out of scope**: `stopChrome`, `send`, the call timeout, `start-task.ts`, `mcp.ts`, the verify suites.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `fix: give up connecting to a browser that never completes the handshake`
  2. `fix: stop a launched chrome that can't be connected to`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Connecting has a time limit

Change `open` to `static open(endpoint: string, timeoutMs = OPEN_TIMEOUT_MS)` with a new const
`OPEN_TIMEOUT_MS = 15_000` and a one-line comment (a wedged browser or a port held by something else must not hang
the launch). If neither `open` nor `error` fires within `timeoutMs`: close the socket (`socket.close()`, ignore errors)
and reject with `new CdpError(\`Cannot connect to ${endpoint}: no handshake within ${timeoutMs} ms\`)`. Clear the timer
on `open` and on `error`.

Test in `test/cdp.test.ts` (real timers): start a `node:net` server on `127.0.0.1:0` that accepts connections and
never writes; `await expect(CdpConnection.open(\`ws://127.0.0.1:${port}/devtools/browser/x\`, 200)).rejects.toThrow('no handshake within 200 ms')`;
close the server (destroy accepted sockets) in a `finally`.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass, 1 new test. Commit 1.

### Step 2: A launch whose connection fails cleans up

In `launchChrome`, give the `CdpConnection.open(endpoint)` call the same cleanup as the endpoint read: on rejection,
`await stopChrome(chrome)`, remove the profile (`try { rmSync(…) } catch {}`), rethrow the original error. Keep it
readable: one small local `abandon` (or similarly named) async helper used by both catches is fine; no new exports.

Test in `test/chrome.test.ts` (skip on Windows): a **fake Chrome binary**, no real Chrome:
1. Write an executable script into a fresh `mkdtempSync(join(tmpdir(), 'fake-chrome-'))` directory: a shebang
   `#!/usr/bin/env node` script that (a) writes `JSON.stringify({ pid: process.pid, profile })` to the file named in
   `process.env.FAKE_CHROME_OUT`, where `profile` is the value of its `--user-data-dir=` argument, (b) writes
   `DevTools listening on ws://127.0.0.1:1/devtools/browser/fake\n` to **stderr**, (c) stays alive
   (`setInterval(() => {}, 1000)`). `chmodSync(path, 0o755)`.
2. Set `process.env.CHROME_PATH` to it and `process.env.FAKE_CHROME_OUT` to a temp file; restore both afterwards.
3. `await expect(connectChrome('launch-headless')).rejects.toThrow('Cannot connect')` (port 1 refuses).
4. Read the out file: assert `existsSync(profile) === false`, and that the process is gone
   (`expect(() => process.kill(pid, 0)).toThrow()`).
5. Remove the fake directory in a `finally`.

**Verify**: run the new test against the **old** `launchChrome` first (stash only your chrome.ts edit) → it fails on
the profile or process assertion; restore → passes. `pnpm test` → all pass. Commit 2.

### Step 3: Measure

`pnpm typecheck`, `pnpm test` (report the count), `pnpm verify` → 8/8 (every suite launches Chrome through this path).
The model key is in the gitignored `.env`, loaded by the npm script; never read or print it.

## Test plan

Two offline unit tests: a silent TCP server proves the handshake timeout; a fake Chrome binary proves the connect-
failure cleanup (red on the old code). `pnpm verify` guards the normal launch.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0 (2 new tests; the step 2 test shown red before the fix)
- [ ] `pnpm verify` 8/8
- [ ] `git diff --stat 5822f71..HEAD` lists only the four in-scope paths

## STOP conditions

- The fake-binary test can't run without real Chrome or network access.
- A test needs more than 2 s of waiting.
- The fix seems to need changes outside the four in-scope files.

## Maintenance notes

- Every failure between `spawn` and a returned handle must stop Chrome and remove its profile; a future step added to
  `launchChrome` (e.g. a version check) goes inside the same cleanup.
- Never kill Chrome processes by name pattern in tests; other suites and the user's own Chrome share the machine.
