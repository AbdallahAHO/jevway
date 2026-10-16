# Plan 069: `confirm_irreversible` counts only on the call that answers a `needs_confirmation`

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `rg -n "confirmIrreversible" src/task/run-task.ts src/task/start-task.ts src/mcp.ts` shows `update()` setting
> `this.#confirmedCommit = true` whenever `confirmIrreversible` is truthy. Otherwise STOP.

## Status

- **Priority**: P0 · **Effort**: S · **Risk**: MED (the consent contract) · **Category**: security (gate R4)
- **Planned at**: commit `ea9282f`, 2026-10-16
- **User decision (2026-10-16):** "Only when answering". Honour the flag only on the call right after a
  `needs_confirmation`, or on a new session's first call. Otherwise ignore it and say so in the summary.

## Why this matters

In the round-6 R4 gate (triage #2), the real agent kept passing `confirm_irreversible: true` on two later calls. Those
calls followed `uncertain` hand-backs, not a `needs_confirmation`. Today any call that carries the flag allows the next
risky click, whatever it is, so a stale flag can let through a click the user never named. The user's rule is a
confirmation for the exact action named. A confirmation must answer a question jev-browse actually asked.

## Current state

- `src/task/run-task.ts`, `BrowserTask.update(patch)`:
  ```ts
  update(patch: Partial<TaskOptions> & { confirmIrreversible?: boolean }) {
    const { confirmIrreversible, values, recordDir: _recordDir, ...options } = patch;
    this.#options = { ...this.#options, ...definedOnly(options), values: { ...this.#options.values, ...values } };
    if (confirmIrreversible) this.#confirmedCommit = true;
  }
  ```
  `#confirmedCommit` is reset after a risky click executes (search `if (isRiskyClick(decision)) this.#confirmedCommit = false`).
- `src/task/start-task.ts` `start()` calls `task.update({ confirmIrreversible })` on a new task, so a new session's first
  call can carry it.
- `src/mcp.ts` passes `confirm_irreversible` to `update` (existing session) or `start` (new session).
- `stop()` in `#loop` builds the `TaskSummary`. Its `status` is the call's outcome.
- `verify/jobs/runner.ts` `runCall` calls `task.update({ confirmIrreversible: true })` only right after a
  `needs_confirmation`, so it stays compatible.
- The agent-facing text: the tool description and the `confirm_irreversible` field in `src/mcp.ts`, the
  `needs_confirmation` row in `skill/jev-browse/SKILL.md` and `README.md`.

## Scope

**In scope:**
- `src/task/run-task.ts`: `update`, a last-status field, and a summary note.
- `src/mcp.ts`: tool text and field description.
- `skill/jev-browse/SKILL.md` and `README.md`: one sentence each.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: the irreversible-click invariant.

**Out of scope:**
- `confirm_target` (plan 070) and native dialogs (plan 071).
- The commit-risk gate.

Never read `.env`.

## Git workflow

Commits:
1. `test: a confirmation counts only when it answers a needs_confirmation`
2. `fix: honour confirm_irreversible only on the call that answers one`

No AI attribution. Do NOT push.

## Steps

1. **Tests first.** Use the scripted `scriptedJev`/`fakeTab` pattern; search the existing `confirmIrreversible` tests and copy one.
   - Run 1 ends `needs_confirmation`. Then `update({ confirmIrreversible: true })`, and run 2 clicks the risky target.
     This is today's behaviour and must stay.
   - Run 1 ends `uncertain`. Then `update({ confirmIrreversible: true })`, and run 2 reaches a risky click. Run 2 ends
     `needs_confirmation`, with no click, and its summary carries
     `confirm_ignored: "the previous call ended uncertain, not needs_confirmation"`.
   - A new task started with `confirmIrreversible: true` (first call) clicks the risky target once, as today.
   - After a confirmed click executes, a later call with the flag but after a `done` is ignored.
   - **An unused confirmation survives a `needs_input`.** A new task starts with `confirmIrreversible: true`. Run 1 ends
     `needs_input` (a field without a value) before any risky click. Then `update({ values: {...}, confirmIrreversible: true })`,
     and run 2 clicks the risky target. Round-6 R4 delete-named #1 passed exactly this way, so it must keep working.

   Run them red. Commit 1.

2. **The rule.**
   - Keep `#lastStatus: TaskStatus | undefined` on `BrowserTask`. `stop()` sets it.
   - In `update`, when `confirmIrreversible` is true:
     - if `#lastStatus === undefined` (no call has run yet) or `#lastStatus === 'needs_confirmation'`, set `#confirmedCommit = true`;
     - otherwise set `#confirmIgnored` to the previous status.

     Never clear an existing, unused `#confirmedCommit` here. A confirmation given legitimately (on a first call, or
     answering) stays until a risky click uses it. Only a **newly passed** flag on a call that isn't answering is ignored.
   - The next summary carries
     `confirm_ignored: \`the previous call ended ${status}, not needs_confirmation\`` once, then clears it. Add the
     optional field to `TaskSummary` with a one-line JSDoc.
   - One comment: a confirmation answers the question jev-browse asked, so a flag carried onto a later call allows nothing.
   - **Text.** Tool description: add `It counts only on the call that answers a needs_confirmation (or a new session's
     first call); anywhere else it is ignored.` Use the same sentence in the field description, SKILL.md and README.
   - **AGENTS.md:** add `honoured only on the call right after a needs_confirmation or on a new session's first call` to
     the irreversible-click invariant.

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.

3. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`.
   - When your reviewer says Forgejo is free: `CI=1 JEV_FORGEJO_RUNS=1 JEV_FORGEJO_ONLY=comment,delete-repo,milestone pnpm verify:forgejo`.
     The runner confirms only after a hand-back, so this must not change.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations
- [ ] the Forgejo trio reported; `git diff --stat` lists only in-scope paths

## STOP conditions

- The jobs runner stops confirming named clicks: its confirm comes right after `needs_confirmation`, so if it breaks, report why.

## Maintenance notes

- Plan 070 adds `confirm_target` on the same path. Keep the "answers a question" check first.
