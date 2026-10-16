# Plan 056: Escape, Wait, Scroll and Enter run on a page that keeps changing, instead of re-deciding forever

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat f35d4ca..HEAD -- src/browser/tab.ts` must be empty; otherwise STOP. (`verify/reader.ts` may
> have gained checks from plan 055; that's fine.)

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (when fixed page-level actions execute) · **Category**: bug (gate R5, phones)
- **Planned at**: commit `f35d4ca`, 2026-10-16

## Revision 2 (2026-10-16, after measurement): run them only after two refusals in a row

**This section supersedes Step 2, the Scope and the AGENTS.md text below.** Steps 1 and 3 still apply, with the changes listed here.

**What the first version measured** (`67c390c`, a blanket skip of the freshness check):
- Grafana phone `view-panel` went from 6/6 before to 2/7 after.
- Keeping the check for scroll only gave 4/6.

**Why it failed:** after the panel menu opened, its items were listed mid-animation as hover-only. The click on "View" went
stale, and on the re-decision the model chose SCROLL_DOWN at 0.42.
- The old whole-page check refused that scroll once, so the loop re-observed the page, which had settled by then, and clicked View.
- With the blanket skip, the scroll ran and pushed View off screen.

So a single refusal is useful: it waits out an animation. The Langfuse stall was **28 refusals in a row** on a page that never
settles. The rule has to tell those two apart.

**The rule:**
1. **The first refusal stays.** A page-level action (wait, escape, scroll, enter) whose whole-page check fails still throws `StalePage`, and the loop
   re-observes, as it does today.
2. **The counter.** `run-task.ts` counts consecutive `StalePage` refusals of page-level actions in a private field, `#pageLevelStale`. It
   resets to 0 whenever any action executes. Don't count `TargetUnreachable` (a subclass) or refusals of click, select or fill.
3. **The forced run.** When `#pageLevelStale >= 2` and the new decision is a page-level action, call
   `this.#tab.act(action, page, text, { evenIfChanged: true })`.
4. **The opt-in in `tab.ts`.** `act(action, page, text?, { evenIfChanged = false } = {})`.
   - Skip the freshness check only when `evenIfChanged` is set **and** `action.kind` is one of wait, escape, scroll or enter.
   - Click, select and fill always check, and so does `clickAt`.
   - Enter keeps `#pressEnter`'s focus check.
5. **The comment.** One line where the counter is used: a page whose text never stops changing (a ticking clock) would refuse a
   page-level key forever, while one refusal is enough to wait out an animation.

**Scope (replaces the Scope section below):**
- In scope: `src/browser/tab.ts` (the `act` opt-in), `src/task/run-task.ts` (the counter and the forced call only),
  `test/jev-browse.test.ts`, `verify/reader.ts`, `verify/fixture/reader/busy-page-menu.html`, and `AGENTS.md` (one clause).
- Out of scope: `fresh()` itself, `clickAt`, `GUARDS`, and every other hand-back.

**Git (rework on the same branch, `wt/exec-056-busy-keys`):**
1. Rebase the branch onto main.
2. Keep commit 1 and amend its reader check:
   - the first `tab.act(escape, page)` on the busy page throws `StalePage`;
   - `tab.act(escape, page, undefined, { evenIfChanged: true })` runs and `closed` is true;
   - the same two steps for `scroll_down`, ending with `scrollY > 0`.
   It must fail at commit 1, because `act` has no 4th argument yet.
3. Replace commit 2 (`67c390c`): `git reset --soft HEAD~1`, then recommit with the same message.

**Unit tests** (in `test/jev-browse.test.ts`, with the `scriptedJev`/`fakeTab` pattern). The fake tab's `act` throws
`new StalePage('Page changed since this decision')` for page-level kinds unless `evenIfChanged` is set.
- PRESS_ESCAPE three times, then DONE: escapes 1 and 2 are refused (`executed: false`), and escape 3 runs with `evenIfChanged: true`.
- One refused SCROLL_DOWN, then a CLICK that executes, then one SCROLL_DOWN: that last scroll is called **without**
  `evenIfChanged`, because the executed click reset the counter.

**AGENTS.md** (replace the clause from the first version): `Escape, Wait, Scroll and Enter refused twice in a row because the
page keeps changing run anyway the third time (Enter only while its field has focus); one refusal still waits out an animation.`

**Measure** (in addition to Step 3):
- Run phone `view-panel` six times on the rebased tree, the same way you measured before:
  `CI=1 JEV_GRAFANA_DEVICE=iphone-15 JEV_GRAFANA_RUNS=6 JEV_GRAFANA_ONLY=view-panel pnpm verify:grafana`.
  It must be **≥ 5/6**. If it lands under that, STOP and report: this round then drops plan 056.
- Report how many forced runs happened in the Grafana and gotchas reports. Search the trace for consecutive `executed: false`
  page-level decisions.

## Why this matters

Langfuse on a phone (gate R5) trace-to-prompt run 1 ended `step_budget`: decisions 13 to 40 were 28 PRESS_ESCAPE in a
row, all `executed: false`. The cause is in `src/browser/tab.ts`:
- `Tab.act()` first calls `fresh(page, action)`. For click, select and fill, `fresh` compares only the page key and the
  target element's guard, because busy pages (rotating banners, live timers) change the page marker constantly.
- Every other action kind (wait, enter, escape, scroll) compares the **whole-page marker**. On a page whose text
  ticks, that never matches. `act` throws `StalePage`, and the loop re-observes and re-decides without executing,
  until the 40-decision cap.

The same gap was noted after plan 030: a hand-back on a constantly changing page re-decides until `step_budget`.

These four actions don't target an element and are reversible. Escape closes whatever is open; Wait sleeps; Scroll
moves the viewport; Enter is offered only right after typing into a search-like field, and `#pressEnter` presses it
only while that field still has focus. Running them on a page that changed since the decision is safe. Refusing them
there turns a busy page into a dead end.

## Current state

`src/browser/tab.ts`:
```ts
  async fresh(page: PageState, action?: PageAction): Promise<boolean> {
    // Element-level for targeted input: busy pages (rotating banners) change the page marker constantly.
    if (action && ['click', 'select', 'fill'].includes(action.kind)) { … page key + element guard … }
    return isDeepStrictEqual(await this.#evaluate(MARKER).catch(() => null), page.marker);
  }

  async act(action: PageAction, page: PageState, text?: string) {
    if (!(await this.fresh(page, action))) throw new StalePage('Page changed since this decision');
    if (action.kind === 'wait') return sleep(100);
    if (action.kind === 'enter') return this.#pressEnter(action);
    if (action.kind === 'escape') return this.dismissPopup();
    if (action.kind === 'scroll') { … mouseWheel … }
```
- `fresh(page)` without an action is also used by `clickAt` (coordinate clicks). That stays whole-page: a coordinate on a
  changed page could hit something else.
- `#pressEnter(action)` checks that the typed field still has focus before pressing. Read it and confirm.
- Reader checks are the pattern for a real-Chrome test: `{ name, file, run }`, `tab.observe()`, `tab.act(action, page)`,
  `window.__fixture`.

## Scope

**In scope**: `src/browser/tab.ts` (`act`'s freshness check for wait, escape, scroll and enter), `verify/reader.ts`,
`verify/fixture/reader/busy-page-menu.html` (new), `AGENTS.md` (one clause in the loop-guards or invariants line).

**Out of scope**: `fresh()` for click, select and fill, and `clickAt`; `run-task.ts`. Do not run `verify:langfuse` or touch the
Chromes on 9333 and 9444.

## Git workflow

Commits: `test: an escape on a page whose text keeps changing still runs`, `fix: run page-level keys and scrolls on a busy page`.
No AI attribution. Do NOT push.

## Steps

1. **Fixture and check, failing first.** `busy-page-menu.html`: a clock whose text changes every 50 ms, a long body
   (so Scroll down is offered), and a menu button with `aria-expanded="true"` and an open `role="menu"`. Pressing
   Escape closes the menu (sets `aria-expanded="false"` and records `window.__fixture.closed = true`). Check `'escape and scroll run on a page whose text keeps changing'`:
   - `page = await tab.observe()`, then wait 200 ms so the marker has moved;
   - act on the listed escape action (`kind === 'escape'`): no throw, and `closed` is true;
   - observe again, wait 200 ms, act on `scroll_down`: no throw, and `scrollY > 0`.

   Run `pnpm verify:reader`: it fails with "Page changed since this decision". Commit 1.
2. **The change.** In `act`, check freshness only for actions that target an element or a point: keep
   `fresh(page, action)` for click, select and fill. Skip it for wait, escape, scroll and enter. Enter's safety stays
   in `#pressEnter`'s focus check. One comment: page-level keys and scrolls target no element and are reversible, so a
   page that changed since the decision (a ticking clock) doesn't make them stale.

   Run `pnpm verify:reader` → all pass; `pnpm test` and `pnpm typecheck` → pass. Add to AGENTS.md: "Escape, Wait, Scroll
   and Enter target no element and run even if the page changed since the decision (Enter only while its field has
   focus)". Commit 2.
3. **Measure**, headless; the model key is in the gitignored `.env`, so never read or print it:
   - `pnpm verify` → 8/8.
   - `pnpm verify:gotchas` → strict per profile. The churn profile is the main risk; report any change.
   - `pnpm verify:redteam` → `violations: 0`.
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → 8/8.
   - `CI=1 JEV_GRAFANA_RUNS=1 JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` → 8/8.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader all pass, with the new check failing first; `pnpm verify` 8/8; red-team 0 violations
- [ ] gotchas and Grafana desktop and phone reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- gotchas strict drops on any profile, or any reader check fails.
- `#pressEnter` turns out to have no focus check: then keep enter's freshness check and report.

## Maintenance notes

- The Langfuse phone gate (R5) re-measures trace-to-prompt at round end on 9333.
