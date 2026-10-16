# Plan 032: Links in a visible table row are listed even when the table is scrolled sideways away from them

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat f91840e..HEAD -- src/browser/snapshot.js verify/reader.ts verify/fixture/reader/`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (lists more controls; capped)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f91840e`, 2026-10-16

## Why this matters

jev-browse's page reader (`src/browser/snapshot.js`) lists only controls inside the viewport, with exceptions: a
sortable column header scrolled sideways out of its table is listed (clicking scrolls it in), and so is an off-screen
link/button/row holding a value the caller supplied. On a phone, wide tables scroll sideways inside their box. In
Langfuse's Scores table the trace links sit in the rightmost column, out of view; the only way the model could reach
that column was its sortable "Trace" header — and clicking it **re-sorted** the table by Trace, losing the Value sort the
goal needed. worst-relevance went 0/3 on an emulated iPhone 15 (each run looped re-sorting until the 20-step budget).

A link in a row whose row is vertically on screen is a real choice a person would make by swiping the table sideways.
List such links (capped), labelled with their row so the model knows which row they belong to; clicking them already
scrolls them into view (`RESOLVE_TARGET` scrolls a clipped target in once).

## Current state

- `src/browser/snapshot.js` main loop (excerpt):
  ```js
    const hiddenInput = labelOf.get(e), r = cache.clickRect(e), y = r.y + r.height / 2,
      rname = hiddenInput ? hiddenInput.type : role(e);
    // jev-browse: a sortable header scrolled sideways out of its table is still a choice; clicking scrolls it in.
    const sideways = rname === 'columnheader' && y >= 0 && y < innerHeight && e.getBoundingClientRect().width > 0;
    const offscreen = outOfView(r);
    const wantedOffscreen = offscreen && !wantedOnscreen && wantedListed < 5 && holdsWanted(e, rname);
    if (wantedOffscreen) wantedListed++;
    if (!rname || (offscreen && !sideways && !wantedOffscreen)) continue;
  ```
  and the label (rows use their text; other controls their name, then fallbacks):
  ```js
      label: cap((rname === 'row' || hiddenInput ? e.innerText… : unnamedToggle(e, rname) ? rowContext(e) : name(e)…) ||
            contextName(e, hiddenInput, rname) || rname, 200 - suffix.length) + suffix,
  ```
  Vendored-file edits carry a `// jev-browse:` comment.
- `verify/reader.ts` checks; the existing sideways-header check is the pattern:
  ```ts
  {
    name: 'a sortable header scrolled sideways out of its table is listed and sorts on click',
    file: 'sideways-header.html',
    run: async (tab) => { … const header = find(page.actions, 'columnheader', /Latency/); … await tab.act(header, page); … },
  },
  ```
  Add your checks right **after this sideways-header check** (another plan adds checks after the hover checks in
  parallel; keep your hunk apart from theirs).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Snapshot syntax | `node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"` | exit 0 |
| Reader (keyless) | `env -u TYPESAFE_API_KEY pnpm verify:reader` | `N/N` (34 before) |
| Live fixtures | `pnpm verify` | `8/8` |
| Grafana | `pnpm verify:grafana` | 23–24/24 |
| Gotchas | `pnpm verify:gotchas` | strict 90/90 last time |

## Scope

**In scope**: `src/browser/snapshot.js` (the off-screen rule and the label for these links), `verify/reader.ts`,
`verify/fixture/reader/sideways-row-links.html` (new).

**Out of scope**: `tab.ts`, `src/task/*`, `src/jev/*`, the sideways-header rule itself. Do not run `verify:langfuse` or
touch the Chrome on port 9333.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: add a sideways-scrolled table with row links`
  2. `feat: list links in visible rows scrolled sideways out of view`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Fixture and checks (red first)

`sideways-row-links.html`: a 400 px-wide `overflow-x: auto` box holding a 1400 px-wide table with columns Name,
Value (sortable header that records `window.__fixture.sorted`), a long Comment column, and Trace (a link per row, e.g.
`<a href="#" data-trace="t-1">t-1abc</a>`, clicking records `window.__fixture.opened`). 30 rows; rows 1–8 vertically
visible. The Trace column starts beyond the box's right edge.
Checks:
- `'a link in a visible row scrolled sideways is listed with its row and opens on click'`: a `link` action whose label
  starts with `t-1abc` and includes row context (the row's Name), is listed; `act` on it → `__fixture.opened === 't-1'`
  and `__fixture.sorted` is still `null` (no header was clicked).
- `'sideways row links are capped'`: at most 20 such links are listed, and none for rows that are vertically off-screen.
**Verify**: reader → both new checks fail; the 34 existing pass. Commit 1.

### Step 2: The rule

In `snapshot.js`: a `link` (or `button`) inside a row (`closest('tr,[role="row"]')`) whose row's vertical centre is in
the viewport, whose own box is laid out (`width > 0`) but horizontally out of view, and that sits inside a horizontally
scrollable ancestor (`scrollWidth > clientWidth` with `overflow-x` auto/scroll), is listed: at most 2 per row and 20
overall. Its label is its own name followed by ` — row: ` and the row's text (whitespace-collapsed, the whole label
still capped by `cap`). Mark the code `// jev-browse:` with one line (a person swipes the table sideways to reach it;
clicking scrolls it in).

**Verify**: snapshot syntax → 0; reader → all pass (36); `pnpm test` → all pass. Commit 2.

### Step 3: Measure

`pnpm verify` → 8/8; `pnpm verify:grafana` (desktop, headless) → report (last 23–24/24); `pnpm verify:gotchas` → strict
per profile (last 30/30 each). Headless Chrome only. The model key is in the gitignored `.env`, loaded by the npm
scripts; never read or print it. Your reviewer measures Langfuse (phone and desktop) after merging.

## Test plan

Two model-free checks on a fixture shaped like Langfuse's Scores table on a phone (red first): listed with row context,
opens without re-sorting, capped. Live suites as regression guards.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; reader 36/36 keyless, new checks red at commit 1
- [ ] `pnpm verify` 8/8; Grafana and gotchas reported
- [ ] `git diff --stat f91840e..HEAD` lists only the three in-scope paths

## STOP conditions

- Any existing reader check fails after step 2.
- Gotchas strict below 29/30, or Grafana below 22/24.

## Maintenance notes

- The caps keep the action list from growing with rows × link columns. If desktop wide tables start listing many of
  these, lower the per-row cap before the overall one.
