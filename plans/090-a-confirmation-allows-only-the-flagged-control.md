# Plan 090: A confirmation allows only the control that was flagged

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/task/run-task.ts` must have `#confirmedCommit = false;` and `if (isRiskyClick(decision) && this.#confirmedCommit) {`
>   in `#handBack`, and `if (status === 'needs_confirmation') this.#spendConfirmation();` in `stop`.
> - `verify/jobs/runner.ts` must have `const CONFIRMATION_LABEL = /^Clicking "(.*?)"(?: on ".*?")? looks irreversible/;`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: LOW (tightens consent; no new action, no change to Jev's request) · **Category**: safety
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

`docs/prior-art.md` S3: wingman binds a single-use confirmation token to the URL, an element fingerprint and the verb
(`README.md:214`, `src/core/tokens.ts`). Ours is a boolean.

- `#confirmedCommit` is set by `update()` (`src/task/run-task.ts:245-253`) and allows **whichever** risky click the next
  call picks (`#handBack`, `:1091`). The `confirm_target` words must be on the page (`#targetRefusal`, `:1049`), but the
  control is not pinned.
- So an agent that confirms `Clicking "Delete this label"` can, on the confirming call, have Jev pick a different risky
  control on the same page (another row's "Delete", "Delete all", a "Transfer ownership" next to it) as long as the
  page still shows the target words. Those words are often on the page for every row (a repository name in the title).
- The agent agreed to one control. A different one is a new question for the agent, and it should be asked.

## Current state

- `update()`: a flag on the call after `needs_confirmation`, or on a new session's first call, sets
  `#confirmedCommit = true` and `#confirmTarget`. Elsewhere it is ignored (`confirm_ignored`).
- `stop()`: a `needs_confirmation` spends any pending confirmation (`#spendConfirmation`).
- `#handBack`: a risky click (`isRiskyClick`: CLICK or CLICK_AT with commit risk ≥ 0.5) with a confirmation runs only if
  `#targetRefusal` passes; without one it is handed back with the reason
  `Clicking "<label>"[ on "<title>"] looks irreversible (risk r). Confirm only if …`.
- After an executed risky click, `#spendConfirmation()` (`:610`).
- The confirm-dialog arm (`:520`) is set only for a risky click that passed `#handBack`.
- Identity used elsewhere: the toggle and resubmit guards key a control by `pathOf(url)` (pathname + search) and
  `bareLabel(label)` (`toggleKey`, `#rejectedSubmit`).

## Design decisions

1. **What is pinned.** At every `needs_confirmation` hand-back, `stop()` stores the flagged control as
   `{ path: pathname, label: bareLabel(action.label), coordinate }` from the decision and page it stopped on. A
   confirmation given on the next call carries that pin.
2. **URL strictness: the pathname only** (no query string, no hash). SPAs rewrite query strings for view state (filters,
   pagination, a peek panel, a timestamp) between calls without changing the control; the pathname names the object a
   form acts on (`/ada/scratch/settings`, `/checkout-step-two.html`). An app that keeps the object in the query string
   (`?id=…`) still has two guards: the label (which carries the row's context, e.g. a row's whole text) and
   `confirm_target`, which the page must show. Stricter matching would hand back confirmed clicks on SPAs for nothing.
3. **Label: the full `bareLabel`**, not the first segment: a row button's label carries its row, so another row's
   "Delete" doesn't match.
4. **A coordinate click** (`CLICK_AT`, opt-in) has no reliable label. It pins `{ path, coordinate: true }` and matches
   only another `CLICK_AT` on that pathname. A listed click never matches a coordinate pin, and vice versa.
5. **A different risky control on the confirming call** is handed back as `needs_confirmation` with today's reason for
   the **new** control (so it still starts `Clicking "<new label>"`, which `verify/jobs/runner.ts:74` and agents parse),
   plus one sentence: `The confirmation given was for "<old label>", a different control, so it was not used.` That
   stop spends the old confirmation and pins the new control, so the agent can confirm it in turn if the user's request
   names it.
6. **The pin is checked before `confirm_target`**: a mismatched control is a new question whatever the words say.
7. **Kept as is:**
   - The call-after-`needs_confirmation` rule and `confirm_ignored`.
   - **A new session's first call** has no flagged control, so its confirmation allows any one risky click whose
     target the page shows, as today. Said so in the docs. A first-call confirmation that survives a `needs_input` keeps
     that behaviour (no pin).
   - `confirm_target` matching, the native confirm-dialog acceptance, one click per confirmation.
8. **When the pin is cleared:** set at each `needs_confirmation`, cleared at any other stop and when a confirmed click
   runs. A confirmation given after a non-`needs_confirmation` call is ignored anyway, so a stale pin can't apply.

## Scope

**In scope:** `src/task/run-task.ts` (consent region: `update`, `stop`, `#handBack`, `#spendConfirmation`, the reason),
`test/jev-browse.test.ts`, `AGENTS.md` consent invariant, `README.md`, `skill/jev-browse/SKILL.md`, the
`confirm_irreversible` description in `src/mcp.ts`.

**Out of scope:** `confirm_target` matching rules, the dialog arm, Jev's request, the risk thresholds, journeys.

Never read `.env`.

## Git workflow

Branch `wt/exec-a-consent`. Commits:
1. `docs: add plan 090 a confirmation allows only the flagged control`
2. `test: a confirmation allows only the control that was flagged`
3. `fix: pin a confirmation to the control that was flagged`

Lowercase conventional commits. No AI attribution of any kind. Do NOT push.

## Steps

### 1. Tests first (`describe('a confirmation counts only when it answers a needs_confirmation')` or a sibling)

- **Same control runs.** Flagged "Confirm booking and pay €412", confirmed, the next call picks it: it is clicked.
- **A different risky control is handed back.** A page with two risky buttons; the first call flags A, the confirming
  call's Jev picks B: `needs_confirmation`, the reason starts `Clicking "B"`, contains
  `The confirmation given was for "A", a different control, so it was not used.`, nothing is clicked. A second
  confirmation then clicks B (and only B).
- **The old confirmation is spent.** After that hand-back, a run with no new flag clicks nothing risky.
- **Same label on another pathname is a different control.** Flagged on `/ada/scratch/settings`, picked on
  `/ada/app/settings`: handed back.
- **A changed query string is the same control.** Flagged on `/stays?tab=1`, picked on `/stays?tab=2`: clicked.
- **First call unchanged.** A new session's first-call confirmation clicks the risky target (existing tests).

Run them red. Commit.

### 2. The rule

- `#flagged: { path: string; label: string; coordinate: boolean } | undefined` and `#confirmedControl` (same type).
- `stop()`: on `needs_confirmation`, after spending, `#flagged = controlOf(decision, page)`; any other status clears it.
- `update()`: when the flag is honoured, `#confirmedControl = #flagged` (undefined on a first call).
- `#spendConfirmation()` also clears `#confirmedControl`.
- `#handBack`: in the confirmed branch, if `#confirmedControl` is set and `controlOf(decision, page)` differs, return
  `needs_confirmation` with the new control's reason plus the sentence from design decision 5.
- Pure helper `controlOf(decision, page)` and `sameControl(a, b)` next to `toggleKey`.

Update AGENTS.md's consent invariant, `README.md`, `SKILL.md` and the tool description: "it allows only the click it
answered (same control: label and page path); a different one is asked again; a new session's first call has none
flagged and allows one".

`pnpm typecheck` and `pnpm test` pass. Commit.

### 3. Measure (after plan 091, with it)

- `pnpm verify` 8/8; `pnpm verify:redteam` 0 violations.
- `JEV_CHECKOUT_RUNS=3 pnpm verify:checkout`: place-order ends `needs_confirmation`, Finish never clicked unconfirmed.
- `forgejo` lock: `JEV_FORGEJO_RUNS=3 pnpm verify:forgejo` (destructive jobs end `needs_confirmation`, nothing destroyed);
  `verify:agent` narrowed to `delete-named,look-not-delete,tidy-vague`, `JEV_AGENT_RUNS=1` (a confirmed deletion still
  completes; report any pin hand-back).

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; new tests were red first
- [ ] `pnpm verify` 8/8; red-team 0; checkout place-order `needs_confirmation` 3/3
- [ ] forgejo destructive jobs nothing destroyed; agent `delete-named` deletes after confirmation
- [ ] `git diff --stat main` lists only in-scope paths

## STOP conditions

- A red-team violation, or anything destroyed without a confirmation in a suite.
- A confirmed deletion in `verify:agent` that no longer completes because of the pin (report the labels and paths).

## Maintenance note

The pin is label + pathname. If a real app renames the flagged control between calls (a count in the label, "Delete 3
items" → "Delete 2 items"), the click is asked again: safe, but it costs the agent a round trip. Widen only with
measured cases.
