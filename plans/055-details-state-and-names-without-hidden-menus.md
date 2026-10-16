# Plan 055: A `<summary>` shows whether its section is open, and a control's name leaves out its hidden menu

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 052 must be merged (`git log --oneline -15 | grep "unknown role as a button"`). Then
> `git diff --stat <that commit>..HEAD -- src/browser/snapshot.js verify/reader.ts` must be empty. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: MED (names change wherever a control holds hidden text) · **Category**: bug (gate R1)
- **Planned at**: commit `476f332` plus plan 052, 2026-10-16

## Why this matters

A Forgejo diagnosis on 2026-10-16 found two reader gaps that no wording can fix.

1. **A `<details>` section's open state is invisible.** Forgejo's repository settings sidebar has
   `<details><summary>Units</summary>…</details>`. Clicking "Units" expands it in place, with no URL change. The reader
   takes `expanded` only from `aria-expanded`, which `<summary>` doesn't carry. So the model sees the same "Units"
   control after each click and clicks it again, until the toggle guard ends the run `blocked` (wiki-off 0/3; 5/5 in
   the diagnosis).

   With a page-side shim mirroring `details[open]` to `aria-expanded`, the model clicked Units → "Wiki — Repository" →
   "Enable repository wiki" → Save settings, and the wiki was really off in 4 of 5 runs. `<details>` is standard HTML,
   common in settings pages, FAQs and docs sidebars.
2. **A dropdown trigger is named after its whole hidden menu.** Forgejo's issue-form label picker lists as
   "Labels Filter label Clear labels bug enhancement help wanted wontfix". `name()` walks every child node,
   including the menu that is `display:none` until opened. That name reads like a destructive panel to the commit-risk
   question: risk 0.54–0.59, so new-issue stops at `needs_confirmation` on a harmless dropdown in 4 of 5 runs.

   The accessible-name rules (accname) skip hidden descendants unless they are referenced by `aria-labelledby`. The
   person sees "Labels"; the name should say the same.

## Current state

- `src/browser/snapshot.js` `name(e, seen)` (top of the file). Its child walk:
  ```js
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === 3
                ? n.textContent
                : n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true'
                  ? name(n, seen)
                  : '',
            )
  ```
  `aria-labelledby` references resolve through `name(document.getElementById(id), seen)`. Those must keep working even
  when the referenced element is hidden (accname rule).
- The expanded state, in the action loop (~line 338):
  ```js
      for (const key of ['checked', 'selected', 'expanded']) {
        const value = e.getAttribute('aria-' + key);
        if (value !== null) base[key] = value;
      }
  ```
  `role(e)` returns `'button'` for `SUMMARY`.
- Earlier plans said `name()` must not change. This plan changes it on purpose, narrowly: hidden **descendants** are
  skipped in the child walk only. Check whether `cache.guard` or `tab.ts` compares names. If it does, both sides use
  the same `name()`, so they stay consistent, but report what you find.
- Reader checks: `{ name, file, run }`; reuse the helpers. 48 checks after plan 052; count yours from the actual base.

## Scope

**In scope**: `src/browser/snapshot.js` (the `name()` child walk and the expanded-state lines), `verify/reader.ts`,
`verify/fixture/reader/details-section.html` and `verify/fixture/reader/dropdown-hidden-menu.html` (new).

**Out of scope**: `aria-labelledby` handling, `cache.guard`, `role()`, commit-risk prompts. Do not run `verify:langfuse` or touch the
Chromes on 9333 and 9444.

## Git workflow

Commits:
1. `test: a details section and a dropdown with a hidden menu`
2. `fix: show whether a details section is open`
3. `fix: name a control without the text of its hidden descendants`

No AI attribution. Do NOT push.

## Steps

1. **Fixtures and checks, failing first.**
   - `details-section.html`: a sidebar with `<details><summary>Units</summary><a href="#wiki">Wiki</a></details>`
     (closed), and one `<details open>` section. Check `'a details summary shows whether its section is open'`:
     - "Units" is listed with `expanded: 'false'`;
     - after `act`, it is listed with `expanded: 'true'` and "Wiki" is listed;
     - the open section's summary reads `expanded: 'true'`.
   - `dropdown-hidden-menu.html`: a `div tabindex="0" role="button"` labelled by its visible text "Labels", holding a
     `display:none` menu with "Filter label", "bug" and "wontfix"; also a button whose visible text is "Save" and that
     has a `visibility:hidden` span "(unsaved)"; and an `aria-labelledby` pointing at a `display:none` element with
     text "Hidden name". Check `'a control is named without the text of its hidden descendants'`:
     - the trigger is named exactly "Labels";
     - the Save button is named "Save";
     - the `aria-labelledby` control is still named "Hidden name".

   Run `pnpm verify:reader`: both new checks fail (the labelledby part already passes). Commit 1.
2. **`<details>`.** Where `expanded` is read, add: when `e` is a `SUMMARY` whose parent is a `DETAILS` and it has no
   `aria-expanded`, set `base.expanded = String(e.parentElement.open)`. Mark it with `// jev-browse:` (a summary's
   section is open or closed, as its triangle shows). Run the syntax check, then reader: the details check passes.
   Commit 2.
3. **Names.** In `name()`'s child walk, skip an element child that isn't rendered:
   `!n.checkVisibility({ checkVisibilityCSS: true })`, which covers `display:none` and `visibility:hidden`. Don't use
   opacity: hover-only controls use it and must keep their names. Don't change the `aria-labelledby` path. Mark it with
   `// jev-browse:` (accessible names leave out hidden descendants, so a dropdown reads as "Labels", not its menu).

   Run the syntax check; `pnpm verify:reader` → all pass. If an existing check fails, STOP and report which, with its
   label before and after. Then `pnpm test`. Commit 3.
4. **Measure**, headless; the model key is in the gitignored `.env`, so never read or print it:
   - `pnpm verify` → 8/8.
   - `pnpm verify:gotchas` → strict per profile.
   - `CI=1 pnpm verify:grafana` (desktop) → 24/24.
   - `CI=1 JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` → 24/24.
   - `CI=1 JEV_CHECKOUT_RUNS=2 pnpm verify:checkout` → report.
   - `pnpm verify:redteam` → `violations: 0`.
   - Forgejo, only when your reviewer says the stack is free:
     `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=wiki-off,new-issue,description pnpm verify:forgejo` → report.
   - A probe that prints how many listed labels changed on Grafana home and SauceDemo's product list compared with
     the base commit: the name change's blast radius.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader all pass, with the new checks failing first; `pnpm verify` 8/8; red-team 0 violations
- [ ] Grafana desktop and phone, gotchas, checkout and Forgejo (3 jobs) reported; the label-change probe reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- An existing reader check fails after step 3.
- Grafana desktop below 23/24, Grafana phone below 23/24, or gotchas strict below 29/30 on any profile.

## Maintenance notes

- Langfuse (the desktop gate on 9333) is re-measured at round end. Watch for labels that relied on hidden text, such
  as an icon button whose only name came from a `visibility:hidden` span; `title` and `aria-label` still apply.
