# Plan 074: Don't decide on a skeleton page: wait while placeholder blocks pulse, and say so when they don't stop

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: in `src/browser/tab.ts`, `observe()` must start with `await this.#settleAfterInput();` and `SETTLE` must
> contain plan 060's `animating` check (`document.getAnimations()`, endless animations ignored). Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (adds a bounded wait before reading a page) · **Category**: bug (gate R5)
- **Planned at**: commit `913470b`, 2026-10-16

## Why this matters

At `5961f99`, Langfuse phone `trace-to-prompt` passed 1/3 in the R5 gate. A live diagnosis on 2026-10-16 (on 9333,
reproduced 2 of 2) found the cause:
- **The skeleton.** After the click on "Tracing", the reader returned 351–359 ms later. Langfuse was still drawing 8
  empty placeholder rows that pulse with an endless CSS animation. The rows themselves appear from about +700 to
  +1100 ms.
- **What the model saw.** 23 click targets, all chrome or column headers. The page text had no rows and no hint of loading.
- **The wrong click.** The model clicked `Filters 1`, the only control that isn't chrome, at 0.33–0.37. That opened a
  filter sheet with no right answer, and the run ended `uncertain`.
- **The fix, tested.** On the loaded page the same decision clicks the QA-Chatbot row at 0.99. With one added text line
  "Loading rows…" on the skeleton page, the operation head went to WAIT at 0.96–0.97 (2 of 2).

`SETTLE` waits 2 frames, or up to 400 ms for **finite** animations (plan 060). It deliberately ignores endless ones,
which is exactly what a skeleton's pulse is. Skeleton loading is the norm in modern apps.

**Detection measured on Langfuse.** Count the on-screen elements with no text that run an endless animation:

| Page | While loading | Once loaded |
|---|---|---|
| /traces | 32, gone by +1.1 s | 0 |
| /sessions | 21, gone by +1.4 s | 0 |
| home | 4 | 0 |

Every page read 0 once loaded, for 8–11 s.

## Current state

- `src/browser/tab.ts`:
  - `observe()` calls `#settleAfterInput()`, which runs `SETTLE` only after an input, then reads `READ_STATE`
    (`snapshot.js`) in a retry loop with a 2 s deadline (plan 061).
  - `SETTLE` (search `const SETTLE`) contains plan 060's
    `animating=()=>document.getAnimations().some(a=>a.playState==='running' && a.effect?.getComputedTiming().endTime!==Infinity)`.
- `PageState.text` is the visible text that the reader collects.
- `snapshot.js` is vendored and must stay diffable. Don't change it.
- `TaskOptions.changeWaitMs` defaults to 1500.
- Reader checks: `{ name, file, run }` in `verify/reader.ts`, with fixtures in `verify/fixture/reader/`.

## Scope

**In scope:**
- `src/browser/tab.ts`: a placeholder wait in `observe()`, and the loading line added to the returned state.
- `verify/reader.ts`.
- `verify/fixture/reader/skeleton-table.html` (new).
- `AGENTS.md`: one clause.

**Out of scope:**
- `snapshot.js`.
- The loop guards.
- Plan 060's finite-animation wait.

Use 9333 only when your reviewer says so. Never read `.env`.

## Git workflow

Commits:
1. `test: a page drawn as pulsing placeholders is read once its rows arrive`
2. `fix: wait while placeholder blocks pulse, and say so when they stay`

No AI attribution. Do NOT push.

## Steps

1. **Fixture and checks, failing first.** Create `skeleton-table.html` with:
   - a button "Tracing" whose click replaces the content with 8 empty `div`s running `animation: pulse 1s infinite` (no
     text). After 900 ms these are swapped for 5 real rows (links "Trace 1" … "Trace 5");
   - a second button "Forever" that shows 8 pulsing blocks that never resolve.

   Check `'a skeleton is read once its rows arrive'`: act on "Tracing", then `observe()`. "Trace 1" must be listed.

   Check `'placeholders that never stop end the wait and are named'`: act on "Forever", then time the `observe()`. It
   must return within 2.5 s, and `page.text` must contain `Loading: 8 placeholder blocks on screen`.

   Run reader: the first check fails (rows not listed yet), and the second fails (no line). Commit 1.

2. **The wait.**
   - In `observe()`, before reading the state, evaluate a page-side count: elements that are on screen (rect intersects
     the viewport, width and height above 0), have no trimmed `textContent`, and are the target of a running animation
     whose `endTime` is `Infinity`.
   - While the count is **3 or more**, poll every 100 ms up to a cap of 1500 ms, measured from the observe's start.
   - If the cap expires with 3 or more still pulsing, prefix the returned `text` with
     `Loading: N placeholder blocks on screen\n`. Do it after `READ_STATE`, in `tab.ts`, before the fingerprint is
     computed.
   - Every observe pays one cheap evaluate. Only a page that is actually showing placeholders waits.
   - One comment marked `// jev-browse:`: a page drawn as pulsing placeholders has not loaded what the user came for, so
     reading it now invites a click on whatever chrome is listed. The wait is capped, and a page that keeps pulsing is
     named as loading.
   - AGENTS.md: add one clause next to the invariants about reading pages.

   Reader, `pnpm test` and `pnpm typecheck` → pass. Commit 2.

3. **Measure:**
   - `pnpm verify` → 8/8.
   - `pnpm verify:gotchas` strict per profile. Also report the median step time against main; the churn profile is the canary.
   - `pnpm verify:redteam` → `violations: 0`.
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana`, desktop and `JEV_GRAFANA_DEVICE=iphone-15` → 8/8 each. Grafana
     panels have loading spinners, so report any `Loading:` line in a trace.
   - When your reviewer says 9333 is free:
     - `JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_ONLY=trace-to-prompt,session-to-user pnpm verify:langfuse`
       (trace-to-prompt against 1/3);
     - then desktop `JEV_LANGFUSE_RUNS=1 pnpm verify:langfuse` (16 jobs), checking that nothing regressed and the step
       time didn't rise sharply.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader all pass, with the new checks red first; `pnpm verify` 8/8; red-team 0 violations
- [ ] gotchas (with step times), Grafana desktop and phone, and the Langfuse phone pair and desktop ×1 reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- gotchas strict drops on any profile, or its median step time rises by more than 300 ms.
- A Langfuse or Grafana job that passed before fails, with a `Loading:` line in its trace.

## Maintenance notes

- A loaded page could still have 3 or more decorative endless animations without text (a busy dashboard). Each step on
  such a page waits 1.5 s and carries the line. Watch Grafana and the gotchas `churn` profile for it.
