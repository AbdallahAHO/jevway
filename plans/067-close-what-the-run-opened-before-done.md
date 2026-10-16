# Plan 067: Before finishing, a run closes the menu it opened, then checks done again

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 064 must be on main (`git log --oneline -25 | rg "stronger done evidence right after an unsaved edit"`).
> Both plans change how a run ends `done`. If 064 is not merged, do the offline steps on a branch from main and rebase onto
> 064 before measuring. The four `stop('done', …)` sites in `src/task/run-task.ts` must be the ones listed below, plus whatever 064 added.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (when a run may say done) · **Category**: bug (gate R1)
- **Planned at**: commit `ebe2ab2`, 2026-10-16

## Why this matters

Forgejo job add-label (gate R1) is 0/3. Every run ends `done`, yet Forgejo's API shows no label. The diagnosis on
2026-10-16 ran model-free on the seeded stack, issue #3 "Add dark mode":
- **The trigger state is visible.** The Labels trigger reads `combobox "Labels"`, `expanded=false`, and after the run's
  click `expanded=true`. Escape is offered, because an observed element is expanded.
- **The page already shows the label.** After ticking "help wanted" with the menu still open, the sidebar text reads
  "Labels / … / help wanted / Milestone", and a `link "help wanted"` appears. So the done check ("The issue … shows the
  label …") reads as met.
- **Nothing is saved yet.** The API shows no label, because Forgejo applies the selection only when the menu **closes**.
- **Closing applies it.** The fixed Escape (`dismissPopup`) closes the menu (`expanded=false`). The label is then applied
  (the API lists it), and the closed page still shows it.

Many pickers apply on close or blur: Fomantic multi-selects, Radix popovers, filter menus. A person closes the menu they
opened before they call it done. Any wording of the done check can't see the difference, because the open page and the
closed page show the same text.

## Current state

- `src/task/run-task.ts`:
  - The run ends `done` at four `stop('done', \`Completion condition verified: ${doneWhen}\`, …)` sites:
    1. after a last look (`stopAfterLastLook`);
    2. the steady or evident done path (`DONE_EVIDENT`, `doneSustained`), at about line 289;
    3. operation DONE or BLOCKED-as-done, at about line 305;
    4. an unsure step on a met goal, at about line 373.

    Plan 064 may have added a gate before one of them. Read them all.
  - `#withKeys(page)` adds `press_escape` when an observed action has `expanded === 'true'`. `this.#tab.dismissPopup()` is
    the fixed Escape, used today for a covered target with a history entry `{ operation: 'PRESS_ESCAPE', element: 'closed the open popup covering …', page_changed: true, confidence: 1 }`.
    Copy that pattern.
  - After each executed action the loop re-observes `page`. The clicked action (`decision.action`, with `node` and
    `expanded`) is known at that point.
- Tests: `test/jev-browse.test.ts`, with the `scriptedJev`/`fakeTab` pattern. The fake tab needs `dismissPopup` to flip the
  element's `expanded` and possibly change the page.

## Scope

**In scope:**
- `src/task/run-task.ts`: tracking what the run opened, and a close step before `done`.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause in the `done` invariant.

**Out of scope:**
- `dismissPopup` itself.
- The done-check prompt.
- The toggle guard.
- The snapshot's `expanded` reading.

Use the Forgejo stack, 9333 and live runs only when your reviewer says so. Never read `.env`.

## Git workflow

Commits:
1. `test: a run closes the menu it opened before it finishes`
2. `fix: close a menu the run opened before calling it done`

No AI attribution. Do NOT push.

## Steps

1. **Tests first** (scripted, offline):
   - **Opened, then done.** CLICK a trigger listed `expanded: 'false'`. The next observe lists it `expanded: 'true'`.
     Then CLICK an option, then a decision with a done check of 0.93 (the evident path). The run does **not** end yet:
     - `dismissPopup` is called once;
     - history gains `PRESS_ESCAPE` with `closed the menu this run opened before finishing`;
     - the page is re-observed (the trigger now `expanded: 'false'`);
     - the next decision at 0.93 ends `done`.
   - **Same rule for operation DONE.** The same sequence, with operation DONE at 0.6.
   - **Opened by the page.** A control that was `expanded: 'true'` when the run started, or one the run didn't click,
     isn't closed: `done` at once.
   - **Once per control.** After the close, the model re-opens the same trigger and says DONE: `done` is accepted with
     it open, no second Escape.
   - **Closed again.** The run opened a menu, but a later click closed it. Done is accepted at once.

   Run them red. Commit 1.

2. **The rule.**
   - **Track.** After an executed CLICK whose action was listed `expanded: 'false'`, check the re-observed page. If the same
     node is now listed `expanded: 'true'`, add it to `#openedByRun`, a `Set<number>`.
   - **Close before done.** Wrap every `stop('done', …)` site in one helper. If some node in `#openedByRun` is still listed
     `expanded: 'true'` on the current page, and that node hasn't been closed by this rule before (keep a
     `#closedBeforeDone` set):
     - call `this.#tab.dismissPopup()`;
     - push the history entry;
     - add the node to `#closedBeforeDone`;
     - re-observe;
     - `continue` the loop instead of stopping, so the next decision judges done on the closed page.
   - **Otherwise** stop as today.
   - **Comment.** One line: many pickers apply a choice only when they close, and a person closes the menu they opened before calling it done.
   - **AGENTS.md.** Add to the `done` invariant: `before ending done, a menu the run itself opened and left open is closed
     once with the fixed Escape and done is judged again on the closed page.`

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.

3. **Measure** (live, only when your reviewer says credits are back):
   - `pnpm verify` → 8/8; `pnpm verify:gotchas` strict; `pnpm verify:redteam` → `violations: 0`.
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana`, desktop and phone → 8/8. Grafana's time picker opens a menu; report
     every close-before-done.
   - `CI=1 JEV_CHECKOUT_RUNS=2 pnpm verify:checkout` → report.
   - When Forgejo is free: `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=add-label,new-issue pnpm verify:forgejo` → add-label
     against 0/3.
   - When 9333 is free: `JEV_LANGFUSE_RUNS=1 pnpm verify:langfuse` (desktop, 16 jobs) → no job that passed fails. List
     every close-before-done.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first
- [ ] the live measurements reported once allowed, with every close-before-done listed; add-label against 0/3
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- A job that passed before now fails after a close-before-done (its goal needed the menu open): report it, and don't widen the rule.
- A loop: the same node closed twice. The once-per-control set must prevent it.

## Maintenance notes

- A goal whose evidence is the open menu ("open the date menu") pays one Escape, then the model re-opens it and the
  once-per-control rule accepts done.
