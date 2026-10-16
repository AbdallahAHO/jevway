# Plan 043: Controls with identical labels are told apart by the card or row they belong to

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat a398ca8..HEAD -- src/browser/snapshot.js verify/reader.ts verify/fixture/reader/`
> — on any output, STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (labels the model sees; only for controls whose labels collide) ·
  **Category**: bug
- **Planned at**: commit `a398ca8`, 2026-10-16

## Why this matters

On SauceDemo's product list (the checkout suite, gate R3) jev-browse lists four buttons all labelled **"Add to
cart"** (probed 2026-10-16), one per product card. The model can't tell which button adds which product, so a goal like
"add the Bike Light and the Onesie, then remove the Bike Light" wanders (`change-mind` 1/3: unsure, scrolling). Lists of
cards or rows with repeated actions ("Add to cart", "Edit", "Delete", "Open") are everywhere. A person reads the card the
button sits in. When two or more listed controls share a label, each should carry its card's or row's identifying text:
"Add to cart — Sauce Labs Bike Light".

## Current state

- `src/browser/snapshot.js` builds `actions` in one loop; each action has `label` (capped by `cap(…, 200 - suffix.length)`
  plus a `suffix` for hover controls), `role`, `node`, `kind`. Rows already use their text, unnamed toggles use
  `Select: <row text>` (`rowContext`), and the container fallback (`contextName`) skips text inside other controls.
  `name()` and `cache.guard` must not change. Vendored edits carry `// jev-browse:`.
- Probe shape: each SauceDemo card is a `div.inventory_item` holding an image link, a title link
  (`<div class="inventory_item_name">Sauce Labs Bike Light</div>` inside an `<a>`), a description, a price and the button.
- Reader suite `verify/reader.ts` (`{ name, file, run }`, helpers `listed`, `find`, `controls`, `labelsOf`, `fixtureState`),
  42 checks today.

## Scope

**In scope**: `src/browser/snapshot.js` (a pass after the main loop over `actions`), `verify/reader.ts`,
`verify/fixture/reader/repeated-actions.html` (new). **Out of scope**: `name()`, `cache.guard`, roles, `tab.ts`, `src/task/*`.
Do not run `verify:langfuse` or touch the Chrome on port 9333.

## Git workflow

Commits: `test: add a card grid with repeated action labels`, `fix: tell controls with the same label apart by their card or row`.
No AI attribution. Do NOT push.

## Steps

1. Fixture (red first): a grid of four `.card` divs, each with an `<h3>` title ("Backpack", "Bike Light", "Onesie",
   "Jacket"), a price, and `<button>Add to cart</button>` (clicking records the card's title in
   `window.__fixture.added`); plus one card with two links to the same title (`<a>` image link and `<a>` title link, both
   named "View Backpack") and a single unique button "Checkout". Checks:
   - `'repeated action labels carry their card'`: four buttons labelled exactly `Add to cart — Backpack`, `… — Bike Light`,
     `… — Onesie`, `… — Jacket`; `act` on the Bike Light one → `added` is `['Bike Light']`.
   - `'unique labels are unchanged'`: `Checkout` keeps its label; the two "View Backpack" links (same text, same card) may
     stay identical (they lead to the same place) — assert they do not get a misleading context.
   Run the reader → the first check fails. Commit 1.
2. After the main loop, group listed actions by `role + label` (ignore `wait`/`scroll`/key actions). For each group of 2+
   whose elements are different nodes, find for each element its **distinguishing context**: walk up at most 4 ancestors
   to the nearest one that holds that element but none of the other group members; take that ancestor's visible text
   **outside other controls' text except headings and titles** — simplest robust choice: the text of the first heading
   (`h1–h6`, `[role=heading]`) or title-like element (a link or element whose text is short) inside that ancestor, else
   the ancestor's own visible text, whitespace-collapsed, capped at 60 chars. Append ` — <context>` to each member's label
   (within the 200-char cap, before any hover suffix). If two members end up with the same context, leave both unchanged.
   Mark with `// jev-browse:` (a person reads the card or row a repeated button sits in).
   Snapshot syntax check (`node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"`) → 0; reader
   → all pass (44); `pnpm test` → all pass. Commit 2.
3. Measure: `CI=1 JEV_CHECKOUT_RUNS=3 pnpm verify:checkout` (report per job; before: 13/18, change-mind 1/3, place-order
   0/3); `pnpm verify` → 8/8; `pnpm verify:grafana` (headless) → report; `pnpm verify:gotchas` → strict per profile. Also
   probe SauceDemo's product list once (scratch script in `$TMPDIR`, harness sign-in as in `verify/checkout.ts`) and report
   the "Add to cart" labels. The model key is in the gitignored `.env`; never read or print it.

## Done criteria

- [ ] typecheck/test exit 0; reader 44/44 keyless (new check red first); `pnpm verify` 8/8
- [ ] Checkout, Grafana and gotchas reported; the probe's labels reported
- [ ] `git diff --stat` lists only the three in-scope paths

## STOP conditions

- An existing reader check fails after step 2 (a unique label changed).
- Grafana drops below 22/24 or gotchas strict below 29/30.

## Maintenance notes

- Only colliding labels change, so most pages are untouched; a list with 50 identical "Edit" buttons gets 50 contexts —
  if that ever floods requests, cap the context length further.
