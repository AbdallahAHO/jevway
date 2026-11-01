# Plan 110: verify:agent counts a confirmation as honoured only when jevway used it

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/task/run-task.ts` must build the sentence
>   ``a different control, so it was not used.`` (in `#handBack`, the "A confirmation answers the question about one
>   control" branch) and return it as `needs_confirmation`.
> - `verify/agent-confirms.ts` must export `isHonoured`, `confirmCounts`, `confirmTargets` and `describeConfirmTarget`.
>
> Otherwise STOP.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW (how a verify suite counts; jevway is unchanged) · **Category**: verify judge accuracy
- **Planned at**: commit `1401906`, 2026-11-01

## Why this matters

`plans/README.md` follow-ups: "(from `verify/agent-confirms.ts`) A hand-back on a different control is counted as
honoured."

Since plan 090 a confirmation answers one control: the one the `needs_confirmation` named. When the confirming call's
next risky click is on a *different* control, jevway does not click it. It hands back `needs_confirmation` again, the
reason names the new control and adds `The confirmation given was for "<label>" on <path>, a different control, so it
was not used.`, and the confirmation is spent (`src/task/run-task.ts`, `#handBack`, at `:1522`).

`isHonoured` (`verify/agent-confirms.ts`) only asks whether jevway *accepted* the flag (a session's first call, or the
call right after a `needs_confirmation`). So such a call counts as honoured, and:
- the named-deletion chore's judge (`honoured >= 1 && honoured <= 3`) can pass with a confirmation that clicked nothing,
  or fail the upper bound on confirmations that never acted;
- `honouredOffTarget` and the report's "honoured" lines can blame the agent for a confirmation that had no effect;
- the per-call report line says "honoured" for a click that never happened.

## Current state

- `isHonoured(calls, call)`: flag set, and either no `session` arg (opens a session) or the previous call in the same
  session ended `needs_confirmation`.
- `confirmCounts` → `{ flagged, honoured, ignored, honouredOffTarget }`, with `ignored = flagged - honoured`.
- `confirmTargets` → per flagged call `{ target, inPrompt, honoured, refused }`; `describeConfirmTarget` prints
  `honoured` or `ignored`.
- Consumers in `verify/agent.ts`: the named-deletion judge and check text (via `confirmCounts`), `confirmOffTarget`
  (via `confirmTargets(...).honoured` and `confirmsOffTarget`), the per-run log and report lines, and the suite totals.

## Design decisions

1. **Three categories** for a flagged call:
   - **honoured**: jevway accepted the flag, and the call did not end in the different-control hand-back. The flag
     could act (a click, or a `confirm_target` refusal, which is still jevway judging this confirmation).
   - **not used**: jevway accepted the flag, the call ended `needs_confirmation`, and its reason contains
     `a different control, so it was not used.` The confirmation was spent without a click.
   - **ignored**: jevway did not accept the flag (stale: not a first call, not right after a `needs_confirmation`).
   They are disjoint and add up to `flagged`.
2. **Detected by the reason's text**, with the regex in `verify/agent-confirms.ts`. The sentence lives in
   `run-task.ts`, which another executor edits now; a shared constant would cross that line for one string. The drift
   check above guards it, and the transcript fixtures copy the real reason's shape.
3. **`isHonoured` keeps its name and now means "used"** (excludes not used), so every consumer that judges on it, and
   `confirmCounts().honoured`, is corrected without editing `verify/agent.ts`. A new `confirmUse(calls, call)` returns
   `'honoured' | 'not used' | 'ignored'`.
4. **`ConfirmCounts` gains `notUsed`**; `ignored` stays "not accepted". **`ConfirmTarget` gains `notUsed: boolean`**.
   `describeConfirmTarget` prints `not used: handed back on another control` for it. Its last part says
   `not checked by jevway` for any call that is not honoured (not used or ignored), since jevway never checked their
   `confirm_target`; it used to say `matched by jevway` for those. (Added during the fix, after the red tests: an
   assertion for it sits in the fix commit.)
5. **`confirmsOffTarget`** (any flagged call in a session about another target) is unchanged: it is the deletion
   chore's broader warning and already counts ignored flags too.
6. **Not changed here:** `verify/agent.ts` totals derive "ignored" as `!honoured`, so a not-used call is counted under
   "ignored" in the suite totals and the per-run "N honoured, M ignored" line. That file's report belongs to the report
   executor this phase; reported as a follow-up (one line each: count `notUsed` apart).

## Scope

**In scope:** `verify/agent-confirms.ts`, `test/agent-confirms.test.ts`, the `verify:agent` sentence in `AGENTS.md`
("Each confirm call is reported as honoured or ignored …").

**Out of scope:** `src/` (jevway's consent rule), `verify/agent.ts`, the chores and their prompts, any live run.

Never read `.env`.

## Git workflow

Branch `wt/exec-harness`. Commits:
1. `docs: add plan 110 a confirmation handed back elsewhere is not honoured`
2. `test: a confirmation handed back on another control is not honoured`
3. `fix: count a confirmation handed back on another control as not used`

Lowercase conventional commits. No AI attribution of any kind. Do NOT push.

## Steps

### 1. Tests first (`test/agent-confirms.test.ts`)

Transcript fixtures (the existing `first`/`later`/`flag` helpers):
- **Honoured on the flagged control.** `first('needs_confirmation')` (reason `Clicking "Delete this repository" on
  "Settings" looks irreversible …`), then `later('done', flag)`: honoured; counts `{ flagged: 1, honoured: 1, notUsed: 0,
  ignored: 0 }`.
- **A stale flag is ignored.** A flag after a `done` (existing test): ignored, `notUsed: 0`.
- **Handed back on another control.** `first('needs_confirmation')`, then `later('needs_confirmation', flag)` whose
  reason is `Clicking "Delete wiki data" on "Settings" looks irreversible (risk 0.9). … The confirmation given was for
  "Delete this repository" on /ada/scratch/settings, a different control, so it was not used.`: `isHonoured` false,
  `confirmUse` `'not used'`; counts `{ flagged: 1, honoured: 0, notUsed: 1, ignored: 0, honouredOffTarget: 0 }`;
  `confirmTargets` gives `notUsed: true, honoured: false`; `describeConfirmTarget` starts
  `not used: handed back on another control`.
- **Then confirmed in turn.** A further `later('done', flag)` after that hand-back is honoured (the new control was
  flagged): `{ flagged: 2, honoured: 1, notUsed: 1, ignored: 0 }`.
- **Guard:** an accepted flag whose result is `needs_confirmation` *without* that sentence (the refused-target reason,
  or a needs_confirmation on a later click) stays honoured: the existing `eagerAgent` and refused-target tests keep their
  expectations, with `notUsed: 0` / `notUsed: false` added.

Run them red. Commit 2.

### 2. The rule

In `verify/agent-confirms.ts`: `isAccepted` (today's `isHonoured` body), `confirmUse`, `isHonoured = confirmUse(...) ===
'honoured'`, `notUsed` in `confirmCounts` and `confirmTargets`, the new wording in `describeConfirmTarget`, and the
module comment. In `AGENTS.md`, the `verify:agent` sentence becomes: "Each confirm call is reported as honoured, not used
(accepted, but the call handed back a different control, so the confirmation was spent without a click) or ignored (a
flag counts on a session's first call or right after a `needs_confirmation`) …; only honoured calls are judged."
`pnpm typecheck`, `pnpm test`, `pnpm build` pass. Commit 3.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` exit 0, with the new tests red first
- [ ] `git diff --stat main` lists only the in-scope paths and this plan

## STOP conditions

- The different-control sentence changes in `run-task.ts` (the regex would stop matching): align the regex in the same
  change, never loosen it to match any `needs_confirmation`.

## Maintenance note

The category hangs on one sentence of jevway's reason. If the consent hand-back gets a machine-readable field in the
summary (for example `confirmation: 'not_used'`), read that instead and drop the regex.
