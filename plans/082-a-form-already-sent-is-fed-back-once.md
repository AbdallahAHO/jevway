# Plan 082: A form already sent is fed back once ("do what's left, or DONE") before the repeat is handed back

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: in `src/task/run-task.ts`, these must exist: plan 063's `#rejectedSubmit(decision, page)`, its
> `blocked` reason `"…" was already submitted on this page, and the page then said: "…"` in `#handBack`, and plan 077's
> `#unpickedMenuValue` note in the loop. Otherwise STOP. Plan 081 adds a note in the same loop region: if your reviewer says
> 081 is merged first, rebase and keep both notes, with 081's before yours.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW–MED (one more decision before a hand-back that exists today) · **Category**: bug (gate R4 quality)
- **Planned at**: commit `d8b4fb5`, 2026-10-17

## Why this matters

In the round-7 R4 gate, the triage chore ("find the issue about Safari, label it bug, and comment …") passed 2/2, but both
runs needed a re-plan for the same reason:
1. The run opens the issue, clicks Labels, types the comment, and hands "Comment" back as `needs_confirmation`.
2. The agent confirms. The comment posts.
3. The next decision is "Comment" **again**:
   - Run 1 matched plan 063's rejected-submit check and ended `blocked` ("already submitted… tell the user what the page
     says").
   - Run 2 had confidence 0.15 on it and ended `uncertain` before 063's check was reached.
4. The label was still undone in both, and the agent opened a new session for it.

063's hand-back is right for a form the page *rejected* (Forgejo's "name taken", "invalid name"): sending the same values
again repeats the rejection. But it fires on the first repeat, even when the form went through and other work is left.
Feeding the match back once (the form was sent, here is what the page said, do what's left or answer DONE) lets the run
go on to the label. The second match still hands back exactly as today.

The check must run **before** the low-confidence hand-back. Run 2's repeat was unsure, and an unsure repeat of a sent
form is the same case.

## Current state

`src/task/run-task.ts`:
- **`#handBack(decision, page)`** checks, in order: DONE, BLOCKED, `#boxStop`, then
  `if (this.#lowConfidence(decision) && !['WAIT', 'PRESS_ESCAPE'].includes(decision.operation)) return ['uncertain', …]`,
  then TYPE_TEXT without a value, then the confirmed-click target check, then:

  ```ts
  if (isRiskyClick(decision) && !this.#confirmedCommit) {
    const rejected = this.#rejectedSubmit(decision, page);
    if (rejected) {
      return [
        'blocked',
        `"${rejected.label}" was already submitted on this page, and the page then said: "${rejected.answer}". Submitting it again would repeat the same request; tell the user what the page says.`,
      ];
    }
    …needs_confirmation…
  }
  ```
- **`#rejectedSubmit`** matches a past risky click with the same bare label, on the same path, with a non-empty
  `answer`, and every field typed before it still listed.
- **Plan 077's note** sits in the loop just before `const handBack = this.#handBack(decision, page);`. Copy its shape:
  `record(false)`, push `{ operation, element: '', not_executed, confidence }`, re-observe, `continue`.
- Tests: `test/jev-browse.test.ts`, `describe('a risky submit chosen again after the page answered it', …)` (about line
  3034), with `formPage`, `submit`, `type`. Its first test expects `blocked` on the first repeat and must change to the new
  two-step behaviour.
- `answer` is page text capped at 300 characters (`SUBMIT_ANSWER_CHARS`). It is untrusted, and quoting it into history is
  what the red-team suite guards.

## Scope

**In scope:**
- `src/task/run-task.ts`: the note and the order of the checks.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: the sentence "A risky submit chosen again on the same form … is handed back `blocked`, quoting that text."

**Out of scope:**
- `#rejectedSubmit`'s matching rules.
- Non-risky clicks.
- The confirmed-click path.
- `skill/`, `src/mcp.ts`. Check that neither quotes the 063 sentence: `rg "already submitted" skill src`.

Never read `.env`. Forgejo only on your reviewer's "forgejo free", holding the lock.

## Git workflow

Commits:
1. `test: a form already sent is fed back once before the repeat is handed back`
2. `fix: feed back a repeated submit once before handing it back`

Lowercase conventional commits. **No AI attribution of any kind**: no Co-Authored-By, no "Generated with", no
session links or trailers, no mention of an AI assistant. Do NOT push.

## Steps

1. **Tests first:**
   - **The note.** Type, submit (risky, confirmed), and the page answers with new text. The model picks the submit
     again. It is not acted on, and history gets
     `not accepted: "Create repository" was already sent on this page, and the page then said: "<answer>". Sending it again repeats the same request; do what is left of the goal, answer DONE if nothing is, or BLOCKED`.
     The run continues.
   - **The repeat.** The model picks it a third time. The run ends `blocked` with today's reason, unchanged, and the
     button was acted on once.
   - **Unsure repeat.** The repeat comes at confidence 0.15 (under `minConfidence`). The first time it is the note, not
     `uncertain`; the second time it is the `blocked` reason, not `uncertain`.
   - **Then the rest.** After the note, a scripted CLICK on another control ("Labels") is acted on.
   - Update the existing first test of that describe to the two-step behaviour.

   Run them red. Commit 1.
2. **The rule.**
   - **The note.** In the loop, after 077's note (and after 081's, if merged): when `isRiskyClick(decision)`,
     `!this.#confirmedCommit`, `this.#rejectedSubmit(decision, page)` matches, and that submit (keyed by label and path)
     isn't in a new `#resubmitNoted` set, add it, push the note, `record(false)`, re-observe, `continue`. Do not look at
     confidence.
   - **The repeat.** In `#handBack`, move the rejected-submit check above the low-confidence check, keeping its
     conditions (`isRiskyClick && !this.#confirmedCommit`) and its reason.
   - One comment: a form the page answered may have gone through with other work left (a comment posted, a label still
     to pick), so the first repeat is a wrong turn; the second is a request to send it again.
   - AGENTS.md: change the sentence to
     `A risky submit chosen again on the same form … after the page answered it with new text is fed back once (do what is left, or DONE), and handed back blocked, quoting that text, the second time.`

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.
3. **Measure:**
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`.
   - When Forgejo is free:
     - `CI=1 JEV_FORGEJO_RUNS=3 JEV_FORGEJO_ONLY=comment,bad-name pnpm verify:forgejo`. bad-name relies on the
       hand-back; it must stay 3/3.
     - `CI=1 JEV_SIGNUP_RUNS=3 JEV_SIGNUP_ONLY=taken-name pnpm verify:signup`. It must stay 3/3.
     - `JEV_AGENT_RUNS=3 JEV_AGENT_ONLY=triage pnpm verify:agent`.

     Report every note, what the run did next, and triage's hand-backs needing a re-plan (round 7: 2 in 2 runs).

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; `pnpm verify` 8/8; red-team 0 violations
- [ ] comment, bad-name, taken-name and triage reported; `git diff --stat` lists only in-scope paths

## STOP conditions

- A comment, issue or repository is ever created twice.
- bad-name or taken-name stops handing back.
- A red-team violation.
