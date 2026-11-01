# Plan 095: A scroll goes to the area that actually scrolls, and a scroll that moved nothing says so

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/browser/snapshot.js` must end its action list with
>   `if (scrollY + innerHeight < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });`
> - `Tab.act` in `src/browser/tab.ts` must dispatch the wheel at `x: Math.round(page.w / 2)`, `y: Math.round(page.h * 0.6)`.
> - `verify/capabilities.ts` (plan 094) must exist with the tasks `nested-scroll` and `infinite-scroll` marked `gap: 'plan 095'`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: MED (every scrolling job; Jev's request changes on pages whose document
  doesn't scroll) · **Category**: capability
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

`docs/prior-art.md` [C1](../docs/prior-art.md#c1). App shells (Langfuse, Linear, Slack, Grafana panels) keep the
document still and scroll a pane. jev-browse handles that pane in two places only, both indirect: a target already
listed is scrolled into view by the click (`RESOLVE_TARGET`), and a supplied value pulls an off-screen row into the list
(`tab.want`). A row nobody named, below the pane's fold, can't be reached:

- `snapshot.js:533-535` offers `scroll_down`/`scroll_up` only when the **document** can move, so on an app shell Jev is
  never offered a scroll at all.
- `tab.ts:398-405` aims the wheel at a fixed point (centre column, 60 % down), whatever is there.
- Nothing measures whether the wheel moved anything; `page_changed` is the page fingerprint, and a busy page changes it
  while a stuck wheel doesn't.

Ying-Kai-Liao aims the wheel at the largest visible scrollable box, or the box around a target, steps 80 % of its
visible height, and returns the distance moved once it lands (`src/session.mjs:54-85`, `:586-614`).

Plan 094's baseline (`verify/out/capabilities-…`, see the report) shows `nested-scroll` and `infinite-scroll` as gaps.

## Current state

- `snapshot.js`, end of the reader: the scroll actions, then `scroll: { y: scrollY, height }` in the returned state (part
  of the fingerprint).
- `tab.ts` `act()`: `kind === 'scroll'` dispatches one `mouseWheel` with `deltaY: action.delta` at the fixed point and
  returns nothing.
- `run-task.ts`: an executed step's history entry is `{ operation, element: action.label, page_changed, confidence }`.

## Scope

**In scope:** the end-of-file scroll block of `snapshot.js` (b-frames is editing the reader too: no other edits there),
`tab.ts` (`act`'s scroll branch, a new `#scroll`, `PageAction.at`), one line in `run-task.ts` (the step's element),
`verify/reader.ts` and a reader fixture, `test/`, `AGENTS.md` Invariants, README "Limits", plan 094's gap flags.

**Out of scope:** a scroll target chosen by the model (that would put a target head on SCROLL and change the request
everywhere); horizontal scrolling; the click path's `scrollIntoView`; `GUARDS`.

## Design (decided)

1. **Offer.** The document keeps today's rule exactly (offered when it can move that way, wheel at today's point, delta
   560), so a page whose document scrolls sends Jev the same request as before. When the document can't move in a
   direction, the reader looks for the **largest visible scroll box** that can: `overflow-y` `auto`/`scroll`/`overlay`,
   `scrollHeight > clientHeight + 1`, visible part at least 50×50 CSS px, not hidden. If one exists, `scroll_down`
   (or `scroll_up`) is offered with the same label and `at`: the centre of that box's visible part, from its DOM rect.
   Its delta is 80 % of that visible height, between 100 and 560, so a short pane is never stepped past a row.
2. **Aim.** `act` puts the wheel at `action.at` when there is one, and at today's point otherwise.
3. **Measure.** Before and after the wheel, `act` reads the scroll offsets (the window's plus every element's
   `scrollTop`), and waits for the wheel to land (polls every 50 ms: stops once it stops moving, or after 500 ms of no
   movement, at most 1.5 s). It returns `{ scrolled }`, the distance moved (undefined when the offsets can't be read).
4. **Say so.** A scroll that moved 0 px goes into history with its element as
   `Scroll down (nothing moved: there is no more to scroll this way)`, so Jev stops repeating it. The fixed point stays
   the fallback.
5. The reader's `scroll` state (fingerprint) also carries the sum of the panes' `scrollTop`, so a pane that scrolled
   counts as a page change even when its visible text didn't change.

The rule's request change: only pages where the document can't scroll but a pane can now get `SCROLL_DOWN`/`SCROLL_UP`
(same labels). Every document-scrolling page is byte-identical.

## Git workflow

1. `docs: add plan 095 scroll the area that actually scrolls`
2. `test: a scroll aims at the pane that scrolls and says when it moved nothing`
3. `feat: scroll the largest visible pane and report a scroll that moved nothing`

Lowercase conventional commits. **No AI attribution of any kind**. Do NOT push.

## Steps

1. Tests first:
   - `test/tab-capabilities.test.ts` (fake CDP): the wheel goes to `action.at` when present and to the fixed point
     otherwise; `act` returns the distance read from the offsets; a wheel that leaves them unchanged returns 0.
   - `test/jev-browse.test.ts`: a scroll the tab reports as 0 px puts "nothing moved" in the next request's
     `recent_actions`; a scroll that moved keeps the plain label.
   - `verify/reader.ts` + `verify/fixture/reader/nested-pane.html`: on a page whose document doesn't scroll, the pane
     gets `scroll_down` with `at` inside it; acting moves it and lists rows that were below its fold; at the pane's end
     only `scroll_up` is offered; `below-fold.html` (document scrolls) keeps `scroll_down` without `at`.
   Run them red.
2. Implement as designed. `pnpm typecheck`, `pnpm test`, `pnpm verify:reader` 100 %.
3. Remove `gap` from `nested-scroll` and `infinite-scroll` in `verify/capabilities.ts`.
4. AGENTS.md Invariants (a new scroll clause), README "Limits" (drop "nested scrolling").

## Measure

`pnpm verify:capabilities` (false done 0; `nested-scroll` and `infinite-scroll` correct), `pnpm verify:reader` 100 %,
`pnpm verify` 8/8, `pnpm verify:gotchas` strict, and `JEV_LANGFUSE_RUNS=1 pnpm verify:langfuse` under `chrome-9333`
when that Chrome is up (compare with `plans/README.md` G6).

## Done criteria

- [ ] Tests red first, then `pnpm typecheck`, `pnpm test`, `verify:reader` green
- [ ] The two scroll tasks correct in ≥ 2 of 3 runs each, false done 0
- [ ] `verify` 8/8, gotchas strict as before, Langfuse ×1 no job lost against G6 (or reported as not run)

## STOP conditions

- A Langfuse or gotchas job that passed before fails because a scroll now goes to a pane.
- Any false done.

## Maintenance note

The pane is chosen by size, so a page with two big panes (a list and a detail) scrolls the larger one. If that shows up,
the next step is the scroll box around the target the click head favours, which needs no new head.
