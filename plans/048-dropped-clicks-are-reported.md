# Plan 048: A click the browser silently drops is reported as such, never as "the page didn't change"

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 75378ce..HEAD -- src/browser/tab.ts src/task/run-task.ts verify/reader.ts` must be
> empty, except that plan 047 may have added one reader check to `verify/reader.ts`. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (every DOM click and tap goes through this path) · **Category**: bug / observability
- **Planned at**: commit `75378ce`, 2026-10-16

## Why this matters

For about 24 minutes on 2026-10-16 (12:01–12:25 UTC), SauceDemo's tab in headless Chrome got **no input at all** from CDP. This was
diagnosed live:
- `Input.dispatchMouseEvent` press and release were accepted without error, but capture-phase listeners registered
  before the page's own scripts recorded no `pointerdown`, `mousedown` or `click`.
- The page itself was fine: `elementFromPoint` returned the right button, there was no overlay, the tab was visible and
  focused, and rAF ran at 60 fps.
- A synthetic `.click()` still worked.
- Then the problem went away. The root cause is unknown; most likely a browser or site condition outside jev-browse.

jev-browse couldn't tell. Every click "ran", the page didn't change, and after three of them the run ended `blocked` with
"The last 3 actions did not change the page". The checkout suite (gate R3) fell to 3/18. We spent time chasing a
"missing-zip regression" and an "early stop on the product list" that were both dropped clicks.

A calling agent given that reason would rephrase the goal, which can't help. Given "the browser dropped the click", it
would retry or tell the user.

The fix: before each click or tap on an observed element, record whether the page received trusted pointer input. If
the page received none, stop with a reason that says so.

There is **no automatic retry**. A click the page did receive but our counter missed must never run twice: a "Pay"
button pressed twice is the exact harm the irreversible-click gate exists to prevent.

## Current state

- `src/browser/tab.ts`:
  - `Tab.attach(cdp, targetId)` creates every tab, both `open` and `find`. It calls `Emulation.setFocusEmulationEnabled`.
  - `send(method, params)` is public. `#call` and `#evaluate` are private.
  - `#input(action, text)` resolves the target with `RESOLVE_TARGET`. Unless `target.focused`, it presses with either:
    - touch: `touchStart`, `sleep(TAP_MS)`, `touchEnd`; or
    - mouse: `mousePressed` then `mouseReleased`, each `{ type, x: target.x, y: target.y, button: 'left', clickCount: 1 }`.

    Fills then type keys.
  - `clickAt(point, page)` is the opt-in coordinate click for canvas and iframes. It stays **out of scope**, because an
    iframe's events never reach the top window.
  - Errors: `StalePage` and `TargetUnreachable extends StalePage`.
- `src/task/run-task.ts`, around the `act` call:
  ```ts
          } catch (error) {
            if (!(error instanceof StalePage)) throw error;
  ```
  Any other error reaches the outer `catch (error) { return stop('blocked', describeError(error)); }`. `describeError`
  gives `Browser error: <message>`. So a new error class that does **not** extend `StalePage` already ends the run
  `blocked` with its message, and `run-task.ts` needs no change. Check this by reading the code before relying on it.
- Reader suite `verify/reader.ts` (real headless Chrome, no model). Checks call `tab.act(action, page)` and read
  `window.__fixture`. `Tab.send` is public, so a check can call `tab.send('Input.setIgnoreInputEvents', { ignore: true })`.
  That CDP command makes the browser drop input exactly like the live failure.
- Edits to this repo's own (non-vendored) TS carry no special marker. Match the file's style: short comments, `#private` methods.

## Scope

**In scope**: `src/browser/tab.ts`, `verify/reader.ts`, `verify/fixture/reader/` (reuse an existing fixture if one fits,
e.g. `repeated-actions.html`, which records clicks in `window.__fixture.added`), `AGENTS.md` (one invariant sentence),
`skill/jev-browse/SKILL.md` (only if its blocked row needs the new reason; one clause at most).

**Out of scope**: `clickAt`, `src/task/run-task.ts` (STOP if it turns out to need a change), `src/jev/*`, `snapshot.js`, the
suites' jobs. Do not run `verify:langfuse` or touch the Chrome on ports 9333 and 9444.

## Git workflow

Commits: `test: show that a click the browser drops is reported`, `fix: report a click the page never received instead of retrying blind`.
No AI attribution. Do NOT push.

## Steps

1. **Reader check, failing first.** Add `'a click the browser drops is reported, not counted as done'` using
   `repeated-actions.html` or a fixture of your own with one button that records the click in `window.__fixture`. In it:
   - observe, then `tab.send('Input.setIgnoreInputEvents', { ignore: true })`;
   - `await assert.rejects(tab.act(button, page), /no input/i)`;
   - the fixture state shows no click;
   - `tab.send('Input.setIgnoreInputEvents', { ignore: false })`, observe again, act: the click lands. Turn input back on
     in a `finally`.

   Run `pnpm verify:reader`: the new check fails (today `act` resolves). Commit 1.
2. **The input counter.** In `Tab.attach`, register a tiny script with `Page.addScriptToEvaluateOnNewDocument` (enable
   `Page` first if needed) and also evaluate it once in the current document. Registering first means the page's own
   listeners can't stop ours. The script installs capture-phase listeners on `window` for `pointerdown`, `mousedown` and
   `touchstart` that increment `window.__jevInput` when `event.isTrusted`. Guard against installing twice. The page
   sees nothing else; no other behaviour.
3. **The check.** In `#input`, around the press (both the touch and the mouse branch; not when `target.focused`):
   - read `window.__jevInput` before;
   - press as today;
   - read it after.
   - If the after-read fails (context destroyed: the click navigated) or returns a different number, the click was
     delivered. Also treat `undefined` after a defined before as delivered: a new document means it navigated.
   - Otherwise throw a new `InputNotDelivered extends Error`. It must not extend `StalePage`, so the loop doesn't
     re-observe and retry. Message: `The page received no input from the click on "<label>": the browser dropped it, so nothing was clicked. Retry the call or check the browser.`
   - One-line comment: the counter was registered before the page's scripts, so only a browser that never delivered the
     input leaves it unchanged, and the press is never repeated, because an unseen delivered click must not run twice.

   Run `pnpm verify:reader`: all pass, including the new check and every existing check that clicks. Run `pnpm test` and
   `pnpm typecheck`: both pass.
4. **AGENTS.md**, next to the commit-risk invariant: "A click or tap the page never received (no trusted `pointerdown`/
   `mousedown`/`touchstart` reached a counter registered before the page's scripts) ends the run `blocked` with that
   reason; it is never retried automatically." If SKILL.md's `blocked` row would mislead an agent about this, add at most
   one clause; otherwise leave SKILL.md alone. Commit 2.
5. **Measure.** Run each of these headless (the model key is in the gitignored `.env`; never read or print it):
   - `pnpm verify`: expect 8/8.
   - `pnpm verify:gotchas`: strict per profile; the churn profile re-renders pages under the counter.
   - `pnpm verify:redteam`: expect `violations: 0`.
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana`: expect 8/8.
   - `CI=1 JEV_GRAFANA_RUNS=1 JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana`: the touch path; report it, the baseline is about 7/8.
   - `CI=1 JEV_CHECKOUT_RUNS=3 pnpm verify:checkout`: report per job, and say whether any run ended with the new reason.

   Report the extra latency per click if you can measure it (two `evaluate` calls).

## Done criteria

- [ ] reader all pass, with the new check failing first; `pnpm test` and `pnpm typecheck` exit 0; `pnpm verify` 8/8; red-team 0 violations
- [ ] Grafana desktop 8/8 and phone reported; gotchas strict reported; checkout per job reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- Any existing reader check that clicks now fails (a false "not delivered").
- `run-task.ts` turns out to catch the new error somewhere and retry it.
- Grafana desktop below 8/8, or gotchas strict below 29/30 on any profile.

## Maintenance notes

- If a real site ever gives false "not delivered" reports (input routed to a same-origin iframe the snapshot listed),
  narrow the check, never add a retry.
- If the live failure returns, the new reason makes it visible in every suite's report. Its root cause (Chrome or site)
  is still open.
