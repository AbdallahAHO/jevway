# Plan 011: A visually hidden checkbox or radio is listed and clicked through its visible label

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this plan in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 66fd427..HEAD -- src/browser/snapshot.js src/browser/tab.ts verify/reader.ts verify/fixture/reader/`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (page-reader change; guarded by the 20-check conformance suite)
- **Depends on**: none (plans 001–010 DONE)
- **Category**: bug
- **Planned at**: commit `66fd427`, 2026-10-15

## Why this matters

jev-browse lists the controls a model may choose from by reading the page with `src/browser/snapshot.js`. A very
common custom-control pattern is a visually hidden `<input type="checkbox|radio">` plus a visible `<label for="…">`
(or a wrapping `<label>`) that the user actually clicks. The reader drops the hidden input (it fails the visibility
check) and never lists the label, so the model cannot choose that option at all. Measured live on Grafana's time
picker: the quick ranges ("Last 24 hours", …) are exactly this markup, so 3 time-range jobs went 0/3 each — the model
kept re-clicking the picker's trigger until a loop guard stopped it. Real markup (probed 2026-10-15):
```html
<li data-testid="data-testid TimePicker time range option now-24h to now"><input class="css-aage4d" data-role="item"
  tabindex="-1" id="_r_3s_" type="checkbox" name="Time ranges"><label class="css-suzkx5" for="_r_3s_">Last 24 hours</label></li>
```

## Current state

- `src/browser/snapshot.js` — the action loop iterates `candidates` (elements matching `selector`, which includes
  `input`, plus `popupItems`) and skips any element failing `eligible(e)`:
  ```js
  const eligible = (e) => safe(e) && visible(e) && !e.matches(':disabled') && !e.closest('[aria-disabled="true"]');
  ```
  where `visible(e)` is `!e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })`.
  Popup items are collected only from `div,span,li,p` inside open popups (`[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]`).
  A checkbox/radio's action gets `role` `checkbox`/`radio`, `kind: 'click'`, `checked` from `e.checked`, and its label from
  `name(e)` (which already reads `e.labels`). An unnamed toggle is labelled from its row (`Select: <row text>`, from plan 001).
- `src/browser/tab.ts` — clicking resolves the action's `node` via `window.__jevFast.nodes.get(action.node)` in
  `RESOLVE_TARGET`, computes a click point with `window.__jevFast.clickRect(e)` and hit-tests it (`e.contains(hit)`).
  For a hidden input the hit test fails, so the click target must be the **label element**, not the input.
- Mark vendored-file edits in `snapshot.js` with a `// jev-browse:` comment (existing convention).
- `verify/reader.ts` (model-free conformance suite, 20 checks) + `verify/fixture/reader/*.html`; pattern for a check:
  ```ts
  {
    name: 'a wanted value already held on screen lists no off-screen rows',
    file: 'want-onscreen.html',
    run: async (tab) => { tab.want(['error']); const actions = await listed(tab); /* asserts */ },
  },
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Reader suite (no key) | `pnpm verify:reader` | `N/N reader checks passed` |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Grafana | `JEV_GRAFANA_ONLY=logs-24h,home-7d,explore-6h pnpm verify:grafana` | per-run lines |

## Scope

**In scope**: `src/browser/snapshot.js`, `verify/reader.ts`, `verify/fixture/reader/` (new fixtures).
**Out of scope**: `src/browser/tab.ts` (clicking the listed label element already works through `node`), `src/task/*`,
the Grafana jobs, everything else.

## Git workflow

- Commit on the branch your reviewer gave you: `test: add hidden-input label fixtures`, then
  `fix: list hidden checkboxes and radios by their visible label`. No AI attribution. Do NOT push.

## Steps

### Step 1: Fixtures (red first)

Add to `verify/fixture/reader/` and `verify/reader.ts`:
1. `hidden-checkbox-label.html` — inside an open `<div role="dialog">`, a `<ul>` of 4 `<li>`, each
   `<input type="checkbox" id="r1" style="opacity:0;position:absolute;width:0;height:0">` + `<label for="r1" style="cursor:pointer">Last 24 hours</label>`
   (ids/texts vary); clicking a label records `window.__fixture.range`. Check: an action labelled exactly
   `Last 24 hours` is listed; `act` on it sets `range`.
2. `hidden-radio-wrapped.html` — a `<label style="cursor:pointer"><input type="radio" name="plan" style="display:none"> Pro plan</label>`
   group outside any popup. Check: `Pro plan` listed; `act` checks the radio (`document.querySelector('input:checked')`).
3. `visible-checkbox.html` — an ordinary visible checkbox with a label. Check: exactly **one** action for it (the input,
   not also its label — no duplicates).

**Verify**: `pnpm verify:reader` → the new checks 1 and 2 fail, 3 passes, the 20 old checks pass.

### Step 2: List the label for a hidden checkbox/radio

In `snapshot.js`, before the main loop, collect **label stand-ins**: for each `input[type=checkbox], input[type=radio]`
in the roots that is `safe` but **not** `visible(e)`, take its label (`e.labels?.[0]`); if that label is visible, add it
to `candidates` and remember the mapping label → input. In the loop, for a stand-in label: role = the input's role
(`checkbox`/`radio`), `kind: 'click'`, label text = the label's visible text (whitespace-collapsed, capped by `cap`),
`checked: String(input.checked)`, and the element identity (`identity(...)`) of the **label** (so clicks land on it).
Skip a stand-in whose input is visible (no duplicates), and skip the hidden input itself as today. Add a
`// jev-browse:` comment explaining the pattern in one line.

**Verify**: `node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"` → exit 0;
`pnpm verify:reader` → all checks pass (23/23).

### Step 3: Measure

1. `pnpm test` → all pass; `pnpm verify` → 8/8.
2. `JEV_GRAFANA_RUNS=3 JEV_GRAFANA_ONLY=logs-24h,home-7d,explore-6h pnpm verify:grafana` (headless; needs the model key from
   the gitignored `.env`, never read or print it). Before: 0/3 each. Report per job and each failing run's status/reason.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `pnpm verify:reader` 23/23 (keyless: `env -u TYPESAFE_API_KEY pnpm verify:reader`)
- [ ] `pnpm verify` 8/8
- [ ] Grafana time-range jobs measured and reported (no target — report honestly)
- [ ] `git diff --stat 66fd427..HEAD` lists only in-scope paths

## STOP conditions

- An existing reader check fails after step 2.
- Clicking the listed label does not toggle the input in fixture 1 or 2 (the hit test or freshness check rejects it) —
  report the error; do not edit `tab.ts`.
- `pnpm verify` drops below 8/8.

## Maintenance notes

- Any `opacity:0`/`display:none` input with a visible label is now a choice through its label; if a site hides an input
  on purpose (disabled feature) it is still filtered by `:disabled`.
