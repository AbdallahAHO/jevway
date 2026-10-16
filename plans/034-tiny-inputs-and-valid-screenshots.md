# Plan 034: A control whose real input is tiny is operated through its own field box, and model screenshots always have valid dimensions

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 3c0d402..HEAD -- src/browser/tab.ts verify/reader.ts verify/fixture/reader/ test/`
> On any output for `src/browser/tab.ts`, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (the input path; every rule keeps the click inside the observed control's own box)
- **Depends on**: plan 031 (DONE)
- **Category**: bug
- **Planned at**: commit `3c0d402`, 2026-10-16

## Why this matters

On an emulated iPhone 15, Grafana scores 15/24 vs 24/24 on desktop. Live probes on 2026-10-16 (headless, read-only)
pinned two of the three failing jobs to the executor, and a third problem to screenshots:
1. **sort-dashboards (0/3)**: the listed target for the Sort combobox is its inner `<input role="combobox">`, a 4×22 px
   box. A tap on it opens the list (`aria-expanded=true` ~10 ms after `touchend`), then Chrome's compatibility
   `mousedown`/`mouseup`/`click` land on the surrounding control `<div>`, `focusout` fires and the list closes. A tap on
   the control body (the visible field, 135–357 px wide) opens it and keeps it open.
2. **alert-rules (0/3 strict)**: the top Search field's visible box is 54×32; all five hit-test points plan 031 added
   land on the field's own `input-prefix`/`input-suffix` wrappers, never on the `<input>`, so it is reported "covered".
3. **Invalid screenshots**: on that same page the phone layout viewport is 652×1414 CSS px (the page is wider than
   the 393 px device and Chrome zooms out to fit: `innerWidth`, `visualViewport.width` and `scrollWidth` all 652). The
   first model request with a screenshot after reaching the goal failed with `Model error: 400 Invalid image dimensions`
   (alert-rules ended `blocked` 3/3 after landing on `?search=rule:cpu`).

A person taps the visible field box, not a 4-px input; and every screenshot sent to the model must stay within its
limits (Jev rejects any side over 1568 px; the code aims for ≤ 1024 wide and ≤ 1536 tall).

## Current state

- `src/browser/tab.ts`, `RESOLVE_TARGET` (page-side string), after plan 031:
  ```js
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || … || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  // The centre of the visible box first, then four more points inside it; a hit must still land inside the target.
  const point=()=>{ const r=window.__jevFast.clickRect(e);
    if (!r.width || !r.height) return null;
    for (const [px,py] of [[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]]) {
      const x=r.x+r.width*px, y=r.y+r.height*py;
      if (x>=0 && y>=0 && x<innerWidth && y<innerHeight && e.contains((${DEEP_HIT})(x,y))) return {x,y};
    }
    return null; };
  let at=point();
  if (!at) { e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}); at=point(); }
  if (!at) { …return {covered:true, byPopup:…} }
  …
  if (action.kind==='select') { …sets e.value from the observed option and dispatches input/change… }
  return {x,y};
  ```
  The `select` branch shows the precedent: a fixed DOM operation on the observed element (no model text, no
  coordinates from the model). After `RESOLVE_TARGET`, `#input` taps/clicks at `{x,y}` and, for `fill`, selects all and
  types `values[key]` with key events into whatever has focus.
- Screenshots:
  ```ts
  async screenshot({ format = 'png', quality, scale } = {}) {
    const clip = scale ? await this.#viewportClip(scale) : undefined;   // cssVisualViewport: pageX/Y, clientWidth/Height, scale
    const { data } = await this.#call('Page.captureScreenshot', { format, …quality, …clip });
    return data as string;
  }
  async markedScreenshot(marks, viewport: { w: number; h: number }, { sharp = false } = {}) {
    const pixelRatio = Number(await this.#evaluate('devicePixelRatio')) || 1;
    …
      // Output pixels are CSS pixels × scale × pixel ratio. Stay within 1024 wide and 1536 tall: …Jev rejects any side over 1568 px
      const scale = Math.min(1, 1024 / (viewport.w * pixelRatio), 1536 / (viewport.h * pixelRatio));
      return await this.screenshot({ format: 'jpeg', quality: 60, scale });
  }
  ```
  `viewport` is the page state's `w`/`h` (`innerWidth`/`innerHeight`).
- Reader suite (`verify/reader.ts`): checks can set `device` (from plan 031: `device: 'iphone-15'` opens the tab emulating
  it, so it taps with touch events). Tests: `test/jev-browse.test.ts` (vitest).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (110 before) |
| Reader (keyless) | `env -u TYPESAFE_API_KEY pnpm verify:reader` | `N/N` (39 before) |
| Live fixtures | `pnpm verify` | `8/8` |
| Grafana phone / desktop | `JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` / `pnpm verify:grafana` | 15/24 / 23–24/24 last time |
| Gotchas | `pnpm verify:gotchas` | strict 90/90 last time |

## Scope

**In scope**: `src/browser/tab.ts` (`RESOLVE_TARGET`, the touch/mouse input for these cases, `markedScreenshot`/
`screenshot`), `verify/reader.ts` + `verify/fixture/reader/` (new fixtures/checks), `test/jev-browse.test.ts` (a unit
test for any pure helper you add, e.g. a JPEG size reader).

**Out of scope**: `snapshot.js` (which element is listed stays the same), `src/task/*`, `src/jev/*`. Do not run
`verify:langfuse` or touch the Chrome on port 9333.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: add tiny-input combobox and decorated search fixtures`
  2. `fix: operate a tiny or decorated input through its own field box`
  3. `fix: keep model screenshots within valid dimensions`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Fixtures (red first)

1. `tiny-combobox.html` (check with `device: 'iphone-15'`): a react-select-like control — a 220×38 `<div class="control">`
   holding a placeholder `<div>Sort</div>` and a 4×22 `<input role="combobox" aria-expanded="false">`. Opening: the
   input's `focus` sets `aria-expanded="true"` and shows a listbox; a `mousedown` on the control `<div>` that is **not**
   on the input blurs the input (closing it) unless the press started on the control body, replicating the probe
   (study the real behaviour from the plan text; keep it simple: a press on the 4-px input opens then its compat
   `mousedown` on the control closes; a press on the control body focuses the input and keeps it open). Check: `act` on
   the listed combobox → after settle, `aria-expanded === 'true'` and an option is listed.
2. `decorated-search.html` (desktop): a 54×32 field: a wrapper `<div class="field">` with an absolutely positioned
   `<span class="prefix">` (magnifier) and `<span class="suffix">` covering the whole input area, and the `<input
   aria-label="Search">` beneath them. Check: `act` with kind `fill` and text `cpu` → the input's value is `cpu`
   (`input` listener records it in `window.__fixture.value`).
3. Guard `foreign-cover.html`: a field whose centre and every point are covered by an unrelated overlay `<div>` (a
   sibling outside the field's wrapper, e.g. a cookie banner) → `act` still rejects with `TargetUnreachable`.
**Verify**: reader → checks 1 and 2 fail, the guard and the 39 existing pass. Commit 1.

### Step 2: The field box

In `RESOLVE_TARGET`, when no point hits inside `e` (after the scroll retry), look for `e`'s **field box**: the nearest
ancestor, at most 3 levels up, that (a) contains no interactive element other than `e` (same selector list as the
reader's container rule: `a,button,input,select,textarea,[contenteditable="true"]` and the interactive roles), and
(b) has a visible box at least as large as `e`'s in both dimensions. Then:
- for `kind: 'fill'`: if the hit at the field box's centre is inside the field box, focus `e` with `e.focus()` (a fixed
  DOM operation on the observed element, like the `select` branch) and return the point so the caller types into it;
- for `kind: 'click'` on a control whose own box is tiny (width or height under 12 px): tap/click the field box's centre
  if the hit there is inside the field box.
Otherwise report covered as today. Also apply the tiny rule first (before trying `e`'s own points) when `e`'s box is under
12 px in width or height, so a 4-px combobox input is operated through its field box. Comment each rule in one line.
Never accept a hit outside the field box; the guard check must keep failing `act`.
**Verify**: reader → all pass (42). `pnpm test` → all pass. Commit 2.

### Step 3: Valid screenshot dimensions

1. Measure first (scratch script in `$TMPDIR`, headless, `Tab.open(cdp, 'https://play.grafana.org/alerting/list', { device:
   DEVICES['iphone-15'] })`, wait 5 s): call `markedScreenshot([], { w: innerWidth, h: innerHeight })` and print the
   decoded JPEG's width and height (read them from the JPEG's SOF marker, or with the `sharp` package already in
   `node_modules`), plus `Page.getLayoutMetrics().cssVisualViewport`. Report the numbers.
2. Fix: compute the screenshot scale from the **actual clip** (`cssVisualViewport.clientWidth/Height`) and the pixel
   ratio, not from the page state's `w`/`h`; then read the produced JPEG's dimensions and, if either side exceeds the
   limits (1024 wide, 1536 tall), capture once more with the scale reduced by the overshoot ratio. Keep a pure helper
   that reads a JPEG's width/height from its bytes, with a unit test on a tiny JPEG produced in the test (or a fixed
   byte string).
**Verify**: re-run the measurement → both sides within limits; `pnpm test` → all pass. Commit 3.

### Step 4: Measure

1. `JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` → per job (before 15/24: sort-dashboards 0/3, alert-rules 0/3 strict,
   view-panel 0/3 — view-panel is not expected to move).
2. `pnpm verify:grafana` (desktop) → per job (last 23–24/24); `pnpm verify` → 8/8; `pnpm verify:gotchas` → strict per
   profile (last 30/30 each).
Headless Chrome only. The model key is in the gitignored `.env`, loaded by the npm scripts; never read or print it.
Split long suites with `_ONLY`/`_PROFILES` to stay under 10 minutes per call.

## Test plan

Three model-free reader checks (a tiny combobox input on a touch device, a decorated search field, a foreign overlay
that must still block), red first where applicable; a unit test for the JPEG size reader; live Grafana phone (target)
and desktop, gotchas and `pnpm verify` as guards.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; reader 42/42 keyless, checks 1–2 red at commit 1
- [ ] Screenshot measurement before/after reported, within limits after
- [ ] Grafana phone and desktop per job, `pnpm verify` 8/8, gotchas strict per profile reported
- [ ] `git diff --stat 3c0d402..HEAD` lists only in-scope paths

## STOP conditions

- The foreign-cover guard ever passes `act`.
- Grafana desktop drops below 22/24, or gotchas strict below 29/30 on any profile.
- The fix seems to need `snapshot.js` to list a different element.

## Maintenance notes

- The field box contains only the observed control, so a click there can only operate that control; `e.focus()` for
  a decorated field is a fixed operation on the observed element, like setting a `<select>`'s value.
- If Chrome's screenshot semantics change, the post-capture size check is the backstop.
