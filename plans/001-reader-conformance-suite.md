# Plan 001: A model-free conformance suite proves what the page reader lists and where clicks land

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6073e83..HEAD -- src/browser/snapshot.js src/browser/tab.ts verify/ package.json`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the
> live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (new test suite + two small, guarded reader fixes)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `6073e83`, 2026-10-15

## Why this matters

jev-browse lets a model (TypeSafe Jev) choose one element per step from a list that `src/browser/snapshot.js`
reads out of the live page; `src/browser/tab.ts` then clicks or types on the chosen element. Over the last
day about a dozen page-reader fixes landed (wide table rows, sortable headers, popup items, contenteditable
search bars, scroll-into-view, off-screen value matches). They are only exercised by live runs against a real
SaaS app, which cost API credits and are not deterministic, so any of them can silently regress. This plan
adds a deterministic suite that loads small local HTML pages in headless Chrome, calls the reader directly
(no model, no API key), and asserts exactly what is listed and that clicks land. It also fixes two reader bugs
found during review, each pinned by a fixture.

## Current state

- `src/browser/snapshot.js` — runs inside the page; returns `{ actions, text, ... }`. Each action is
  `{ id, kind: 'click'|'fill'|'select', node, role, label, rect, value?, expanded?, checked? }`.
- `src/browser/tab.ts` — `Tab` class. Public API this plan uses:
  - `static async open(cdp, url, { device }?)` → `Tab` (opens a background tab and navigates)
  - `async observe(): Promise<PageState>` — runs the snapshot; `PageState.actions: PageAction[]`, `w`, `h`, `url`
  - `async act(action: PageAction, page: PageState, text?: string)` — guarded click/type; throws
    `StalePage` if the page changed, `TargetUnreachable` (a `StalePage` subclass with `byPopup: boolean`)
    if the target can't be hit
  - `want(texts: string[])` — supplied values; off-screen matches get listed on the next `observe()`
  - `async dismissPopup()` — Escape, blur, synthetic outside press
  - `async evaluate(expression: string)` — evaluate JS in the page, returns the value
  - `async close()`
- `src/browser/chrome.ts` — `connectChrome('launch-headless')` → `{ cdp, close }`.
- Fixture serving pattern to copy — `verify/run.ts:30-40`:
  ```ts
  const otherFixtures: Record<string, Buffer> = {
    '/canvas.html': readFileSync(new URL('./fixture/canvas.html', import.meta.url)),
    '/wide-table.html': readFileSync(new URL('./fixture/wide-table.html', import.meta.url)),
  };
  const server = createServer((request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end(otherFixtures[request.url ?? ''] ?? fixture),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ```
- Existing fixture to model page style on: `verify/fixture/wide-table.html` (plain HTML + inline script that
  writes ground truth to `window.__fixture`).

**Bug A — unnamed checkboxes are labelled "on".** Radix-style checkboxes are `<button role="checkbox" value="on">`.
`name()` in `src/browser/snapshot.js:51` falls back to a button's `value`:
```js
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') ||
```
so the model sees a choice called `on` (observed live: Jev ticked a row checkbox labelled "on").

**Bug B — `want()` can flood the list.** `src/browser/snapshot.js:181-187`:
```js
    // jev-browse: an off-screen link, button or row holding a value the caller supplied is likely the target.
    const wantedOffscreen =
      offscreen &&
      wanted.length > 0 &&
      ['link', 'button', 'row'].includes(rname) &&
      wanted.some((w) => (e.innerText || '').toLowerCase().includes(w));
    if (!rname || (offscreen && !sideways && !wantedOffscreen)) continue;
```
A common value (e.g. `ERROR`) matches hundreds of off-screen rows; long lists already caused one
`max_tokens_exceeded` error from the model API.

Conventions: TypeScript run directly by Node ≥ 24 (no build step for verify scripts); 2-space indent, single
quotes, `const` arrow functions; one-line comments for intent, JSDoc with an `@example` on exported helpers.
Vendored-file edits in `snapshot.js` are marked with a `// jev-browse:` comment (see the excerpt above). Match them.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Unit tests | `pnpm test` | all pass (61 at the planned commit) |
| New suite | `pnpm verify:reader` | prints one ✔ line per fixture check, ends `N/N reader checks passed`, exit 0 |
| Snapshot syntax | `node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"` | no output, exit 0 |

The new suite needs a local Chrome (it uses `connectChrome('launch-headless')`) but **no API key**.

## Scope

**In scope**:
- `verify/reader.ts` (create) — the suite
- `verify/fixture/reader/*.html` (create) — one small page per pattern
- `src/browser/snapshot.js` — only the two fixes (Bug A, Bug B)
- `package.json` — add the `verify:reader` script only

**Out of scope** (do NOT touch):
- `src/task/run-task.ts`, `src/jev/*` — model-side logic is not under test here.
- `verify/run.ts`, `verify/langfuse.ts` — existing live suites.
- Any other behaviour change in `snapshot.js` or `tab.ts`. If a fixture reveals a different reader bug, record
  it (see STOP conditions) instead of fixing it.

## Git workflow

- Branch: `advisor/001-reader-conformance`
- Conventional commits, lowercase imperative, ≤ 72 chars, e.g. `fix: label unnamed checkboxes from their row`,
  `test: add model-free page-reader conformance suite`. No AI attribution lines. Do NOT push.

## Steps

### Step 1: Write the suite skeleton

Create `verify/reader.ts`:
- Serve every file in `verify/fixture/reader/` at `/<file name>` from a local `node:http` server (pattern above).
- `connectChrome('launch-headless')`; for each check, `Tab.open(chrome.cdp, url)`, run it, `tab.close()`.
- A check is `{ name, file, run: async (tab: Tab) => void }` and uses `node:assert/strict`. Print
  `✔ <name>` or `✘ <name> — <message>`; at the end print `<passed>/<total> reader checks passed` and set
  `process.exitCode = 1` if any failed. Close Chrome and the server in `finally`.
- Helper: `const listed = async (tab) => (await tab.observe()).actions` and
  `const find = (actions, role, label: RegExp) => actions.find((a) => a.role === role && label.test(a.label))`.
- Add `"verify:reader": "node verify/reader.ts"` to `package.json` scripts.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Add the fixtures and checks (one fixture file per row)

Each fixture is a self-contained HTML page whose inline script records outcomes in `window.__fixture`
(read with `tab.evaluate('window.__fixture')`). Keep each page under ~80 lines.

| # | Fixture file | Page | Assert |
|---|--------------|------|--------|
| 1 | `wide-rows.html` | 3 `tbody tr` rows (`cursor:pointer`, click sets `__fixture.opened`) inside an `overflow:auto` box 600px wide; table 3000px wide | 3 actions with role `row`; `act` on the first sets `opened` |
| 2 | `sideways-header.html` | same table; a sortable `th` (`cursor:pointer`, click sets `__fixture.sorted`) placed at x≈2500 | header listed as role `columnheader`; `act` sets `sorted` |
| 3 | `header-with-button.html` | sortable `th` that also contains a `<button aria-label="Drag to reorder">` | `th` listed as `columnheader` |
| 4 | `select-all-header.html` | `th` containing `<input type=checkbox aria-label="Select all">` with `cursor:pointer` | no `columnheader` for that `th`; the checkbox is listed |
| 5 | `contenteditable-search.html` | `<div role="combobox" contenteditable="true" aria-label="Search">` | listed with `kind: 'fill'`; `act(fill, page, 'level:ERROR')` → `innerText` is `level:ERROR` |
| 6 | `popup-items.html` | button `aria-expanded="true"` + `<div role="dialog">` with plain `<div style="cursor:pointer">Past 7 days</div>` items | items listed as role `option`; `act` on "Past 7 days" sets `__fixture.range` |
| 7 | `escape-ignored.html` | a `role=listbox` over a button; the list closes only on `pointerdown` outside it (not on Escape) | `act` on the covered button throws `TargetUnreachable` with `byPopup === true`; after `tab.dismissPopup()` the same `act` succeeds |
| 8 | `below-fold.html` | 60 rows of links `u-0001`..`u-0060`; viewport shows ~15 | without `want`: `u-0050` not listed; after `tab.want(['u-0050'])`: listed; `act` scrolls it in and sets `__fixture.opened = 'u-0050'` |
| 9 | `want-flood.html` | 300 off-screen rows all containing `ERROR` | after `tab.want(['error'])`: at most 5 off-screen rows listed (Bug B fix) |
| 10 | `want-onscreen.html` | one on-screen link `ERROR log` + 50 off-screen rows containing `ERROR` | after `tab.want(['error'])`: no off-screen rows listed (Bug B fix) |
| 11 | `unnamed-checkbox.html` | table row `<tr><td><button role="checkbox" value="on"></button></td><td>Casa Flora</td></tr>` | checkbox label is not `on` and contains `Casa Flora` (Bug A fix) |
| 12 | `json-row.html` | a row whose text is a 5 000-char JSON blob | every label length ≤ 200 |
| 13 | `row-label.html` | row with nested `<input type=checkbox aria-label="Select row">` + text `Trace 42` | row label starts with `Trace 42` and does not contain `Select row` |
| 14 | `clipped-sidebar.html` | 300px-tall `overflow:auto` nav with 30 links; target link at the bottom (clipped) | `act` on the last link succeeds and sets `__fixture.nav` |
| 15 | `modal.html` | page button + open `<div role="dialog" aria-modal="true">` with an OK button | only controls inside the modal are listed |
| 16 | `shadow.html` | custom element with an open shadow root holding `<button>Search</button>` | button listed; `act` sets `__fixture.clicked` |
| 17 | `hidden-and-disabled.html` | `aria-hidden="true"` button, `inert` button, `disabled` button, one normal button | only the normal button listed |
| 18 | `labelled-by.html` | `<input aria-labelledby="l">` with `<span id="l">Email address</span>` | fill action labelled `Email address` |
| 19 | `native-select.html` | `<select>` with 3 options, one selected | 2 `select` actions (unselected options), labels `<field> → <option>` |
| 20 | `sticky-cover.html` | `position:fixed` 60px header over a button at the top edge after scrolling | `act` on the covered button throws `TargetUnreachable` with `byPopup === false` |

**Verify**: `pnpm verify:reader` → all checks pass **except** 9, 10 and 11 (they need the fixes in steps 3–4).
If any other check fails, that is a STOP condition (record the failure, do not fix the reader).

### Step 3: Fix Bug A (unnamed checkbox label)

In `src/browser/snapshot.js`, where actions are built (`label: cap(...)` in the `base` object), when the
element's role is `checkbox`, `radio` or `switch` and `name(e)` is empty **or** equals the element's `value`,
label it from its row or label context instead:
```js
// jev-browse: an unnamed checkbox is named by its row ("Select: Casa Flora"), not its value "on".
```
Use the nearest `tr, [role="row"], li, label` ancestor's `innerText` (whitespace collapsed, first 80 chars),
formatted `Select: <text>`; fall back to the role name if there is no such ancestor. Do not change `name()`
itself (other roles rely on the value fallback for `<input type=submit value="Pay">`).

**Verify**: `node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"` → exit 0;
`pnpm verify:reader` → check 11 passes.

### Step 4: Fix Bug B (bounded off-screen value matches)

In the same loop, change the off-screen value-match rule so that:
1. it applies only when **no on-screen** link/button/row contains a wanted value (compute this once before the
   loop with a cheap pre-pass, or collect candidates and decide after the loop), and
2. at most **5** off-screen matches are listed (first 5 in document order).
Keep the `// jev-browse:` comment and update it to say both limits.

**Verify**: `pnpm verify:reader` → all 20 checks pass; `pnpm test` → all pass.

## Test plan

- The 20 fixture checks above are the tests. Model the script structure after `verify/run.ts` (server,
  `connectChrome`, a `scenario`-style wrapper that records pass/fail and prints a line).
- No unit-test changes are required; `pnpm test` must stay green.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm verify:reader` exits 0 and prints `20/20 reader checks passed` (or more if you added checks)
- [ ] `pnpm verify:reader` needs no API key: `env -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY pnpm verify:reader` exits 0
- [ ] `git diff --stat 6073e83..HEAD` lists only in-scope paths
- [ ] `plans/README.md` status row updated (unless your reviewer maintains it)

## STOP conditions

Stop and report back (do not improvise) if:
- A check other than 9, 10, 11 fails in step 2 — report the fixture, the assertion and the observed actions;
  that is a reader bug for a new plan, not for this one.
- Headless Chrome can't be launched (`connectChrome('launch-headless')` throws).
- Fixing Bug A or B appears to require changing `name()` or anything in `src/browser/tab.ts`.
- `pnpm test` fails after step 3 or 4 twice after a reasonable fix attempt.

## Maintenance notes

- Every future page-reader fix should add a fixture here first (red), then the fix (green).
- The suite must stay model-free and fast (target < 60 s); do not add `BrowserTask` or API calls to it.
- Bug B's limits (5, on-screen-first) are heuristics; if a real task needs the 6th match, the calling agent can
  narrow the value instead.
