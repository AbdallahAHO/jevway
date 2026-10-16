# Plan 047: Page text says whether each password field is filled or empty, never what it holds

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 75378ce..HEAD -- src/browser/snapshot.js verify/reader.ts verify/signup.ts` must be
> empty (plans 043 and 040 are merged at or before `75378ce`). Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (it touches the security invariant for password fields; the value must never leave the page) · **Category**: bug
- **Depends on**: plans 043 (same files), 040 (the sign-up suite measures it)
- **Planned at**: commit `75378ce`, 2026-10-16

## Why this matters

jev-browse never lists password fields: `src/browser/snapshot.js` filters out `type=password` (`safe`), so the model
can't choose one and never types a password. The calling agent types passwords with its own tool (`skill/jev-browse/SKILL.md`).
The model also gets no sign that the field exists. When the calling agent has already filled it, the model sees a form
with a gap, follows its rule "Fill required fields before submitting", and stops.

This was measured on the sign-up suite (gate R2, `pnpm verify:signup`). On Forgejo's activation page
(`/user/activate?code=…`) the harness types the password, as the agent would, and the only step left is clicking
"Confirm password". The model chose that button with 0.97 confidence but picked BLOCKED for the operation (BLOCKED 0.49,
CLICK 0.46). Sign-up ended `blocked` there in 1 of 3 runs and onboard in 2 of 3. Login and checkout forms that the agent
partly fills are common, so the same gap appears on any site.

A person sees the dots in the field. The model should get the same fact in words, and only that fact: filled or empty,
never the value or its length.

## Current state

- `src/browser/snapshot.js`, near the top: `const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);`. It is used by
  `eligible` and `revealedByHover`, and those uses must not change: password fields stay out of `actions`.
- The page text is built near the end of the IIFE:
  ```js
  const words = [];
  …
  for (const root of roots) { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); … words.push(value); … }
  const text = words.join('\n').slice(0, 6000),
  ```
  `text` goes into the model's request (`state.page.text` in `src/jev/decide.ts` `buildRequest`). Its first 800 characters
  also go into the hand-back `stuck.page_text` (`src/task/run-task.ts`). `text` is part of `marker`, so filling a password
  field counts as a page change. That is fine and expected.
- `name(e)` gives a field's accessible name. `visible(e)` checks `aria-hidden`/`inert` and CSS visibility.
- Edits to this vendored file carry `// jev-browse:`, and `name()` and `cache.guard` must not change.
- Reader suite: `verify/reader.ts` (`{ name, file, run }`; helpers `listed`, `controls`, `labelsOf`; read `(await tab.observe()).text`
  for page text). The `hidden-and-disabled.html` check is a style example. There are 44 checks after plan 043.

## Scope

**In scope**: `src/browser/snapshot.js` (the page-text lines only), `verify/reader.ts`, `verify/fixture/reader/password-fields.html` (new),
`AGENTS.md` (one invariant sentence), `verify/signup.ts` (the `onboard` job's first-call `goal` only, step 4).

**Out of scope**: `safe`, `eligible`, `actions`, `tab.ts`, `src/jev/*`, `src/task/*`, every suite's jobs. Do not run
`verify:langfuse` or touch the Chrome on port 9333. Never run `apps:forgejo:down` or recreate the stack.

## Git workflow

Commits: `test: add a form whose password fields are filled and empty`, `fix: say whether each password field is filled, never its value`,
`test: onboard asks for the profile step only after activation`.
No AI attribution. Do NOT push.

## Steps

1. **Fixture, failing first.** Create `password-fields.html`, a sign-in form with three fields: a text field "Username"; a
   password field labelled "Password" whose value is set on load by a script to the string `fixture-secret-9431` (a
   person or agent filled it); and a password field labelled "Confirm password", left empty. Add a hidden password field
   (`style="display:none"`, label "Old password") and a "Sign in" button. Add one reader check, `'password fields are
   described as filled or empty, never listed or read'`:
   - `JSON.stringify(await tab.observe())` contains neither `fixture-secret-9431` nor `secret-9431`;
   - no action is listed for any password field (the listed controls are exactly the username field and its "Open" click, plus "Sign in");
   - the page text contains `Password field "Password": filled` and `Password field "Confirm password": empty`;
   - the page text says nothing about "Old password" (hidden fields are not described).

   Run `pnpm verify:reader`: the new check fails. Commit 1.
2. **The rule.** In `snapshot.js`, collect the visible password inputs (`input[type=password]` in `roots`; `visible(e)`;
   at most 5) and put one line per field **before** the walked text, so the 6000-character cap never cuts them:
   `Password field "<name(e), whitespace-collapsed and capped at 60, or 'unnamed'>": filled` when `e.value !== ''`, else
   `…: empty`. Add a short note on the first line only: `(passwords are typed by the user, not by you)`, e.g.
   `Password field "Password": filled (passwords are typed by the user, not by you)`. Read `e.value` only to compare it with `''`;
   never copy it, its length or any part of it into a variable that leaves the function. Mark the lines with
   `// jev-browse: a person sees whether a password field has dots in it; the model gets only that fact, never the value.`
   Syntax check: `node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"` exits 0. Run `pnpm verify:reader`:
   all pass (45). Run `pnpm test`: all pass.
3. **AGENTS.md.** Below the invariant about screenshot marks, add one sentence: "Password fields are never listed; page
   text says only whether each visible one is filled or empty, never its value or length." Commit 2.
4. **onboard plays a careful caller.** In `verify/signup.ts` the `onboard` job's first call asks for the whole chore
   ("Create an account …, then after activating it, set your full name …"), but activation needs the email, which only
   the calling agent can read. So in all 3 runs the model went past Register looking for the rest and wandered off. A
   careful agent asks only for what it can supply now. Set onboard's first-call `goal` to the same text as `sign-up`'s
   ("Create an account with the username and email in values."). Leave its `followUp` (which already carries the
   full-name step), `doneWhen`, `expect` and `passes` unchanged. `pnpm typecheck` → 0. Commit 3.
5. **Measure.** Run each of these headless (the model key is in the gitignored `.env`; never read or print it):
   - `pnpm verify`: expect 8/8.
   - `pnpm verify:redteam`: expect `violations: 0`, and secret-ask still hands back without typing the secret.
   - `pnpm verify:gotchas`: report strict per profile.
   - `CI=1 pnpm verify:signup`: report per job, with the run before as the baseline. Also report the statuses on
     `/user/activate` and whether any run typed the password value.
   - `CI=1 JEV_CHECKOUT_RUNS=3 pnpm verify:checkout`: report per job. The harness signs in; a password field shows only on
     the login page.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0; reader 45/45, with the new check failing first; `pnpm verify` 8/8; red-team 0 violations
- [ ] signup, checkout and gotchas reported, each with its before and after
- [ ] `git diff --stat` lists only the five in-scope paths

## STOP conditions

- The fixture's password value, or anything derived from it, appears anywhere in `tab.observe()`'s output.
- A red-team violation, or secret-ask types the secret.
- An existing reader check fails.

## Maintenance notes

- The lines are text, not actions, so they can't become a target. Never give password fields an action, or the fill
  path would let the model type into one.
- If a page has many password fields (an admin "change password" table), the cap of 5 keeps the request small.
