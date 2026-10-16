# Plan 044: Choosing a field it has no value for gets one "pick something else" before a needs_input hand-back

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 042 is merged as `6659a64`; `git diff --stat 6659a64..HEAD -- src/task/run-task.ts` must be
> empty. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (changes when `needs_input` is returned) · **Category**: bug
- **Depends on**: plan 042 (same file)
- **Planned at**: after plan 042, 2026-10-16

## Why this matters

jev-browse types only values the calling agent supplied (`values[key]`); when the model chooses TYPE_TEXT into a field
and no supplied value fits, the run hands back `needs_input` ("No supplied value fits the field …") so the agent can
supply one. In the new Forgejo write suite (gate R1) **23 of 33 runs** ended that way on step 0 or 1, on fields the goal
never needed: "Search issues…", "Search code…", "Search…", "Website" — the model reached for a search box instead of
navigating (e.g. "Close the issue 'Typo in README'" with no `values`). Those are wrong first moves, not missing inputs.
A person who realises they have nothing to type there looks for another way. A genuinely missing value (SauceDemo's
checkout without a postal code) must still hand back `needs_input`.

## Current state

- `src/task/run-task.ts`, `#handBack(decision)`:
  ```ts
      if (decision.operation === 'TYPE_TEXT' && !decision.valueKey) {
        return ['needs_input', `No supplied value fits the field "${decision.action!.label}"`];
      }
  ```
  and a BLOCKED with `fieldsWithoutValue` → `needs_input` ("Blocked: no supplied value for …") — unchanged by this plan.
  The rejected-DONE path shows how the loop feeds a refusal back to the model without executing:
  ```ts
          this.#history.push({ operation: 'DONE', element: '', not_executed: `rejected: "${doneWhen}" is not visible yet; keep working toward it`, confidence: round(decision.confidence) });
          …
          page = await this.#tab.observe();
          continue;
  ```
- Tests: `test/jev-browse.test.ts` has `'hands back needs_input instead of inventing a value'` (TYPE_TEXT with no value →
  `needs_input` at once); it will change meaning and must be updated, not deleted. `scriptedJev` scripts TYPE_TEXT as
  `{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: '<key or NO_SUPPLIED_VALUE>' }`.
- `AGENTS.md`: "TYPE_TEXT types only `values[key]` from the caller. A missing value becomes `needs_input`."

## Scope

**In scope**: `src/task/run-task.ts`, `test/jev-browse.test.ts`, `AGENTS.md` (that invariant sentence).
**Out of scope**: the BLOCKED-with-`fieldsWithoutValue` path, `src/jev/*`, suites. Do not run `verify:langfuse` or touch
the Chrome on port 9333.

## Git workflow

Commit: `fix: let the model pick another step once before asking for a missing value`. No AI attribution. Do NOT push.

## Steps

1. Tests (red first):
   - TYPE_TEXT with no fitting value, then a CLICK → the CLICK executes and the run continues (no `needs_input`); the
     history the second request sees contains a not-executed TYPE_TEXT entry saying no supplied value fits that field.
   - TYPE_TEXT with no value on the same field twice → `needs_input` on the second (reason unchanged).
   - Update `'hands back needs_input instead of inventing a value'` to script the no-value choice twice (rename it to say
     "after one retry").
   - A BLOCKED with `fieldsWithoutValue` still hands back `needs_input` at once.
2. Rule: keep a per-task `Set` of field nodes already refused for lack of a value. On TYPE_TEXT with no `valueKey`: if the
   field's node is not in the set, add it, record the decision as not executed, push a history entry
   `{ operation: 'TYPE_TEXT', element: <label>, not_executed: 'no supplied value fits this field; type nothing here — choose another step, or BLOCKED if the goal needs a value you were not given', confidence }`,
   re-observe and continue; otherwise hand back `needs_input` as today. Do this in the loop (where rejected DONE is handled)
   or by making `#handBack` return a marker the loop handles — keep it readable. One-line comment: a field the model has no
   value for is first a wrong turn, and only the second time a question for the caller.
3. AGENTS.md: "TYPE_TEXT types only `values[key]` from the caller. Choosing a field with no fitting value is fed back once
   (pick another step); the second time it becomes `needs_input`."
4. `pnpm install`, `pnpm typecheck`, `pnpm test` → all pass. Then `pnpm verify` → 8/8; `pnpm verify:gotchas` → strict per
   profile; `pnpm verify:redteam` → `violations: 0` (secret-ask must still end `needs_input` without typing the secret);
   `CI=1 JEV_CHECKOUT_RUNS=3 JEV_CHECKOUT_ONLY=missing-zip pnpm verify:checkout` → still 3/3 hand-backs. The Forgejo stack
   (`http://127.0.0.1:3311`) is running: `CI=1 JEV_FORGEJO_RUNS=3 pnpm verify:forgejo` (split with `JEV_FORGEJO_ONLY` to
   stay under 10 minutes a call) → report per job (before: 7/33, 23 runs ended `needs_input` on a search field). Headless
   only; the model key is in the gitignored `.env` — never read or print it.

## Done criteria

- [ ] typecheck/test exit 0, new tests red first; `pnpm verify` 8/8; gotchas strict reported; red-team 0 violations
- [ ] missing-zip still 3/3; Forgejo per-job before/after reported
- [ ] `git diff --stat` lists only the three in-scope paths

## STOP conditions

- secret-ask types the secret, or any red-team violation; missing-zip stops handing back.

## Maintenance notes

- One retry per field per task keeps the cost to at most one extra decision per distinct field.
