# Plan 060: Wait out a menu's opening animation before listing the page

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff f35d4ca..HEAD -- src/browser/tab.ts | rg -n "SETTLE"` must print nothing. The `SETTLE`
> script must be unchanged. Plan 056 may have changed `act`; that's fine. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (adds latency after input) · **Category**: bug (gate R5, phones)
- **Planned at**: commit `551dc12`, 2026-10-16

## Why this matters

Grafana on a phone, job `view-panel`, is the one recurring miss of this round:
- 7/8 on the untouched `f35d4ca`;
- 23/24 with plan 055;
- 2/7 with the first version of plan 056.

Plan 056's executor traced it:
1. The model opens the panel menu.
2. The page is listed while the menu is still fading in. Its items have `opacity` below 1 mid-transition, so the reader lists
   them as hover-only: "View (appears on hover)".
3. The click on View goes stale, because the target's guard changes once it is fully visible. The model re-decides on a page
   that is still moving and wanders: it scrolls, or tries Inspect.

A person waits until the menu has opened before reading it. Today, after any input, `SETTLE` waits two animation frames,
capped at 50 ms (200 ms for a combobox fill while its options appear). A CSS fade or slide of 150–300 ms, which most UI
kits use for menus and popovers, is still running when the page is read.

## Current state

`src/browser/tab.ts`, run by `#settleAfterInput()` at the start of `observe()` after any input (`this.#afterInput = action` in `act`):

```js
const SETTLE = `action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{ … visible in viewport … }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
})`;
```

- The hover-only rule is in `src/browser/snapshot.js` (search `appears on hover`). A control that isn't shown (`opacity`
  0 or `visibility:hidden`) but is revealed by hovering its container is listed with ` (appears on hover)` and `hover: true`.
- Reader checks: `{ name, file, run }` in `verify/reader.ts`, with fixtures in `verify/fixture/reader/`, `tab.observe()`,
  `tab.act(action, page)` and `window.__fixture`. Copy an existing check that clicks a button and re-observes.

## Scope

**In scope:**
- `src/browser/tab.ts`: the `SETTLE` script only.
- `verify/reader.ts`.
- `verify/fixture/reader/menu-fades-in.html` (new).

**Out of scope:**
- `snapshot.js` and its hover rule.
- `fresh()` and `act()`.
- The loop guards.

Do not run `verify:langfuse` or touch the Chromes on 9333 and 9444. Never read the gitignored `.env`.

## Git workflow

Commits:
1. `test: a menu that fades in is listed once it has opened`
2. `fix: wait for a running animation to finish before listing the page`

No AI attribution. Do NOT push.

## Steps

1. **Fixture and checks, failing first.** Create `menu-fades-in.html` with:
   - a button "Panel menu" with `aria-expanded="false"`;
   - a `role="menu"` holding three `role="menuitem"` buttons, "View", "Edit" and "Inspect". The menu starts with
     `opacity:0; visibility:hidden` and `transition: opacity 250ms, visibility 250ms`;
   - a click on the button that sets `aria-expanded="true"` and adds a class giving the menu `opacity:1; visibility:visible`;
   - "View" recording `window.__fixture.viewed = true` when clicked;
   - elsewhere on the page, a spinner with an **infinite** CSS animation (`animation: spin 1s linear infinite`).

   Check `'a menu that fades in is listed once it has opened'`:
   - observe, act on "Panel menu", then `page = await tab.observe()`;
   - "View" is listed **without** `hover: true` and without the ` (appears on hover)` suffix;
   - acting on it sets `viewed`.

   Check `'an endless animation does not hold up listing'`: time `act` on "Panel menu" plus the next `observe()` with
   `performance.now()` around both. The total stays under 700 ms, so the infinite spinner adds nothing beyond the cap.

   Run `pnpm verify:reader`: the first check fails (View is listed as hover-only, or its click goes stale), and the second passes.
   Commit 1.

2. **The wait.** In `SETTLE`:
   - Finish only when frames ≥ 2, the autocomplete condition holds, **and** no finite animation is running:
     `document.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity)`
     is false.
   - The deadline starts at today's value (50 ms, or 200 ms for a combobox fill). The first time a running finite animation
     is seen, extend it once so it ends **400 ms after the input started**: clear the timer and set a new one for the time left.
   - Infinite animations (spinners, pulsing dots) never extend it.
   - One comment marked `// jev-browse:`: a menu or popover fading in is read as hover-only until it has opened, and a person
     waits for it too. The wait is capped at 400 ms, and endless animations don't count.

   Run the syntax check (`node --check` on an extracted copy, or the reader itself), then `pnpm verify:reader` → all pass,
   `pnpm test` and `pnpm typecheck` → pass. Commit 2.

3. **Measure**, headless:
   - `pnpm verify` → 8/8.
   - `pnpm verify:gotchas`, strict per profile. Also report the median step time per profile before and after, from the
     report's per-step `elapsed_ms`. A rise of more than 150 ms per step is worth reporting.
   - `pnpm verify:redteam` → `violations: 0`.
   - `CI=1 pnpm verify:grafana` (desktop) → 24/24.
   - `CI=1 JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` → 24/24. Also run
     `CI=1 JEV_GRAFANA_DEVICE=iphone-15 JEV_GRAFANA_RUNS=6 JEV_GRAFANA_ONLY=view-panel pnpm verify:grafana` → 6/6.
   - `CI=1 JEV_CHECKOUT_RUNS=2 pnpm verify:checkout` → report.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader all pass, with the fade-in check failing first; `pnpm verify` 8/8; red-team 0 violations
- [ ] gotchas (with step times), Grafana desktop and phone, and phone `view-panel` ×6 reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- gotchas strict drops on any profile, or the median step time rises by more than 300 ms on any profile.
- The fade-in check still fails after step 2: report what the reader lists for View, its `hover` flag and the opacity at
  observe time, rather than raising the cap.

## Maintenance notes

- If a site animates something finite on every frame (a carousel restarting its transition), each step waits up to
  400 ms. The gotchas `churn` profile is the canary for that.
- Langfuse desktop and phone (gate R5) are re-measured at round end on 9333.
