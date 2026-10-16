# Plan 012: Controls that appear only on hover can be chosen, and clicking them hovers first

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 38d7ae1..HEAD -- src/browser/snapshot.js src/browser/tab.ts verify/reader.ts`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (new input behaviour in the tab executor; guarded by conformance fixtures and live suites)
- **Depends on**: plans/011-hidden-inputs-by-visible-label.md (same file `snapshot.js`)
- **Category**: bug
- **Planned at**: commit `38d7ae1`, 2026-10-15

## Why this matters

Many apps reveal a control only while the pointer is over its container: panel menus in dashboards, row actions in
tables, "…" buttons on cards. The control is in the DOM with `visibility: hidden` or `opacity: 0` until `:hover`.
jev-browse never hovers, and its reader drops invisible elements, so the model cannot choose such a control. Measured on
Grafana: the "view one panel full-size" job went 0/3 — every panel's menu is
`<button aria-label="Menu for panel …" data-testid="panel-menu-button">` with computed `visibility: hidden` until hover.

## Current state

- `src/browser/snapshot.js` — `visible(e)`: `!e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })`.
  `eligible(e)` requires `visible(e)`. Off-screen elements are skipped via `outOfView(cache.clickRect(e))`.
  Actions carry `{ node, role, label, rect, kind, ... }`. Vendored edits are marked `// jev-browse:`.
- `src/browser/tab.ts` — `act(action, page, text)` → `fresh(page, action)` check → `#input(action, text)`, which runs
  `RESOLVE_TARGET` in the page (rejects targets failing `checkVisibility`, computes a point, hit-tests it, scrolls a
  clipped target into view once) and dispatches `Input.dispatchMouseEvent` `mousePressed`/`mouseReleased` at that point.
  `#call(method, params)` sends CDP commands. `clickAt` shows the mouse-event shape:
  ```ts
  for (const type of ['mousePressed', 'mouseReleased']) {
    await this.#call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  ```
- `PageAction` (in `tab.ts`) has optional fields like `expanded`, `checked`; add a new optional one here.
- Conformance suite: `verify/reader.ts` + `verify/fixture/reader/*.html` (model-free; one check per fixture).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Reader suite (no key) | `pnpm verify:reader` | all checks pass |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Gotchas | `pnpm verify:gotchas` | strict ≥ previous (normal 29/30, slow 30/30, churn 28/30) |
| Grafana | `JEV_GRAFANA_RUNS=3 JEV_GRAFANA_ONLY=view-panel pnpm verify:grafana` | per-run lines |

## Scope

**In scope**: `src/browser/snapshot.js`, `src/browser/tab.ts`, `verify/reader.ts`, `verify/fixture/reader/` (new fixtures).
**Out of scope**: `src/task/*`, `src/jev/*`, other suites' files.

## Git workflow

- Commit on the branch your reviewer gave you: `test: add hover-revealed control fixtures`, then
  `feat: hover to reveal controls that only appear on hover`. No AI attribution. Do NOT push.

## Steps

### Step 1: Fixtures (red first)

1. `hover-menu.html` — three `.panel` cards; each has `<button class="menu" aria-label="Menu for panel CPU">⋮</button>`
   styled `visibility:hidden` and `.panel:hover .menu { visibility: visible }`; clicking it opens a menu with a "View"
   item that sets `window.__fixture.viewed = '<panel name>'`. Check: an action labelled with "Menu for panel CPU" is
   listed with `hover: true`; `act` on it then on "View" sets `viewed` to `CPU`.
2. `hover-row-actions.html` — a table whose row action "Delete" has `opacity:0` until `tr:hover`. Check: listed with
   `hover: true` (the list must include it so the commit-risk gate can see it; this suite does not click it).
3. `display-none.html` — a button with `display:none` inside a hoverable card. Check: **not** listed (display:none is
   not a hover reveal).

**Verify**: `pnpm verify:reader` → checks 1–2 fail, 3 passes, all previous checks pass.

### Step 2: Read hover-revealed controls

In `snapshot.js`, treat an element as **hover-revealed** when: it would be a candidate (matches `selector`, has a role),
is `safe`, not under `[aria-hidden="true"]` or `[inert]`, not `:disabled`, has a non-empty accessible name, its own
computed style is `visibility: hidden` or `opacity: 0` (check the element and up to 3 ancestors), its
`getBoundingClientRect()` has width and height > 0 (so it is laid out, not `display:none`), and its centre is in the
viewport. List it with `hover: true` and the label suffix ` (appears on hover)`. Cap at 20 hover-revealed actions per
observation. Mark the code `// jev-browse:`.

**Verify**: syntax check (`node -e "new Function(...)"`) → exit 0; `pnpm verify:reader` → check 3 passes, 1–2 still
need step 3 for the click.

### Step 3: Hover before clicking

Add `hover?: boolean` to `PageAction` in `tab.ts`. In `#input`, when `action.hover` is true, before resolving the target:
read the element's rect in the page (via `window.__jevFast.nodes.get(action.node).getBoundingClientRect()`), send
`Input.dispatchMouseEvent` `{ type: 'mouseMoved', x, y }` at its centre, then poll (every 50 ms, up to 500 ms) until
`checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })` is true for it. Then continue with the normal
`RESOLVE_TARGET` + click. If it never becomes visible, throw `TargetUnreachable('Hovering did not reveal the control')`.
Do not change the freshness check; if `fresh()` rejects hover actions (their guard may differ before/after hover),
STOP and report rather than weakening it.

**Verify**: `pnpm verify:reader` → all checks pass; `pnpm test` → all pass.

### Step 4: Measure

`pnpm verify` → 8/8; `pnpm verify:gotchas` → strict results not below the previous run; red-team
`pnpm verify:redteam` → 0 violations (hover-revealed destructive actions must still face the commit-risk gate);
`JEV_GRAFANA_RUNS=3 JEV_GRAFANA_ONLY=view-panel pnpm verify:grafana` → report (before 0/3). The model key is in the
gitignored `.env`; never read or print it. Headless Chrome only; do not touch the Chrome on port 9333.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; `pnpm verify:reader` all pass (keyless)
- [ ] `pnpm verify` 8/8; gotchas strict not below normal 29/30, slow 30/30, churn 28/30; red-team 0 violations
- [ ] Grafana view-panel measured and reported
- [ ] `git diff --stat 38d7ae1..HEAD` lists only in-scope paths

## STOP conditions

- The freshness check rejects every hover action.
- Hover-revealed listing makes any existing reader check or live suite worse.
- The change appears to need edits in `src/task/*`.

## Maintenance notes

- Hover is a pointer move only: no click, no focus. Mobile (touch) devices have no hover; on touch devices skip the
  hover listing entirely (check `matchMedia('(hover: none)')` in the snapshot) — include this in step 2.
