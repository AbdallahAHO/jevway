# Plan 104: The yes/no questions state what true and false mean

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
> This plan changes how Jev's done check and commit-risk questions are worded, so it moves Jev's verified baseline,
> including the commit-risk gate. Kept only with no regression against a same-day baseline; REJECTED with the numbers
> otherwise.
>
> **Drift check (run first)**:
> - `src/jev/decide.ts`: `noul({ goal: input.goal, rules: COMMIT_RISK })`, `noul({ completion_condition: input.doneWhen, rules: DONE_CHECK })`,
>   `riskQuestion` = `noul({ goal, element, rules: ELEMENT_COMMIT_RISK })`, and `noul({ goal: input.goal, rules: NEXT_CLICK_COMMIT_RISK })`.
> - `node_modules/@typesafe-ai/sdk/dist/index.d.mts`: `noul(instructions, criteria?: { true?: EntryType; false?: EntryType })`.
>
> Otherwise STOP.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: MED (the done check and the commit-risk gate read new wording) · **Category**: Jev request (prior-art J4)
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

TypeSafe's Noul takes optional `true`/`false` descriptions that "define the boundary" of a yes/no judgment, and its
guidance is narrow questions with descriptions that match the instruction (fastbrowse `docs/jev.md:14`, `:132-133`, which
carries both on every Noul it asks). Ours carry instructions only (`src/jev/decide.ts:252-257`), so the boundary lives in
one paragraph: "Navigation, searching, … are reversible" is a sentence at the end of COMMIT_RISK, and the done check
never says what a "no" looks like (a condition partly met, or met only in history). The installed SDK (0.7.0) supports
the criteria. Value: med (docs/prior-art.md, J4).

## Current state

`src/jev/instructions.ts`: `COMMIT_RISK`, `DONE_CHECK`, `ELEMENT_COMMIT_RISK`, `NEXT_CLICK_COMMIT_RISK` are instruction
text; `decide.ts` passes them as `rules` inside the instruction object, with no criteria.

## Design decisions

1. The instructions stay word for word; each question gains criteria, kept in `instructions.ts` beside its rules:
   - **DONE_CHECK** — true: "The current page visibly shows the completion condition met right now: its URL, title,
     text or control values show every part of it." false: "Some part of the condition is not visible on the current
     page: it is only partly met, still loading, or shown only in the action history."
   - **COMMIT_RISK** — true: "That click would commit an irreversible real-world effect: paying, purchasing, placing or
     confirming an order or booking, sending a message or email, publishing or posting, deleting data, or submitting an
     application." false: "That click is reversible: navigating, searching, filtering, opening details, adding to a cart,
     or choosing options."
   - **ELEMENT_COMMIT_RISK** (and **NEXT_CLICK_COMMIT_RISK**, which reuses it) — true: "Clicking this element right now
     commits one of those irreversible effects." false: "Clicking it is reversible: it navigates, searches, filters, opens
     details, opens a booking or checkout form, adds to a cart, or chooses an option."
   - Any yes/no question an earlier plan in this round added (103's `page_error`, `sign_in_wall`) gets criteria too.
2. Out: `NEXT_CLICK_PRESENT` and `TARGET_VISIBLE` (geometry checks for Box, not judgments), thresholds (0.3, 0.5 and
   the commit-risk gates are not retuned).
3. Other model profiles (Clef, Perplexity, GPT-6 Luna over OpenRouter) get the same request; they are not measured here.

## Scope

**In scope:** `src/jev/instructions.ts` (criteria constants), `src/jev/decide.ts` (pass them), tests, AGENTS.md if it
quotes the questions.

**Out of scope:** instruction wording, thresholds, any new question.

## Git workflow

`docs: add plan 104 …`, `test: yes/no questions say what yes and no mean`, `feat: give jev's yes/no questions true and false meanings`.
No AI attribution, no push. If REJECTED: `git revert` the test and feat commits.

## Steps

1. Tests (red first): the request's `done_check`, `commit_risk`, every `risk_<n>` follow-up and `next_click_commit_risk`
   carry `criteria.true` and `criteria.false` equal to the constants; instructions unchanged.
2. Implement; `pnpm typecheck`, `pnpm test`.
3. Measure: the slice; Langfuse ×1 if Chrome 9333 is up. Compare the commit-risk scores on the risky steps of the
   baseline traces (checkout Finish, Forgejo deletions, red-team) with the new ones.

## Done criteria

- [ ] tests red first; typecheck and tests green
- [ ] slice at or above the same-day baseline

## STOP conditions

- Any red-team violation.
- Any unconfirmed destructive action in Forgejo (a deletion job's object gone without a confirmation).
- Checkout's Finish clicked unconfirmed (if `verify:checkout` runs).

## Maintenance note

Criteria and instructions must say the same thing; change both together.
