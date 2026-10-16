# Plan 051: On touch screens, controls that appear only on hover are listed and revealed by a pointer move

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat d55c418..HEAD -- src/browser/snapshot.js src/browser/tab.ts verify/reader.ts` must be empty;
> otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (more listed controls on every phone page) · **Category**: bug (phones, gate R5)
- **Planned at**: commit `d55c418`, 2026-10-16

## Why this matters

Gate R5 needs Grafana on a phone (iphone-15) at ≥ 90%. It was 21/24 at round 5, and the miss is `view-panel` at 0/3:
"Open the Logs Demo Dashboard and view one of its panels on its own".

A diagnosis on 2026-10-16 found the cause:
- Grafana's panel menu (`<button aria-label="Menu for panel Total Info Logs">`) has `visibility:hidden` and
  `opacity:0` until its panel header is hovered or focused.
- jev-browse lists such controls as "(appears on hover)", but only when `(hover: none)` doesn't match. Under phone
  emulation it matches, so the phone list holds nothing for any panel, and the model never sees a way into one.

Under CDP touch emulation a `mouseMoved` still applies `:hover` and reveals the menu, with no click or focus side
effect. A touch tap on the header reveals it too, but a tap on a container can activate it (a row that opens, a card
that navigates), so the pointer move is the safer reveal.

Prototyped in a scratch copy with the two changes below:
- the phone list showed "Menu for panel Total Info Logs (appears on hover)" (6 hover-only entries on that page; 3 on
  Grafana home, 1 on Explore, 0 on the dashboards list and alert rules);
- acting on it opened the menu, and acting on "View" gave `viewPanel=`;
- live, view-panel went 0/3 → 1/3. All 3 runs opened the menu; 2 then chose "Inspect" (a submenu) instead of "View".

That is a separate decision issue, to be measured after this change, not fixed here.

## Current state

- `src/browser/snapshot.js` (~line 251):
  ```js
  // jev-browse: a control shown only while its container is hovered (a panel's menu, a row's Delete) is in the DOM with
  // visibility:hidden or opacity:0. It is listed as "appears on hover", capped at 20, and the executor moves the pointer
  // onto it before the click. display:none is not laid out and touch screens have no hover, so neither counts.
  const canHover = !matchMedia('(hover: none)').matches;
  ```
  `canHover` is used only in `revealedByHover`.
- `src/browser/tab.ts` (`#input`, ~line 359):
  `if (action.hover && !this.#touch) await this.#revealByHover(action);`.
  `#revealByHover` moves the pointer (`Input.dispatchMouseEvent` `mouseMoved`) to the control's centre, waits up to
  500 ms for it to become visible, and otherwise throws `TargetUnreachable('Hovering did not reveal the control')`. Its
  comment says "a touch screen, which has no hover, skips it."
- Reader: `'a panel menu that appears only on hover is listed as such, and clicking it hovers first'` (`hover-menu.html`,
  desktop) is the pattern to copy. Checks take an optional `device: 'iphone-15'` (see the touch-tap check).

## Scope

**In scope**: `src/browser/snapshot.js` (the `canHover` line and its comment), `src/browser/tab.ts` (the reveal condition and
its comment), `verify/reader.ts` (one phone check). **Out of scope**: the 20 cap, `#revealByHover`'s logic, menus' decision
logic, instructions. Do not run `verify:langfuse` or touch the Chromes on 9333 and 9444.

## Git workflow

Commits: `test: list and reveal a hover-only panel menu on a phone`, `fix: reveal hover-only controls on touch screens with a pointer move`.
No AI attribution. Do NOT push.

## Steps

1. **Reader check, failing first.** Add `'on a phone, a panel menu that appears only on hover is listed and revealed by a pointer move'`
   with `device: 'iphone-15'` and `hover-menu.html`. It asserts the same as the desktop check: the menu is listed with
   `hover: true` and the "(appears on hover)" suffix, acting on it lists "View", and acting on View sets
   `window.__fixture.viewed`. Run `pnpm verify:reader`: the new check fails. Commit 1.
2. **The change.**
   - In `snapshot.js`, drop the `(hover: none)` condition. Keep a `canHover` name only if it still reads well, or
     inline it.
   - Update the comment: "touch screens list them too: the executor reveals them with a pointer move, which touch
     emulation still applies as :hover; a tap could activate the container".
   - In `tab.ts`, reveal on touch too: `if (action.hover) await this.#revealByHover(action);`, and fix the
     `#revealByHover` comment to match.
   - Run the snapshot syntax check (`node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"`)
     → 0; `pnpm verify:reader` → all pass; `pnpm test` and `pnpm typecheck` → pass. Commit 2.
3. **Measure**, headless; the model key is in the gitignored `.env`, so never read or print it:
   - `CI=1 JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` (3 runs per job) → per job against 21/24. Report what
     view-panel's misses choose on the open menu.
   - `CI=1 pnpm verify:grafana` (desktop, 3 runs) → expect 24/24.
   - `pnpm verify:gotchas` → strict per profile.
   - `pnpm verify` → 8/8.
   - `CI=1 JEV_CHECKOUT_RUNS=2 JEV_CHECKOUT_DEVICE=iphone-15 pnpm verify:checkout` → report. This is a second phone site,
     to look for extra noise from more listed entries; no baseline.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader all pass, with the new check failing first; `pnpm verify` 8/8
- [ ] Grafana phone and desktop, gotchas and phone checkout reported
- [ ] `git diff --stat` lists only the three in-scope paths

## STOP conditions

- Grafana desktop below 23/24, or Grafana phone below its 21/24 baseline.
- Any existing reader check fails.

## Maintenance notes

- A site that reveals a control only inside `@media (hover: hover)` can't be revealed on touch. It stays unreachable,
  and the unreachable guard hands it back; it is never clicked blind.
- If phone pages start listing many hidden-for-other-reasons controls (off-canvas menus), the 20 cap bounds it;
  consider listing hover-only controls on touch only inside a container that holds visible content.
