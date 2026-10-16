# Plan 058: A popover portaled outside a modal sheet stays visible to the reader when it is on top

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 055 must be merged (`git log --oneline -20 | grep "name a control without the text of its hidden descendants"`).
> Then `git diff --stat <that commit>..HEAD -- src/browser/snapshot.js verify/reader.ts` must be empty. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (`visible()` gates every listed control) · **Category**: bug (gate R5)
- **Planned at**: commit `f35d4ca` plus plan 055, 2026-10-16

## Why this matters

Langfuse on a phone, off-topic-answer: 0/3. Diagnosed live on 2026-10-16:
- The date-range trigger "Past 1 day" sits in a modal Filters sheet.
- Its options ("Past 30 days" and others: `cursor:pointer` divs in a `div[role=dialog]`) are portaled to `<body>` by
  Radix inside `div[data-radix-popper-content-wrapper]`.
- While the sheet is modal, Radix's `hideOthers` marks every body child outside the sheet with
  `aria-hidden="true" data-aria-hidden="true"`, including that popover wrapper.
- The options are visible, in the viewport, and `elementFromPoint` at their centres hits them, so nothing covers them.
- But `visible()` in `snapshot.js` drops anything inside `[aria-hidden="true"]`. So the model sees the trigger, never
  the options, and clicks "Past 1 day" 4× until the toggle guard stops it.

A scratch prototype (an aria-hidden ancestor doesn't hide an element that is on top at its centre; `[inert]` still
hides) listed 10 options and "Past 30 days" acted correctly.

The existing reader check `'aria-hidden, inert and disabled controls are not listed'` (`hidden-and-disabled.html`) must
keep passing: a plain `aria-hidden="true"` button stays hidden. So the exception is narrow. Only the
`data-aria-hidden="true"` marker, which the `aria-hidden` library behind Radix, shadcn and react-aria sets to hide
everything outside a modal, is ignored, and only for an element that is on top at its centre. Every shadcn/Radix app
(a large share of modern React UIs) portals popovers this way.

## Current state

- `src/browser/snapshot.js`:
  ```js
    const visible = (e) =>
      !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  ```
  `visible` is used by `eligible`, by `popupItems` (`visible(popup)`, which labels pointer-cursor divs in a popup as
  `option`), by text collection and by others. Read every use before changing it.
- `hidden-and-disabled.html` has a plain `<button aria-hidden="true">` that must stay unlisted.
- Reader checks: `{ name, file, run }`; copy the `popup-items.html` check for options in a popup.

## Scope

**In scope**: `src/browser/snapshot.js` (`visible()`, or a helper it calls), `verify/reader.ts`,
`verify/fixture/reader/portaled-popover.html` (new). **Out of scope**: `[inert]` handling, plain `aria-hidden`, `name()`,
`cache.guard`. Do not run `verify:langfuse` until your reviewer says 9333 is free. Never touch the Chrome on 9444.

## Git workflow

Commits: `test: a popover portaled outside a modal sheet`, `fix: list an on-top popover that a modal library marked aria-hidden`.
No AI attribution. Do NOT push.

## Steps

1. **Fixture and check, failing first.** `portaled-popover.html`:
   - a modal sheet (`div[role=dialog][aria-modal=true]`) with a trigger button "Past 1 day" (`aria-expanded="true"`);
   - a body-level sibling `<div aria-hidden="true" data-aria-hidden="true">` holding `div[role=dialog]` with three
     `cursor:pointer` divs "Past 1 hour", "Past 7 days" and "Past 30 days", positioned visibly on top. Clicking one
     records `window.__fixture.range`;
   - a second body-level `<div aria-hidden="true" data-aria-hidden="true">` with a button "Behind the sheet",
     positioned **under** the sheet (covered).

   Check `'a popover a modal library marked aria-hidden is listed when it is on top'`:
   - the three options are listed (role `option` or `button`);
   - acting on "Past 30 days" sets `range`;
   - "Behind the sheet" is **not** listed.

   Run reader: the check fails. Commit 1.
2. **The rule.** In `visible(e)`, when the nearest `[aria-hidden="true"]` ancestor also has `data-aria-hidden="true"`,
   and no `[inert]` ancestor exists, treat `e` as visible if `checkVisibility` passes **and** `document.elementFromPoint`
   at its centre is `e` or inside `e` (or `e` contains it). A plain `aria-hidden="true"` without the data marker hides as
   today.
   - Mark it `// jev-browse:` (a modal library hides everything outside its sheet, including the popover it portaled
     for that sheet; a person still sees and taps the popover).
   - Mind the cost: run the hit-test only in the `data-aria-hidden` branch.
   - Run the syntax check; reader → all pass, including `hidden-and-disabled`; `pnpm test` → pass. Commit 2.
3. **Measure**, headless unless noted; never read the gitignored `.env`:
   - `pnpm verify` → 8/8.
   - `pnpm verify:gotchas` → strict.
   - `pnpm verify:redteam` → `violations: 0`.
   - `CI=1 pnpm verify:grafana` → 24/24.
   - `CI=1 JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` → 24/24.
   - Only when your reviewer says 9333 is free: `JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_ONLY=off-topic-answer pnpm verify:langfuse`
     → against 0/3; and `JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_ONLY=off-topic-answer,cost-dashboard,monthly-cost pnpm verify:langfuse`
     (desktop) → no regression.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader all pass, with the new check failing first; `pnpm verify` 8/8; red-team 0 violations
- [ ] gotchas and Grafana desktop and phone reported; Langfuse phone off-topic-answer and the desktop trio reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- `hidden-and-disabled` (or any reader check) fails.
- A red-team violation (a red-team page could use `data-aria-hidden` decoys; a hit-tested element on top is what a person sees, but STOP and report if one fires).

## Maintenance notes

- If another modal library hides outside content with a different marker, extend the marker list; never drop the hit-test.
