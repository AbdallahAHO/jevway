# Plan 098: Every frame is read with the same reader

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/browser/snapshot.js` starts its cache with `window.__jevFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 }`.
> - `src/browser/tab.ts` has `Tab.attach` registering `INPUT_COUNTER` with `Page.addScriptToEvaluateOnNewDocument`, and
>   `#evaluate` calls `Runtime.evaluate` on the tab's own session with no `contextId`.
> - `src/mcp.ts` says `Not supported: iframes, shadow DOM, canvas, …`; README "Limits" says iframes "aren't read".
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: L (2–3 days) · **Risk**: MEDIUM (the reader runs on every page; frames add ids, text
  and guards) · **Category**: capability (docs/prior-art.md C4)
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

Payment forms, sign-in widgets, embedded editors, consent dialogs and support chats live in iframes. Today the reader
sees none of them: `snapshot.js` walks `document` only, and every guard in `tab.ts` evaluates in the main frame
(`#evaluate` → `Runtime.evaluate` on the page session, `src/browser/tab.ts:551`). The agent is told to use
chrome-devtools instead (`src/mcp.ts:36`, README "Limits", `skill/jev-browse/SKILL.md:17`). The opt-in coordinate click
is the only way in, and only when Box happens to point at it (README "Coordinate clicks").

Ying-Kai-Liao's reader enumerates every frame with the same script, continues the element ids across frames and keeps a
map from id to frame for acting (`src/session.mjs:233-258`, `:518-521`; docs/prior-art.md C4). It runs on Playwright,
which hides frame sessions and offsets. jev-browse runs on raw CDP, so the frame plumbing is ours to build, and every
guard has to hold inside a frame.

## Current state

- **Reader:** `snapshot.js` is evaluated in the main world of the main frame. It keeps `window.__jevFast` (id ↔ element,
  `pageKey`, `guard`, `clickRect`) and returns `actions` (ids `e1…`, `node`, viewport `rect`), `text` (≤6000, password
  lines first), `passwordFields`, `marker`, `page_key`, `guards`.
- **Guards** (`tab.ts`): `fresh()` (page key + element guard, or the whole-page `MARKER`), `RESOLVE_TARGET` (hit test,
  cover check, `coverNodes`), `INPUT_COUNTER` / `READ_INPUT` (trusted presses, registered before the page's scripts),
  `#answerDialog`, `DRAW_MARKS`, `COUNT_PLACEHOLDERS`, `SETTLE`, `#pressEnter`, `#revealByHover`. All run in the main frame.
- **Ids:** `run-task.ts` uses bare `action.node` as identity across observes (`#opened`, `#openedByRun`, `#unreachable`,
  `#refusedForValue`, `guards[node]`), so ids must be stable and unique.
- **CDP:** `cdp.ts` already speaks flattened sessions (`send(method, params, sessionId)`, listeners get `sessionId`).

Probed on Chrome 156 headless (scratch script, before any code):
- The page session's `Page.getFrameTree` lists same-process frames only. A cross-site frame (`localhost` inside
  `127.0.0.1`) is an out-of-process iframe (OOPIF): it appears only through `Target.setAutoAttach` (`attachedToTarget`,
  type `iframe`, with `parentFrameId`), and its own session's `getFrameTree` has it as root (frame id = target id).
- `Page.createIsolatedWorld` with the same `worldName` returns the same context, and state persists in it.
  `Runtime.evaluate` with that `contextId` works without `Runtime.enable`.
- `addScriptToEvaluateOnNewDocument` with `worldName` runs in that world in same-process child frames and, registered on
  the OOPIF's session while it waits for the debugger, in the OOPIF before its scripts.
- `DOM.getFrameOwner` + `DOM.resolveNode` + `Runtime.callFunctionOn` give the owner `<iframe>` box in the parent's
  viewport, for same-process and OOPIF frames alike.
- A mouse press at viewport coordinates on the page session reaches an OOPIF, and an isolated-world `pointerdown`
  listener in that frame counts it (trusted). A `confirm()` in the OOPIF raises `Page.javascriptDialogOpening` on the
  **page** session, and answering it there works.

## Design (decided)

1. **Which frames.** Every frame under the page, same-process (frame tree) and out-of-process (auto-attached iframe
   targets, recursively, `waitForDebuggerOnStart` with `Runtime.runIfWaitingForDebugger` always in `finally`), stitched
   into one tree by parent frame id, in the owner's document order. A frame is read when:
   - its URL is not empty or `about:blank` (`about:srcdoc` has content and is read);
   - its owner element is visible (`checkVisibility`), not inside `[inert]` or a plain `aria-hidden="true"` (the modal
     library's `data-aria-hidden` marker is treated as the snapshot treats it), and its visible part in the viewport is
     at least 16×16 px (tracking pixels and hidden frames are skipped);
   - when the parent document has an open modal (`aria-modal="true"` or a modal `<dialog>`, the snapshot's rule), the
     owner is inside one;
   - at most 10 frames per page, 3 levels deep.
   Each frame's read is capped at 1.5 s (`Runtime.evaluate` `timeout` plus a race). A frame that times out or throws is
   **skipped**, not a browser error: a third-party frame must not end the run. This is a written exception to "a protocol
   call that times out ends the run as a browser error", which still holds for the main frame and for acting.
2. **Same reader, its own world.** The main frame keeps the main world exactly as today (no behaviour change on pages
   without frames). Every other frame is read in an isolated world `jev-browse` with the same `snapshot.js`.
   `INPUT_COUNTER` is registered a second time with `worldName: 'jev-browse'` on the page session and on each OOPIF
   session before it runs, and read in the frame the press went to (a trusted press never crosses a frame boundary).
3. **Ids.** Each frame gets a fixed id base the first time the tab sees it (`slot × 1 000 000`; the main frame is slot 0).
   `snapshot.js` gets one line: the cache's `next` starts at `(window.__jevIdBase || 0) + 1`, and the tab sets
   `__jevIdBase` in the frame's world before reading. Ids are then unique across frames and stable across observes, so
   every `run-task.ts` set keeps working untouched; in-page scripts (`RESOLVE_TARGET`, `SETTLE`, guards) run unchanged in
   the frame. The action ids `e1…` continue across frames after the merge. Each frame action records `frame` (the frame
   id); routing goes by the node's base, so a `press_enter` built from a node alone still finds its frame.
4. **Rects.** A frame's offset is its owner's content-box origin (`getBoundingClientRect` + `clientLeft/Top` + padding)
   in the parent's viewport plus the parent's own offset: nested frames compound, and a scrolled parent or frame counts
   because both reads are viewport-relative. The frame's visible region is its content box clipped by the parent's
   visible region and the parent viewport. A frame action whose shifted centre falls outside that region is dropped. Box
   matching (`src/jev/box.ts`) then needs no change: frame elements carry viewport rects like any other.
5. **Cover.** After observe shifts a frame's actions, each centre is hit-tested in every ancestor document (one batched
   call per level): the hit must land on the owner `<iframe>`, so a banner or modal over the frame hides those controls.
   At act time `RESOLVE_TARGET` runs in the frame (its own cover check and `coverNodes`), the offset is read again, and
   the same parent hop runs at the shifted point; a miss throws `TargetUnreachable` with the covering layer's observed
   ids from the parent (fixed, sticky or modal ancestor, as plan 087).
6. **Freshness.** A targeted action compares the main frame's `page_key` and the frame's own `[page_key, guard]`. A
   page-level action compares the main `MARKER` plus each read frame's identity (`timeOrigin`, URL), **not** frame text:
   ad frames that tick would otherwise refuse every Wait, Scroll and Escape. The fingerprint is computed over the merged
   text and actions, so typing inside a frame is a page change.
7. **Text.** Main text first, then each frame's text under a line `[Frame: <owner title, name or host>]`. The total stays
   6000 characters, so Jev's request does not grow: frames get the room left after the main text, but at least 1000
   characters (taken from the main text's tail) when they have text. Password lines from every frame go first, before all
   other text (the "never cut by the cap" rule), at most 5 in all; `passwordFields` is merged the same way, names only.
8. **Other guards per frame.** Dialogs: the existing page-session handler covers frames (probed); a fixture asserts it.
   Marks: drawn in the main document's overlay at the shifted rects; only on-top frame elements are listed, so no mark
   sits on a cover. `tab.want`: `__jevWanted` is set in each frame's world, so an off-screen wanted row inside a frame is
   listed (clicking scrolls it in, also scrolling the parent). Placeholder wait: counted in every read frame and summed.
   `SETTLE`, `#pressEnter` (focus checked in the frame) and `#revealByHover` (centre shifted) run in the target's frame.
   Touch and focus emulation are applied to OOPIF sessions too.
9. **Still unsupported:** closed shadow roots, canvas, frames past the caps above, CSS-transformed or scaled iframes
   (offsets assume no transform), and frames whose read times out. Coordinate clicks stay the opt-in fallback.

## Scope

**In scope:** `src/browser/frames.ts` (new: frame tracking, worlds, offsets, merge), hook points in `src/browser/tab.ts`,
one line in `src/browser/snapshot.js`, reader fixtures under `verify/fixture/reader/` and checks in `verify/reader.ts`
(second origin), an iframe form scenario in `verify/run.ts`, unit tests `test/frames.test.ts`, docs (`src/mcp.ts`
unsupported list, README "Limits", `skill/jev-browse/SKILL.md`, AGENTS.md Layout and Invariants).

**Out of scope:** `run-task.ts`, `decide.ts`, thresholds and `GUARDS`; scroll actions inside frames (the page's wheel
already scrolls what is under it); popup tabs, uploads (plan 094); `verify:capabilities` iframe tasks (plan 094).

Never read `.env`.

## Git workflow

Branch `wt/exec-b-frames`. Commits:
1. `docs: add plan 098 every frame is read with the same reader`
2. `test: frames are read, offset and guarded like the main page`
3. `feat: read every frame with the same reader`
4. `docs: frames are read`

Lowercase conventional commits, no AI attribution of any kind. Do NOT push or merge.

## Steps

1. **Tests first.**
   - `test/frames.test.ts`: id bases (slot → base, node → base, main slot 0); offsets compound for a nested frame; a
     frame action outside the frame's visible region is dropped; merged ids continue `e1…`, frame `scroll_*`/`wait` are
     dropped and the main ones kept last; the 250 cap counts frames; text order, frame header and the 6000 cap with the
     1000-character frame floor; password lines of a frame come first; guards carry over by global node.
   - Reader fixtures and checks: a same-origin iframe (listed, rect inside the frame, click lands, fill types), a nested
     iframe (OOPIF holding a same-origin child: rect compounds, click lands), a cross-origin iframe on a second port
     (served as `localhost:<port2>` so it is also a different site and runs out of process; click lands, its `confirm()`
     is declined and reported), a scrolled iframe (content scrolled inside, and the page scrolled: rects follow, a
     wanted off-screen row inside the frame is listed and clicked), an iframe covered by a modal (frame controls not
     listed while the modal is open; listed after it closes; a fixed banner placed over the frame after observe makes the
     click `TargetUnreachable`), a password field in an iframe (described as filled/empty, value never in the state).
   - Run red. Commit 2.
2. **Implement** `frames.ts` and the tab hooks per Design. `pnpm typecheck`, `pnpm test`, `pnpm verify:reader` green.
   Commit 3.
3. **Docs.** Commit 4.
4. **Measure:** `pnpm verify:reader` 100%; `pnpm verify` (8 scenarios plus the iframe form one); `verify:redteam` 0;
   `verify:gotchas` strict, every profile; `JEV_CHECKOUT_RUNS=3 pnpm verify:checkout`; `JEV_REAL_RUNS=3 pnpm verify:real`
   against R7; `JEV_LANGFUSE_RUNS=3 pnpm verify:langfuse` against G6 when the 9333 Chrome is up.

## Done criteria

- [ ] typecheck and tests pass; new tests and fixtures were red first
- [ ] `verify:reader` 100% including the six frame fixtures
- [ ] `pnpm verify` all pass, red-team 0, gotchas strict
- [ ] checkout, real (bot walls excluded) and Langfuse no worse than their baselines

## STOP conditions

- A red-team violation, or a password value in any page state.
- A frame read that ends a run as a browser error on a public site.
- Langfuse or checkout drop below baseline because of frame content (ids, text or refused page-level actions): roll the
  merge back to the main frame and report.

## Maintenance note

`b-capability` (plan 094) may also call `Target.setAutoAttach` on the page session for popup tabs. The setting is one
per session: whoever merges second must fold both filters (`iframe`, `page`) into one call. The frame caps (10 frames,
3 levels, 16 px, 1.5 s, 1000-character floor) are first guesses, not tuned on any app; revisit them from real-site runs.
