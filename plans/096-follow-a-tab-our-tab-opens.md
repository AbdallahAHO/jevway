# Plan 096: A tab our tab opens is followed

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/mcp.ts` tool description must contain `Not supported: iframes, shadow DOM, canvas, file uploads, popup tabs.`
> - `Tab.attach` in `src/browser/tab.ts` must enable focus emulation, `Page.enable`, add `INPUT_COUNTER` with
>   `Page.addScriptToEvaluateOnNewDocument` and evaluate it on the open document, and answer `Page.javascriptDialogOpening`.
> - `verify/capabilities.ts` must have the task `new-tab` marked `gap: 'plan 096'`.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: M (1 day) · **Risk**: MED (the tab a session drives can change under the loop) ·
  **Category**: capability
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

`docs/prior-art.md` [C2](../docs/prior-art.md#c2). Docs links, "Open in new tab" buttons, OAuth and payment pop-ups
open a second tab. Today the run keeps reading the opener, which hasn't changed, so Jev waits, re-clicks the link (more
tabs) or hands back; `src/mcp.ts:36` lists popup tabs as unsupported. Ying-Kai-Liao switches to the new page and notes
`new tab opened: <url>` (`src/session.mjs:167-170`), and falls back to the previous tab when it closes (`:182`);
jkudish/jev-browser adopts the pending page after the step settles (`src/navigate.ts:741-746`, `:1081-1086`).

## Current state

- `Tab` is one CDP target and session. `Tab.attach` sets focus emulation, `Page.enable`, the input-delivery counter
  (new documents and the open one) and the dialog answer. `Tab.open` also applies the device (`emulate`).
- `BrowserTask` holds one `#tab` for its whole life; `get tab()` returns it; `browser_task_end` closes `task.tab` when
  the session opened it (`ownsTab`), and the CLI closes it unless `--keep-open`.

### What three probes showed (headless Chrome, raw CDP, 2026-11-01)

1. `Target.setDiscoverTargets` reports a popup as `Target.targetCreated` with `openerId` = our tab, for both a
   `target=_blank` link and `window.open` (the URL is empty at creation and filled by `targetInfoChanged`).
2. Neither a page session's `Target.setAutoAttach` (with or without a `page` filter) nor `Target.autoAttachRelated` ever
   attaches a popup: popups are not "related" targets.
3. Attaching on `targetCreated` takes about 20 ms, which is after a local page's inline script has run: a script added
   with `Page.addScriptToEvaluateOnNewDocument` then is too late for that first document.

## Scope

**In scope:** `src/browser/tab.ts` (target events, `follow`, `closed`, `takeOpened`), `src/task/run-task.ts` (switching,
the history note, `tabs`, `closeTabs`), `src/mcp.ts` and `src/cli.ts` (closing), tests, `AGENTS.md`, README "Limits",
`skill/jev-browse/SKILL.md`, plan 094's `new-tab` gap.

**Out of scope:** following a tab the user or another tool opened; several tabs at once (the newest is followed);
the recording's screencast (stays on the first tab); iframes.

## Design (decided)

1. **Which tabs.** `Tab.attach` turns on target discovery (browser level, events only) and records each `page` target
   created with `openerId` equal to its own target id. Nothing else is attached, read or changed, so in `auto` mode
   the user's own tabs are never touched.
2. **The setup.** Following is `Tab.attach` on the new target (focus emulation, `Page.enable`, the input-delivery counter
   for new documents and the open one, the dialog answer), plus the opener's device emulation and wanted values, and
   any confirmation arm the opener holds. It then waits for the first real document (up to 3 s for a URL other than
   `about:blank`, then `readyState` complete, 15 s at most) and evaluates the counter again on it.

   **Deviation from the brief, in writing:** "the same setup before its scripts run" is reachable only with
   browser-level `Target.setAutoAttach` and `waitForDebuggerOnStart`, which pauses *every* new tab in the browser
   until we release it, including the user's own in `auto` mode, which the brief forbids. So the counter is registered
   when the tab is followed: before the scripts of any later document, but after the first document's scripts when
   that document loaded within ~20 ms (probe 3). The only cost is in the safe direction of the existing invariant: a
   page listener registered earlier that stops a press from reaching `window` makes a delivered click read as not
   delivered, which ends the run `blocked` (`InputNotDelivered`); it can never make a click run twice. A dialog the
   page raises before it is followed freezes the tab, and `Page.enable` does not re-send it (probed 2026-11-01:
   `Page.enable` itself hangs and `Page.handleJavaScriptDialog` answers "No dialog is showing"). Following such a tab
   fails after 5 s (`FOLLOW_MS`) as a browser error, which ends the run `blocked` instead of waiting out 30 s protocol
   timeouts; the frozen tab is left open for the user. Accepted by the reviewer, with this window named in `AGENTS.md`.
3. **When.** After each executed action the run checks for a tab its tab opened before reading the page, and once more
   after the usual wait for a change; it also checks before each decision (a popup opened late). The newest such tab
   becomes the session's tab, and the step that opened it says so in history: its element gains
   `(new tab opened: <url>)` and `page_changed` is true.
4. **A closed tab.** A tab whose target is destroyed or detached is marked closed; `observe()` on it fails at once
   instead of retrying for 2 s. The run then goes back to the newest tab it drove that is still open and notes
   `(the tab closed; back on <url>)` on the last step.
5. **Consent carries over.** The confirmation state (`confirm_irreversible`, `confirm_target`, the last status) lives in
   the task, not the tab, so it is unchanged by a switch; a confirm-dialog arm set for the click that opened the tab
   is copied to the new tab for that step.
6. **Ending a session.** A session owns every tab it followed, since its own clicks opened them. `browser_task_end`
   closes those always and the first tab only when the session opened it (`ownsTab`); `keep_tab: true` keeps all of
   them. The CLI does the same (`--keep-open` keeps all). `task.tab` is the tab in use; `task.tabs` lists them all.
7. **Known limits.** In `auto` mode Chrome opens the popup in the foreground of the user's window (the page opens it,
   not jev-browse). The `record_dir` screencast stays on the first tab; step screenshots follow the session.

## Git workflow

1. `docs: add plan 096 follow a tab our tab opens`
2. `test: a tab our tab opens is followed and a closed one falls back`
3. `feat: follow a tab the session's tab opens`

Lowercase conventional commits. **No AI attribution of any kind**. Do NOT push.

## Steps

1. Tests first:
   - `test/tab-capabilities.test.ts` (fake CDP): a `targetCreated` with our `openerId` is taken, one with another opener
     (a user's tab) is ignored and never attached; `follow` attaches the new target and gives it focus emulation, the
     counter and the opener's device; a `targetDestroyed` for our target marks the tab closed and `observe()` rejects at
     once.
   - `test/jev-browse.test.ts`: a click that opens a tab continues on it (the next request reads the new page, history
     says `new tab opened: <url>`, the summary's `url` is the new tab's); a followed tab that closes falls back to its
     opener with a note; `closeTabs({ keepFirst })` closes the followed tabs and the first only when asked; the
     confirmation given before the switch still counts on the new tab.
   Run them red.
2. Implement as designed. `pnpm typecheck`, `pnpm test`.
3. `src/mcp.ts` (description, `browser_task_end`), `src/cli.ts`, README "Limits", `skill/jev-browse/SKILL.md`,
   `AGENTS.md` Invariants; remove the `new-tab` gap.

## Measure

`pnpm verify:capabilities` (false done 0, `new-tab` correct ≥ 2/3), `pnpm verify:reader` 100 %, `pnpm verify` 8/8.

## Done criteria

- [ ] Tests red first, then green; typecheck clean
- [ ] `new-tab` correct, false done 0
- [ ] No suite that opened no tab before behaves differently (its runs never call `follow`)

## STOP conditions

- A run ever attaches to, reads or closes a tab it did not open (a user's tab in `auto` mode).
- A click repeated because of a switch.

## Maintenance note

If a site's first popup document turns out to need the counter before its own scripts (repeated `InputNotDelivered`
right after a switch), the fix is to pause only targets whose `openerId` is ours, which needs Chrome to report the
opener at auto-attach time; re-probe `Target.setAutoAttach` filters on newer Chrome before widening anything.
