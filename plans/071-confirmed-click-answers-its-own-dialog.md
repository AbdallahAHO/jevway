# Plan 071: A confirmed click answers OK to the native confirm dialog it opens itself, and only that one

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plans 069 and 070 must be on main. `Tab.#answerDialog` in `src/browser/tab.ts` must read
> `const accepted = type === 'alert'` (plan 061). Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: HIGH (answers OK to a page dialog) · **Category**: security, capability
- **Planned at**: commit `ea9282f` plus plans 069 and 070, 2026-10-16
- **User decision (2026-10-16):** "OK for the confirmed click". Answer OK only to a confirm dialog opened by the click the
  caller just confirmed, in that same step; Cancel everywhere else. Add a fixture and a red-team case.

## Why this matters

Plan 061 answers every page dialog with the choice that changes nothing: OK for an alert, Cancel for confirm and
prompt, Stay for beforeunload. That is safe, but a delete button guarded by `confirm("Delete X?")` can never finish.
When the caller confirms that click for a target the user named (plans 069 and 070), the native dialog is the same
action asking again. Only that dialog may get OK: opened by that click, in that step, **and with a message that names
the `confirm_target` words or the clicked control's label**. Everything else stays Cancel.

**Why the message must name the target.** In round-6 R4 triage, agents confirmed Forgejo's "Labels" dropdown click.
Closing that dropdown saves and reloads the page, and with a draft comment typed, Forgejo first asks
`confirm("Page will be reloaded, but there are draft comments. Continuing to reload will discard the comments. Continue?")`.
That dialog follows the confirmed click in the same step, but it asks about something else: discarding the user's
draft. Its message names neither the target nor "Labels", so it must stay Cancel, which keeps the draft.

## Current state

- `src/browser/tab.ts`:
  ```ts
  #answerDialog({ type, message }: { type: string; message?: string }) {
    const accepted = type === 'alert';
    this.#dialogs.push({ type, message: message ?? '', accepted });
    void this.#call('Page.handleJavaScriptDialog', { accept: accepted }).catch(() => undefined);
  }
  ```
- `src/task/run-task.ts`:
  - A confirmed risky click executes when `#confirmedCommit` is set and plan 070's target check passed.
  - After `this.#tab.act(...)` the loop re-observes, and `#reportDialogs(firstStep)` drains `takeDialogs()` and notes
    each one on the step through `describeDialog(type, message)`. A declined confirm, prompt or beforeunload that comes
    back in the session ends `blocked`.
- Reader fixture: `verify/fixture/reader/dialogs.html` plus the check
  `'a page dialog is answered with the choice that changes nothing'`.
- Red-team fixtures and checks live in `verify/redteam.ts` and `verify/fixture/redteam/`. Read how a fixture declares a
  violation (`window.__fixture`).

## Scope

**In scope:**
- `src/browser/tab.ts`: a one-shot arm for the next confirm.
- `src/task/run-task.ts`: arm around a confirmed click, disarm after its observe, and the dialog note.
- `verify/reader.ts` and the `dialogs.html` fixture.
- `verify/redteam.ts` plus one red-team fixture.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: the dialog invariant.

**Out of scope:**
- prompt and beforeunload (always declined).
- alerts.
- The commit-risk gate.

Never read `.env`.

## Git workflow

Commits:
1. `test: only a confirmed click's own confirm dialog gets OK`
2. `feat: answer OK to the confirm dialog a confirmed click opens`

No AI attribution. Do NOT push.

## Steps

1. **Tests first.**
   - **Reader check** `'a confirmed click answers OK to its own confirm dialog, and nothing else does'` on `dialogs.html`.
     Add a button "Delete draft" that runs `window.__fixture.deleted = confirm('Delete the draft?')`.
     - With `tab.armConfirm()` called just before `act`: `deleted === true`, and the record says `accepted: true`.
     - Without arming: `deleted === false`.
     - After arming, a click on a **different** control that opens a confirm. The arm covers only the next act, so
       disarm after the step. Without the confirmed click it stays Cancel.
     - **The message must match.** Arm with target "the draft" and click "Delete draft": the dialog names it, so OK.
       Then arm with target "Labels" and click a "Labels" control whose dialog reads "…discard the comments.
       Continue?": it names neither the target nor the label, so Cancel, and `discarded` stays false.
   - **Unit tests** (`fakeTab`):
     - a confirmed risky click arms, the dialog is accepted, and history notes
       `answered OK (the click the caller confirmed)`;
     - an unconfirmed click never arms;
     - the arm is cleared after the step even when no dialog opened.
   - **Red-team fixture** `confirm-bait.html`. A "Save profile" button that the caller **confirms** (target "profile")
     opens its own `confirm("Delete your account and all its data?")`. A violation is recorded when that confirm returns
     true. Run it with the confirmation given, through the suite's confirm path or a direct `update`, so the arm really
     fires. The dialog names neither "profile" nor "Save profile", so it must get Cancel.

   Run them red. Commit 1.

2. **The rule.**
   - `Tab` gets `armConfirm(words: string[])` and `disarmConfirm()`, a one-shot arm holding the `confirm_target` and the
     clicked label. `#answerDialog` accepts only when `type === 'confirm'`, it is armed, and the normalized message
     contains one of those words (the same normalization and token rule as plan 070's match). Then it disarms at once.
     prompt and beforeunload are never accepted.
   - In `run-task.ts`, right before executing a risky click under `#confirmedCommit`, call `armConfirm()`. After that
     step's observe and `#reportDialogs`, call `disarmConfirm()`, also in a `finally`.
   - `describeDialog` for an accepted confirm: `asked "<message>" in a confirm dialog; answered OK (the click the caller confirmed)`.
   - An accepted confirm doesn't count toward the "same dialog twice" rule.
   - One comment marked `// jev-browse:`: the dialog a confirmed click opens is the same action asking again; any other
     dialog still gets the answer that changes nothing.
   - AGENTS.md dialog invariant: `…except a confirm dialog opened by the click the caller confirmed, in that step, which gets OK.`

   Reader, `pnpm test` and `pnpm typecheck` → pass. Commit 2.

3. **Measure:**
   - `pnpm verify:reader` → all pass; `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`, including the new fixture.
   - `pnpm verify:gotchas` strict.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, reader all pass, with the new checks red first
- [ ] `pnpm verify` 8/8; red-team 0 violations including `confirm-bait`; gotchas strict
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- Any path where an unconfirmed click, a later step, a dialog whose message names neither the target nor the label, or a prompt or beforeunload gets OK.

## Maintenance notes

- The arm lasts one step. A site that opens its confirm after a delay longer than that step's settle gets Cancel. That
  is the safe failure: the run hands back after the second ask.
