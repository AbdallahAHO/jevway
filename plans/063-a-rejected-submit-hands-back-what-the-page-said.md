# Plan 063: A submit chosen again after the page rejected it hands back what the page said

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 059 must be on main (`git log --oneline -20 | rg "a category of things is not a target"`). Read the
> `needs_confirmation` branch of `#handBack` in `src/task/run-task.ts` as 059 left it (its reason names the page title). If 059 is not
> merged, STOP and ask your reviewer.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: MED (changes a hand-back's status) · **Category**: bug (gates R1, R2)
- **Planned at**: commit `65202a4` plus plan 059, 2026-10-16

## Why this matters

Two suites keep the same miss, and both are kept strict:
- **R1 bad-name** (Forgejo, 0/3). The goal is "Create a new repository named with the text in name", with an invalid
  name. Forgejo re-renders the form with a red banner: "Repository name should contain only alphanumeric, dash, …".
- **R2 taken-name** (sign-up, 1/3). Forgejo re-renders the registration form with "The username is already taken."

In both, the caller confirmed the submit its request names, and the page **rejected** it. The model then chose the same
submit again: "Create repository" after a scroll, and "Register account" after retyping the same username.
jev-browse's single-use confirmation turns that into `needs_confirmation` with "Clicking "Create repository" looks
irreversible …". A real agent reads that as "confirm again" and loops: the same request, the same rejection. A person reads
the error and goes back to whoever asked.

Diagnosis (2026-10-16, from reports and Forgejo v12 source):
- **No guard fires.**
  - bad-name, all 3 runs: confirmed Create, SCROLL_DOWN, Create again; the runner refused the repeat.
  - taken-name runs 2 and 3: confirmed Register, TYPE_TEXT Username (the same value), Register again.
  - taken-name run 1 passed only because 3 retypes tripped "The last 3 actions did not change the page".
- **The error lives only in the page text.** Forgejo's banner is `div.ui.negative.message.flash-error > p` with no `role`
  and no `aria-live`. The bad field only gets a `field error` class on its wrapper, with no `aria-invalid`. The reader
  keeps a text node only while it is inside the viewport (`snapshot.js`, page text). After bad-name's scroll the banner had left
  `page.text` before the re-click.
- **The operation head never picked BLOCKED.** It stayed at 0.09 for bad-name and 0.33 for taken-name, so the model
  won't stop on its own.

So the signal has to come from what jev-browse already knows: this exact submit ran in this session, the page stayed on
the same form, and new text appeared.

## Current state

- `src/task/run-task.ts`:
  - `#handBack(...)` returns `['needs_confirmation', <reason>]` when
    `isRiskyClick(decision) && !this.#confirmedCommit`.
  - `isRiskyClick` means a CLICK or CLICK_AT with `commitRisk >= 0.5`.
  - After a risky click executes, `#confirmedCommit` is reset (search `if (isRiskyClick(decision)) this.#confirmedCommit = false`).
  - The `BrowserTask` instance lives for the whole MCP session (`src/mcp.ts` keeps `sessions`, and a follow-up call does
    `entry.task.update(…)` then `run()`), so fields on it persist across a confirm → re-call.
- `PageState` carries `url`, `title`, `text` (viewport text) and `actions` (with `label` and `kind`).
- `verify/signup.ts` taken-name: `confirms: REGISTER`, `expect: [...HANDED_BACK]`. Check that `HANDED_BACK` contains `blocked`.
- `verify/forgejo.ts` bad-name: `confirms: /create repository/i`, `expect: ['blocked', 'uncertain', 'needs_input']`.

## Scope

**In scope:**
- `src/task/run-task.ts`: remembering executed risky clicks, and the hand-back branch.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause in the irreversible-click invariant.

**Out of scope:**
- `snapshot.js` (no error-class heuristics).
- The commit-risk gate and thresholds.
- The suites' `expect`.
- `src/mcp.ts` text.

Use the Forgejo stack only when your reviewer says it's free. Never run `apps:forgejo:down`, never touch 9333 or 9444, and never read `.env`.

## Git workflow

Commits:
1. `test: a submit chosen again after the page rejected it is handed back`
2. `fix: hand back a rejected submit with what the page said`

No AI attribution. Do NOT push.

## Steps

1. **Tests first** (scripted `fakeTab`, offline), on a form page listing a field "Repository name" and a button "Create
   repository":
   - **Rejected submit.** The caller confirms. Create executes. The next observe is the same path, still lists the
     "Repository name" field, and has page text with a new line "Repository name should contain only alphanumeric …".
     The model then chooses CLICK "Create repository" (risk 0.8) again. The run ends **`blocked`**, and its reason quotes
     the new text.
   - **Rejected, then scrolled.** As above, but the model scrolls first, so the new line is gone from `page.text`. The
     reason still quotes the text recorded right after the submit.
   - **Wizard.** The page after the submit is the same path, but the field typed before the submit is **no longer
     listed** (step 2 of a wizard), and the model picks a risky "Continue". The run ends `needs_confirmation` as today.
   - **Different path.** After the submit the path changes (`/ada/new-repo`), and later a risky click with the same
     label is chosen. The run ends `needs_confirmation` as today.
   - **Across calls.** The rejection survives a re-call: run 1 ends `needs_confirmation`, `update({ confirmIrreversible: true })`,
     run 2 executes the submit and the model re-picks it, and run 2 ends `blocked` with the text.

   Run them red. Commit 1.

2. **The rule.**
   - **Record.** On `BrowserTask`, keep `#submits`: after a risky click executes, record `{ label, path, fields, textBefore }`.
     - `label` is the bare label without the hover suffix.
     - `path` is the URL path plus search, without the hash.
     - `fields` are the labels of the fields the run typed into in this task before the click.
     - `textBefore` is that page's `text`.
   - **Diff.** On the next observe, add `newText`: the lines of the new `page.text` that weren't in `textBefore`, trimmed
     and joined, at most 300 characters.
   - **Hand back.** In the `needs_confirmation` branch, check whether a recorded submit has the same label, the current
     path equals its path, every one of its `fields` is still listed among `page.actions`, and its `newText` is
     non-empty. If so, return `blocked` with:
     `"<label>" was already submitted on this page, and the page then said: "<newText>". Submitting it again would repeat the same request; tell the user what the page says.`
     Otherwise keep 059's `needs_confirmation` reason.
   - **Comment.** One line: a form that comes back with new text after its submit was rejected, and sending the same
     values again repeats the rejection.

   `pnpm test` and `pnpm typecheck` → pass. AGENTS.md: add to the irreversible-click invariant: `a risky submit chosen
   again on the same form after the page answered it with new text is handed back blocked, quoting that text`. Commit 2.

3. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`; `CI=1 JEV_CHECKOUT_RUNS=2 pnpm verify:checkout` →
     report against 12/12. place-order and change-mind have risky clicks; nothing may change there.
   - When your reviewer says the stack is free:
     - `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=bad-name pnpm verify:forgejo` → against 0/3.
     - `CI=1 JEV_SIGNUP_RUNS=3 pnpm verify:signup` (all five jobs) → taken-name against 1/3, and the others must not drop.
     - `CI=1 JEV_FORGEJO_RUNS=1 pnpm verify:forgejo` (all eleven jobs) → no job that passed at 054 fails with this reason.
   - Report every run where the new `blocked` fired, with its quoted text.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations; checkout reported
- [ ] bad-name ×3, signup ×3 and Forgejo ×1 reported, listing every new `blocked`
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- A job that passed before now ends `blocked` with this reason: report its trail.
- The rule would ever execute a click. It only changes a hand-back's status and reason.

## Maintenance notes

- The quoted text is the page's own text, so it reaches the agent as untrusted page content. Keep it capped and quoted,
  like `page_text`.
- A later reader improvement could keep form-level error text visible after scrolling (`role=alert`, `aria-invalid` where
  sites use them). Forgejo uses neither, which is why this plan doesn't rely on them.
