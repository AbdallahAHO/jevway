# Plan 052: A focusable dropdown trigger with an unrecognised role is listed as a button; onboard saves its profile

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat d55c418..HEAD -- src/browser/snapshot.js verify/reader.ts verify/signup.ts verify/jobs/runner.ts`.
> Plan 051 may have changed the `canHover` lines of `snapshot.js` and added one phone reader check; anything else: STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (the reader lists a new kind of control) · **Category**: bug (gate R2)
- **Planned at**: commit `d55c418`, 2026-10-16

## Why this matters

Gate R2's `onboard` job (sign up, activate, set the full name in profile settings) is 0/3. A diagnosis on 2026-10-16 found two stacked causes.

1. **The reader never lists Forgejo's avatar menu**, so the model has no route to Settings and every run ends
   `needs_input` on "Search repos…" (0 of 11 samples got past the dashboard).
   - The trigger is `<div class="ui dropdown jump item" role="menu" aria-haspopup="" aria-controls="…" aria-expanded="false" aria-label="Profile and settings…" tabindex="0">`.
     It is a candidate through `[tabindex="0"]`.
   - `role()` treats a tabbable element as a button only when it has **no** explicit role. Here `role="menu"` isn't in
     `roles`, so `role()` returns null.
   - Forgejo's "Create…" menu, Gitea, and any Fomantic/Semantic UI app use the same markup.
   - A scratch fix ("a focusable element with `aria-expanded` and an unrecognised explicit role is a `button`") listed
     `button "Profile and settings…" expanded=false` and passed the reader 46/46. With it, 21 of 21 samples went
     Profile and settings… (click head 0.99) → Settings → TYPE_TEXT Full name → Update profile.
2. **The run stops at "Update profile".**
   - With no "save" in the goal, the model often chooses DONE after typing (done rejected 3× → `uncertain`).
   - With "…and save it", it always reaches Update profile, but that click's commit risk is 0.50–0.63, over the 0.5
     gate. The suite's harness then hands back, because it confirms only one click per call, and only clicks matching
     `confirms` (`/register|activate|confirm password/i`).
   - Saving the profile is the action the user's request names, so a careful caller confirms it.

## Current state

- `src/browser/snapshot.js` `role(e)` (~line 91):
  ```js
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    …
    if (e.getAttribute('tabindex') === '0' && !explicit && !['INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(e.tagName)) {
      return pointer(e) ? 'button' : null;
    }
  ```
  Vendored edits carry `// jev-browse:`. `name()` and `cache.guard` must not change.
- `verify/jobs/runner.ts` `runCall(task, confirms, confirmations)`:
  - runs the call;
  - on `needs_confirmation` whose quoted label matches `confirms`, confirms once and runs again;
  - records a second `needs_confirmation` as `{ given: false }` and returns.
- `verify/signup.ts`: `REGISTER = /register/i`, `ACTIVATE = /register|activate|confirm password/i`. onboard's follow-up
  goal is `I typed the password into the activation form; finish activating the account, then set your full name to the name in values in your profile settings.`
  and it is built by `activateByMail(goal)`, which sets `confirms: ACTIVATE`.
- Reader checks: `{ name, file, run }` with the helpers `find`, `listed`, `labelsOf`, `fixtureState`. Copy the pattern of
  `'a panel menu that appears only on hover…'`.

## Scope

**In scope**: `src/browser/snapshot.js` (`role()` only), `verify/reader.ts`, `verify/fixture/reader/fomantic-dropdown.html` (new),
`verify/jobs/runner.ts` (`runCall`), `verify/signup.ts` (onboard's follow-up goal and its confirm pattern).

**Out of scope**: commit-risk prompts and thresholds (the 0.5–0.63 risk on "Update profile" is a separate calibration
question; see the maintenance note), `src/task/*`, other suites' jobs. Do not run `verify:langfuse` or touch the Chromes
on 9333 and 9444. Never run `apps:forgejo:down`. Plan 046's executor is running the Forgejo suite on `ada/app` and
`ada/scratch` at the same time, which is fine, because sign-up uses only `signup-…` users.

## Git workflow

Commits:
1. `test: add a dropdown trigger whose role the reader does not know`
2. `fix: list a focusable dropdown trigger with an unknown role as a button`
3. `test: let a call confirm each click its user asked for, and onboard save its profile`

No AI attribution. Do NOT push.

## Steps

1. **Fixture, failing first.** Create `fomantic-dropdown.html`: a header with a `div role="menu" aria-haspopup=""
   aria-expanded="false" tabindex="0" aria-label="Profile and settings…"` holding an `<img alt="">`. Clicking it toggles
   `aria-expanded` and shows a menu of `role="menuitem"` links "Profile", "Settings", "Sign out". Clicking Settings
   records `window.__fixture.opened = 'settings'`. Add one more `div role="menu" tabindex="0"` **without**
   `aria-expanded` (a plain menu container), which must stay unlisted.

   Add the check `'a focusable dropdown trigger with an unknown role is listed as a button and opens'`:
   - `button "Profile and settings…"` is listed with `expanded: 'false'`;
   - acting on it lists the menuitem "Settings";
   - acting on Settings sets `opened`;
   - the plain container is not listed.

   Run `pnpm verify:reader`: the new check fails. Commit 1.
2. **The rule.** In `role()`, after the `tabindex="0" && !explicit` branch, add: a `tabindex="0"` element whose
   explicit role is unknown (not in `roles`) **and** that has an `aria-expanded` attribute is a `'button'`. One
   `// jev-browse:` comment: a dropdown trigger that names itself with a role we don't list ("menu" on Fomantic UI's
   avatar menu) is still a disclosure button, as its `aria-expanded` says.

   Run the snapshot syntax check (`node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"`)
   → 0; `pnpm verify:reader` → all pass; `pnpm test` → pass. Commit 2.
3. **The suite.**
   - In `runner.ts`, make `runCall` confirm **each** `needs_confirmation` whose label matches `confirms`, up to 3 in
     one call (the skill's rule: one confirmation per click, each named by the user). A label that doesn't match ends
     the call as today, recorded as `{ given: false }`. Keep `confirmations` recording every label with `given`.
     Update the doc comment.
   - In `signup.ts`, change onboard's follow-up goal to `I typed the password into the activation form; finish activating the account, then set your full name to the name in values in your profile settings and save it.`
     and give onboard's follow-up its own pattern, `/activate|confirm password|update profile/i`. sign-up keeps `ACTIVATE`.

   `pnpm typecheck` → 0. Commit 3.
4. **Measure**, headless; the model key is in the gitignored `.env`, so never read or print it:
   - `CI=1 pnpm verify:signup` → per job against 12/15 at `d55c418`, with every confirmation label.
   - `pnpm verify` → 8/8.
   - `pnpm verify:gotchas` → strict per profile.
   - `pnpm verify:redteam` → `violations: 0`.
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → 8/8.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader all pass, with the new check failing first; `pnpm verify` 8/8; red-team 0 violations
- [ ] signup per job with confirmation labels; gotchas and Grafana reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- Any existing reader check fails.
- A red-team violation.
- Grafana below 8/8 (Grafana uses many `tabindex` widgets).

## Maintenance notes

- "Update profile" and "Save settings" (Forgejo's description job) are rated irreversible at about 0.5–0.6. Saving
  settings is reversible. If more suites hit this, consider a commit-risk wording plan, measured against red-team.
