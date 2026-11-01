# Plan 109: The jobs runner clears storage only once the start page has loaded

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `verify/jobs/runner.ts` must contain `await tab.evaluate('localStorage.clear(); sessionStorage.clear()');` right
>   after `tab = await Tab.open(chrome.cdp, startUrl, { device });`.
> - `src/browser/tab.ts` `#evaluate` must throw `new StalePage('Document changed during evaluation')` when the response
>   has `exceptionDetails`.
> - `src/browser/tab.ts` `#waitForLoad` must return as soon as `document.readyState` reads `'complete'`.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (harness setup only; jevway's behaviour for agents is unchanged) · **Category**: verify harness flake
- **Planned at**: commit `1401906`, 2026-11-01

## Why this matters

In round 11's Vikunja gate, 2 of 33 runs (mark-done #3, missing-project #2) failed in the harness's own setup with
"Document changed during evaluation", before jevway did anything (`plans/README.md`, follow-ups, "from round 11").
Since `bd2549c` that costs the run, not the suite, but it still counts as a failed run of the held-back app, so the
gate measures the harness instead of jevway.

**What is known, and what is not (offline only; Vikunja is not run for this plan):**
- Known: `#evaluate` (`src/browser/tab.ts:763`) throws that exact message only when the evaluated script itself threw
  (`exceptionDetails`). A protocol error mid-navigation ("Execution context was destroyed") becomes a `StalePage` with
  the protocol's own message instead. So in both runs `localStorage.clear()` ran on a document without storage access
  (`localStorage` throws a `SecurityError` on an opaque origin).
- Not known: which document that was. Three candidates, each consistent with the message:
  1. **`about:blank` before the start page commits.** `Tab.open` (`src/browser/tab.ts:148`) creates the target at
     `about:blank`, then `navigate(url)` polls `document.readyState` until `'complete'`; `about:blank` is already
     complete, so if `Page.navigate` answers before the new document commits, the wait returns at once.
  2. **A document being replaced right after load** (a reload on a service worker taking control, or a full redirect).
  3. **A browser error page** (`chrome-error://chromewebdata/`: opaque origin, `readyState` complete) if the app was
     briefly unreachable. Less likely here: Vikunja's `resetDemo` works through the REST API and restarts nothing.

The fix doesn't depend on which: it clears only once an http(s) document has loaded, and otherwise says where the tab
was, so a repeat names the culprit.

## Current state

`verify/jobs/runner.ts`, inside the per-run `try`:

```ts
tab = await Tab.open(chrome.cdp, startUrl, { device });
// Each run starts clean: … Login cookies stay.
await tab.evaluate('localStorage.clear(); sessionStorage.clear()');
await tab.navigate(startUrl);
await before?.(tab, job);
ready = true;
```

A throw anywhere here lands in the `catch` with `ready === false`: one is that run's error, two in a row stop the suite
(`setupFailures`).

## Design decisions

1. **Poll until the clear actually ran, rather than retry once.** A single retry fixes this only by luck: a second
   early poll can land on `about:blank` again. The expression reports whether it cleared, and the harness polls it:
   ```js
   const at = location.href;
   try {
     if (!/^https?:$/.test(location.protocol) || document.readyState !== 'complete') return { cleared: false, at };
     localStorage.clear(); sessionStorage.clear();
     return { cleared: true, at };
   } catch { return { cleared: false, at } }
   ```
   A `StalePage` thrown by `evaluate` (the document changed mid-call) counts as "not yet" too. Any other error (a
   timed-out call) is rethrown at once, and so is a closed connection, which `#evaluate` also wraps in `StalePage`
   ("Browser connection closed"): the runner's connection-lost path sees it without a 15 s wait.
2. **No origin is asserted.** An apex-to-www or sign-in redirect is legitimate, and the old code cleared whatever
   http(s) page had loaded. Only opaque or not-yet-loaded documents wait.
3. **A deadline of 15 s** (the same as `navigate`'s load wait), polled every 100 ms. Past it the function throws
   `could not clear storage: the start page did not settle (last at <href>)`, which is that run's setup error, so
   `bd2549c`'s "one setup failure is that run's error, two in a row stop the suite" is unchanged.
4. **Home: an exported function in `verify/jobs/runner.ts`**, `clearStorageWhenSettled(tab, { deadlineMs, pollMs })`,
   taking `Pick<Tab, 'evaluate'>` so a test can pass a fake. No change in `src/`. Follow-up, not a known bug: check
   whether `Page.navigate` can answer before the new document commits; if so, `#waitForLoad` returns early for every
   `tab.navigate` caller (agents too, where `observe()` recovers).

## Scope

**In scope:** `verify/jobs/runner.ts` (the setup line and the new function), a new `test/runner-setup.test.ts`.

**Out of scope:** `src/browser/tab.ts` (`#waitForLoad`, `Tab.open`), `before` hooks, `verify/vikunja.ts` and its jobs,
any live suite.

Never read `.env`.

## Git workflow

Branch `wt/exec-harness`. Commits:
1. `docs: add plan 109 a run starts after the start page settles`
2. `test: the runner clears storage only on a loaded start page`
3. `fix: clear a run's storage once the start page has loaded`

Lowercase conventional commits. No AI attribution of any kind. Do NOT push.

## Steps

### 1. Tests first (`test/runner-setup.test.ts`)

A fake tab with a scripted queue of answers for `evaluate`, and `pollMs: 1`:
- **A document that changed mid-call is retried.** The first evaluate throws `StalePage('Document changed during
  evaluation')`, the second returns `{ cleared: true, at: 'http://localhost:3312/' }`: it resolves to that address
  after 2 calls.
- **about:blank waits.** `{ cleared: false, at: 'about:blank' }`, then the start page still loading, then cleared:
  resolves after 3 calls.
- **Never settles.** Every evaluate answers `about:blank` with `deadlineMs: 20`: it rejects with
  `could not clear storage: the start page did not settle (last at about:blank)`.
- **A closed connection is not waited out.** An evaluate that throws `Error('Browser connection closed')`, or the same
  message as a `StalePage`, rejects with it after one call.

Run them red (the export doesn't exist). Commit 2.

### 2. The fix

Add `clearStorageWhenSettled` to `verify/jobs/runner.ts` with JSDoc (the business rule and an example) and replace the
bare `tab.evaluate('localStorage.clear(); sessionStorage.clear()')` with `await clearStorageWhenSettled(tab)`. Keep the
comment on why storage is cleared from inside the page. `pnpm typecheck`, `pnpm test`, `pnpm build` pass. Commit 3.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` exit 0, with the new tests red first
- [ ] `git diff --stat main` lists only the in-scope paths and this plan
- [ ] The next Vikunja gate (run by the reviewer, not here) shows no "Document changed during evaluation" setup error

## STOP conditions

- The fix needs a change in `src/` to work.
- A test needs a live browser.

## Maintenance note

If a setup error with "did not settle" shows up, the start page stayed on `about:blank` or never reached
`readyState === 'complete'` for 15 s: look at the app first. When `#waitForLoad` learns to wait for the new document to
commit, this poll still holds and usually succeeds on its first call.
