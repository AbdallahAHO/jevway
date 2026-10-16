# Plan 046: The Forgejo jobs pass every name they mention as a value, as the skill tells callers to

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 9166f09..HEAD -- verify/forgejo.ts` must be empty; otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: LOW (suite only) · **Category**: tests
- **Planned at**: commit `9166f09`, 2026-10-16

## Why this matters

jev-browse types only values the caller supplies (`values`); text that appears only in the goal is never typed (an
invariant). `skill/jev-browse/SKILL.md` tells calling agents: text Jev must type, even a filter word, goes in `values`.
The Forgejo write suite (gate R1) breaks that rule in most jobs — e.g. "Close the issue \"Typo in README\"." with no
values. Measured (6–7/33): the model's natural move is to search for the named issue; with nothing to type it ends
`needs_input` naming the search box (e.g. close-issue: click "Issues" → TYPE_TEXT "Search issues…" refused → BLOCKED →
`needs_input` "Search issues…"). That hand-back is the contract working: a careful calling agent would have supplied the
name. The suite must play a careful caller.

## Current state

`verify/forgejo.ts` jobs (excerpt): `comment` ("…on the issue \"Login fails on Safari\"", values `{ comment }`),
`close-issue` ("Close the issue \"Typo in README\"."), `add-label` ("Add the label \"help wanted\" to the issue \"Add dark
mode\"."), `protect-main` ("Protect the main branch so that changes need a pull request."), `delete-repo` ("Delete the
repository ada/scratch."), `delete-label` ("Delete the label \"wontfix\"."), `wiki-off`, `new-issue` (values `{ title }`),
`milestone` (`{ name }`), `description` (`{ description }`), `bad-name` (`{ name }`). Goals refer to values as "the text in
<key>" (see `new-issue`).

## Scope

**In scope**: `verify/forgejo.ts` (goals and `values` of the jobs above). **Out of scope**: `passes`, `expect`, `doneWhen`
meaning, the stack, `src/`. Do not run `verify:langfuse` or touch the Chrome on port 9333.

## Git workflow

Commit: `test: pass forgejo job names as values like a careful caller`. No AI attribution. Do NOT push.

## Steps

1. For every job whose goal names something the model might type (an issue title, a label, a repository, a branch),
   move that name into `values` and refer to it as "the text in <key>", keeping the job's meaning: e.g. `close-issue`:
   "Close the issue titled with the text in issue." `{ issue: 'Typo in README' }`; `comment`: add `{ issue: 'Login fails on
   Safari' }`; `add-label`: `{ label: 'help wanted', issue: 'Add dark mode' }`; `protect-main`: "Protect the branch named
   in branch so that changes need a pull request." `{ branch: 'main' }`; `delete-repo`: `{ repository: 'ada/scratch' }`;
   `delete-label`: `{ label: 'wontfix' }`. Keep `doneWhen` consistent with the new wording (same evidence).
2. `pnpm install`, `pnpm typecheck` → 0. Commit.
3. Measure only when your reviewer messages "forgejo go" (another suite uses the same Forgejo data until then): `CI=1
   JEV_FORGEJO_RUNS=3 pnpm verify:forgejo` (split with `JEV_FORGEJO_ONLY` to stay under 10 minutes a call). Report per job
   (before at `9166f09`: new-issue 0, comment 0, close-issue 0, add-label 0, milestone 0, description 3, protect-main 0,
   wiki-off 0, delete-repo 0 (◐ needs_input), delete-label 0 (◐ needs_input), bad-name 3 of 3 each), and each failure's
   status and reason. Headless; the model key is in the gitignored `.env` — never read or print it. Never run
   `apps:forgejo:down` or recreate the stack.

## Done criteria

- [ ] `pnpm typecheck` exits 0; per-job before/after reported; `git diff --stat` lists only `verify/forgejo.ts`

## STOP conditions

- Any destructive job deletes its target.

## Maintenance notes

- New Forgejo jobs must supply in `values` every name the agent may need to type.
