# Plan 087: A covered target's note names the controls of the layer covering it, so Jev can close it

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/browser/tab.ts` must have `export class TargetUnreachable extends StalePage` with `readonly byPopup: boolean`.
> - In `RESOLVE_TARGET`, the line starting ``return {covered:true, byPopup:Boolean(hit?.closest(`` must exist.
> - `src/task/run-task.ts` must have the note `'could not be reached: another layer covers it; close that layer first'`
>   and the reason ``could not be reached ${misses} times: something on the page covers it``.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (the wording of a note and a reason; no new action) · **Category**: bug (public sites)
- **Planned at**: commit `ef49de1`, 2026-10-18

## Why this matters

On Booking.com today, a cookie banner ("Manage cookie settings", with "Decline", "Accept" and "Manage settings") sits over
the date picker's first row. It covered the date Jev picked in 4 of 5 runs
(`verify/out/real-2026-10-18T08-19-33-996Z/booking-2.json`, and `…T08-24-16-820Z/booking-1.json`, `-2`, `-3`):
- **2 runs recovered:** after the 2nd miss and its note ("another layer covers it; close that layer first"), Jev pressed
  Escape or picked "Decline".
- **2 runs ended `blocked`:** Jev picked the same covered date a third time (0.45, 0.86), and the reason said only
  "something on the page covers it".

The note doesn't say *what* covers the target. Jev reads a list of controls, and the banner's "Decline" is one of them,
but nothing links it to the miss. The run already knows the covering element: the cover check finds it with a hit test
at the target's centre. Naming the controls inside that layer, using only labels already in Jev's list, turns "close
that layer" into a choice Jev can make. Cookie banners, chat widgets and sticky promos do this on most real sites.

## Current state

**The cover check:** `src/browser/tab.ts`, `RESOLVE_TARGET` (an in-page script):

```js
if (!at) {
  // Say what covers it: a popup layer can be closed with Escape, anything else can't be helped from here.
  const r=window.__jevFast.clickRect(e), hit=(${DEEP_HIT})(r.x+r.width/2, r.y+r.height/2);
  return {covered:true, byPopup:Boolean(hit?.closest('[role="listbox"],[role="menu"],[role="dialog"]:not([aria-modal="true"]),[role="tooltip"],[data-radix-popper-content-wrapper],[cmdk-list]'))};
}
```

- `#input(action, text)` throws `new TargetUnreachable('Target changed or is covered', Boolean(target?.byPopup))`.
- `window.__jevFast.nodes` maps each observed node id to its element.

**The handler:** `src/task/run-task.ts`, in the `catch` of the act call:
1. On the 1st miss with a popup open, a fixed `dismissPopup` runs.
2. Otherwise `misses` counts. On the 2nd miss it pushes
   `{ operation, element: action.label, not_executed: 'could not be reached: another layer covers it; close that layer first', confidence }`.
3. On the 3rd (`GUARDS.maxUnreachable`) it stops with
   ``blocked`, `"${action.label}" could not be reached ${misses} times: something on the page covers it``.

**Tests:** `test/jev-browse.test.ts`, `describe('loop gotchas', …)`. The test "tells Jev about a covered target on the
2nd miss and hands back on the 3rd instead of retrying blind" uses `fakeTab()` with `tab.unreachable = 10`. Read
`fakeTab` to see how it throws `TargetUnreachable`.

## Scope

**In scope:**
- `src/browser/tab.ts`: the cover check returns the covering layer's node ids, and `TargetUnreachable` carries them.
- `src/task/run-task.ts`: the 2nd-miss note and the 3rd-miss reason name them.
- `test/jev-browse.test.ts`, and `fakeTab` if it needs a way to throw with cover nodes.
- `AGENTS.md`: the loop-guards clause "a target unreachable on an unchanged page is told to Jev on the 2nd miss…".

**Out of scope:**
- The automatic `dismissPopup` and its trigger.
- `GUARDS.maxUnreachable`.
- Any new operation or automatic click on the banner. Jev still decides.
- Free page text in the note: only labels of actions in the current list.

Never read `.env`.

## Git workflow

Commits:
1. `test: a covered target's note names the covering layer's controls`
2. `fix: name the covering layer's controls when a target is covered`

Lowercase conventional commits. **No AI attribution of any kind**: no Co-Authored-By, no "Generated with", no session
links or trailers, no mention of an AI assistant. Do NOT push.

## Steps

### 1. Tests first

In `describe('loop gotchas', …)`:
- **The note names the layer's controls.** The page lists a date "Sunday, November 1, 2026" (node 21) and buttons
  "Decline" (node 114), "Accept" (node 115) and "Manage settings" (node 116). The click on node 21 throws
  `TargetUnreachable` whose cover nodes are `[114, 115, 116]`. The 2nd request's history contains
  `could not be reached: it is covered by a layer listing "Decline", "Accept", "Manage settings"; close that layer first (one of those), then try again`.
  A scripted CLICK "Decline" next is acted on.
- **The reason names them too.** Three misses give
  `"Sunday, November 1, 2026" could not be reached 3 times: it is covered by a layer listing "Decline", "Accept", "Manage settings"`.
- **At most 3 labels,** in list order, each capped at 40 characters.
- **No usable names, no change.** Cover nodes that are absent, empty, or match no listed action keep today's texts exactly.
- **Only listed actions.** A cover node id not in `page.actions` is skipped. The note never contains text that isn't
  an action label.

Run them red. Commit 1.

### 2. The rule

**`tab.ts`:** in the covered branch, find the covering layer: from `hit`, the nearest ancestor (or `hit` itself) that
- has computed `position` `fixed` or `sticky`, or
- has `role` `dialog`/`alertdialog`, or `aria-modal="true"`.

If there is one, collect the ids of `window.__jevFast.nodes` entries whose element it contains (the target's own node
excluded). Return `{covered:true, byPopup, coverNodes}`. Add `readonly coverNodes: number[]` to `TargetUnreachable`
(default `[]`) and pass it through.

**`run-task.ts`:**
- Map `error.coverNodes` to labels of `page.actions` with those nodes, in list order. Take at most 3, use `bareLabel`,
  and cut each at 40 characters.
- If any remain, use the texts from step 1 for the 2nd-miss note and the 3rd-miss reason. Otherwise use today's.
- One comment: the run knows what covers the target, and naming its controls (already in Jev's list) lets Jev close it
  instead of retrying the covered target.

**AGENTS.md:** in the loop-guards clause, after "told to Jev on the 2nd miss", add "(naming up to 3 listed controls of
the fixed or modal layer covering it)".

`pnpm test` and `pnpm typecheck` pass. Commit 2.

### 3. Measure

- `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`; `pnpm verify:gotchas` strict per profile.
- `JEV_REAL_RUNS=5 JEV_REAL_ONLY=booking pnpm verify:real`. Report every covered miss, the note's text, Jev's next
  pick, and the run's end. Target: no run ends `blocked` on a covered date. Booking's other misses (city page) are plan
  086's business; report them, don't fix them.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first
- [ ] `pnpm verify` 8/8; red-team 0; gotchas strict
- [ ] booking ×5 reported as in step 3
- [ ] `git diff --stat main` lists only the in-scope paths

## STOP conditions

- A red-team violation.
- The covering layer's labels ever include text that is not an action label in the current list.

## Maintenance note

The layer test is fixed/sticky or modal. A covering element in normal flow (an absolutely positioned overlay inside a
scrolled container) gets no names and keeps today's text. If that shows up on real sites, widen the test there.
