# Plan 031: Taps last like a finger's, and a target is called covered only after several points miss

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat f91840e..HEAD -- src/browser/tab.ts verify/reader.ts verify/fixture/reader/`
> On any output, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (the input path every click/tap goes through; guarded by the reader suite and live suites)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f91840e`, 2026-10-16

## Why this matters

On an emulated iPhone 15, a diagnosis of every failing Grafana/Langfuse run found two executor causes:
1. **Zero-length taps.** On touch devices `src/browser/tab.ts` sends `touchStart` immediately followed by `touchEnd`
   with no radius. On Grafana's dashboards list, every tap on the Sort combobox put it in its open state for about two
   video frames (~70 ms) and then it closed before the option list rendered; the page never changed and the run ended
   on "The last 3 actions did not change the page" (sort-dashboards 0/3 on phone; the same control opens with a mouse
   press on desktop). Other taps worked. A real finger's tap lasts tens of milliseconds and has a contact area.
2. **One-point "covered" verdict.** Before clicking, `RESOLVE_TARGET` hit-tests only the centre of the target's
   visible box and requires the hit to be inside the target. On Grafana's phone alert list the top Search field was
   squeezed to ~54 CSS px, mostly its magnifier prefix, so its centre hit a wrapper/prefix and the field was reported
   "covered" three times (nothing was over it; alert-rules ended `blocked`). Trying a few more points inside the
   visible box — still requiring the hit to land inside the target — fixes this without loosening safety.

## Current state

- `src/browser/tab.ts`, the two touch paths:
  ```ts
  // clickAt (opt-in coordinate clicks)
      await this.#call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await this.#call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // #input (every listed-target click on touch devices)
      await this.#call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] });
      await this.#call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  ```
  A `sleep(ms)` helper exists in the file.
- `RESOLVE_TARGET` (a page-side function string):
  ```js
  const point=()=>{ const r=window.__jevFast.clickRect(e), x=r.x+r.width/2, y=r.y+r.height/2;
    return r.width && r.height && x>=0 && y>=0 && x<innerWidth && y<innerHeight && e.contains((${DEEP_HIT})(x,y)) ? {x,y} : null; };
  // A target clipped by a scrolling sidebar or list is scrolled just into view once, as a person would.
  let at=point();
  if (!at) { e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}); at=point(); }
  if (!at) { …report covered (byPopup when the hit is inside a popup layer)… }
  ```
  `window.__jevFast.clickRect(e)` is the visible part of the target's box.
- `verify/reader.ts` (model-free; checks `{ name, file, run }`; the harness opens each check's tab with
  `Tab.open(chrome.cdp, \`${origin}/${check.file}\`)`, i.e. the desktop device). Devices live in
  `src/browser/devices.ts` (`DEVICES['iphone-15']`, `mobile: true`); `Tab.open(cdp, url, { device })` emulates one and
  makes the tab tap with touch events. Add your checks right **after the hover checks** in the array (another plan adds
  checks near the top of the file in parallel; keep your hunk apart from theirs).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Reader (keyless) | `env -u TYPESAFE_API_KEY pnpm verify:reader` | `N/N reader checks passed` (34 before) |
| Live fixtures | `pnpm verify` | `8/8` |
| Grafana desktop / phone | `pnpm verify:grafana` / `JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` | 23–24/24 / 15/24 last time |
| Gotchas | `pnpm verify:gotchas` | strict 90/90 last time |

## Scope

**In scope**: `src/browser/tab.ts` (the two touch paths, `RESOLVE_TARGET`'s point search), `verify/reader.ts` (an
optional per-check device, new checks), `verify/fixture/reader/` (new fixtures).

**Out of scope**: `snapshot.js`, `src/task/*`, `src/jev/*`, the mouse path's timing, hover logic. Do not run
`verify:langfuse` or touch the Chrome on port 9333.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: add tap-duration and partly covered target fixtures`
  2. `fix: tap with a finger's duration and contact area`
  3. `fix: try several points before calling a target covered`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Fixtures and checks (red first)

- Add `device?: DeviceName` to the reader's `Check` and pass `{ device: DEVICES[check.device] }` to `Tab.open` when set.
- `tap-duration.html`: a button whose `touchstart`/`touchend` listeners record `window.__fixture.tapMs` (end minus start,
  via `performance.now()`) and `window.__fixture.radius` (`touches[0].radiusX` on start). Check (device `iphone-15`):
  `act` on the button → `tapMs >= 40` and `radius > 0`.
- `partly-covered.html`: a 54 px-wide search field (`<input aria-label="Search">`) inside a wrapper, with an absolutely
  positioned decorative `<span>` (a sibling of the input, `pointer-events: auto`) covering the input's **centre** but not
  its right third. Typing into it through `act` (kind `fill`, text `cpu`) sets `window.__fixture.value === 'cpu'` from an
  `input` listener. Check (desktop): `act` succeeds and the value is set.
- A guard check, `fully-covered.html`: a button with an overlay `<div>` covering it entirely → `act` still rejects with
  `TargetUnreachable` (covered).
**Verify**: reader → the tap check and the partly-covered check fail; the guard and the 34 existing checks pass.
Commit 1.

### Step 2: Realistic taps

In both touch paths: `touchStart` with `touchPoints: [{ x, y, radiusX: 6, radiusY: 6, force: 1 }]`, then
`await sleep(TAP_MS)`, then `touchEnd`. `const TAP_MS = 60` with a one-line comment (a finger's tap lasts tens of
milliseconds; a zero-length tap made some widgets open and close at once).
**Verify**: reader → the tap check passes. Commit 2.

### Step 3: Several points before "covered"

In `RESOLVE_TARGET`, change `point()` to try, in order, the centre of the visible box and then four more points inside
it (e.g. at 25 % and 75 % of its width and height: (25,50), (75,50), (50,25), (50,75)), returning the first whose hit
`e.contains(…)`. Same bounds checks as today. The scroll-into-view retry and the covered report stay as they are.
**Verify**: reader → all pass (34 + 3). `pnpm test` → all pass. Commit 3.

### Step 4: Measure, and one emulation fact

1. `pnpm verify` → 8/8; `pnpm verify:gotchas` → strict per profile (last 30/30 each).
2. `JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` → report per job (before 15/24: sort-dashboards 0/3,
   alert-rules 0/3, view-panel 0/3). `pnpm verify:grafana` (desktop) → report (last 23–24/24).
3. Emulation fact for the next plan: with a scratch script in `$TMPDIR` (headless, `connectChrome('launch-headless')`,
   `Tab.open(cdp, 'https://play.grafana.org/alerting/list', { device: DEVICES['iphone-15'] })`, wait 5 s), print
   `innerWidth`, `visualViewport.width`, `document.documentElement.scrollWidth`. Report the three numbers; change
   nothing based on them.
Headless Chrome only. The model key is in the gitignored `.env`, loaded by the npm scripts; never read or print it.

## Test plan

Model-free: a touch-device tap-duration check, a partly covered field that now accepts input, and a fully covered
button that must still be refused (red first where applicable). Live: Grafana phone (the target), desktop Grafana,
gotchas and `pnpm verify` as guards.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; reader all pass keyless (37), new checks red at commit 1 as stated
- [ ] `pnpm verify` 8/8; gotchas strict per profile; Grafana phone and desktop reported per job
- [ ] The three viewport numbers reported
- [ ] `git diff --stat f91840e..HEAD` lists only the in-scope paths

## STOP conditions

- The fully covered guard check passes `act` (a covered target got clicked) at any point.
- Gotchas strict below 29/30 on any profile, or Grafana desktop below 22/24.
- The change seems to need edits in `snapshot.js` or `src/task/*`.

## Maintenance notes

- Every extra hit-test point still requires the hit to be inside the target, so the "only observed elements are
  clicked" invariant holds. Taps now take ~60 ms longer each.
