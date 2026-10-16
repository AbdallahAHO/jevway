# Plan 045: An agent may confirm only the irreversible action the user named, and jev-browse says so

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 6659a64..HEAD -- src/mcp.ts skill/jev-browse/SKILL.md` must be empty; for
> `src/task/run-task.ts` only plan 044's change may appear (the TYPE_TEXT retry). Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: MED (the agent-facing contract for irreversible clicks) · **Category**:
  security
- **Planned at**: commit `6659a64` (+ plan 044 if merged), 2026-10-16

## Why this matters

jev-browse never clicks something irreversible (delete, pay, send) on its own: it hands back `needs_confirmation`, and
the calling agent may continue with `confirm_irreversible: true` for one click. In the new real-agent suite (gate R4)
Claude Code, asked "Delete the repository …/ada/scratch.", confirmed both of Forgejo's delete clicks itself and deleted
the repo without asking. The user has decided the rule (2026-10-16): **an agent may set `confirm_irreversible` only for
the irreversible action the user's request names, on the target it names** ("delete repository X" → the clicks that
delete X, e.g. Forgejo's danger-zone button and its modal). For anything else — a vaguer request ("tidy up unused
repos"), a different target, or an irreversible step the user did not ask for (paying while reviewing an order) — it
must stop and ask the user. Today the contract is vague: the tool text says "only if the user wants it", and the
`needs_confirmation` reason says only `Clicking "X" looks irreversible (risk N)`.

Also: `confirm_irreversible` passed on a **new** session's first call is silently ignored (`src/mcp.ts` passes it to
`task.update` for continued sessions but not to `runner.start`), so an agent acting on a named action must always make
a second call; honour it on the first call too.

## Current state

- `src/mcp.ts`, `browser_task` description (excerpt):
  `needs_confirmation → the next click looks irreversible, set \`confirm_irreversible: true\` only if the user wants it;`
  and `confirm_irreversible: z.boolean().optional().describe('Allow exactly one click flagged as irreversible.')`. In the
  handler: continued sessions call `entry.task.update({ …, confirmIrreversible: confirm_irreversible })`; new sessions call
  `runner.start({ goal, url, tab, values, doneWhen, maxSteps, allowCoordinateClicks, recordDir })` without it.
  `BrowserTask.update({ confirmIrreversible: true })` sets the one-click allowance.
- `src/task/run-task.ts` `#handBack`: `['needs_confirmation', \`Clicking "${label}" looks irreversible (risk ${risk})\`]`.
- `skill/jev-browse/SKILL.md` line ~34: "`needs_confirmation` | The next click looks irreversible (pay, send, delete,
  submit). Continue with `confirm_irreversible: true` only if the user asked for that action. It covers one click."
- `AGENTS.md` invariants mention the commit-risk gate.
- Tests: `test/jev-browse.test.ts` has needs_confirmation tests asserting the reason text (search `looks irreversible`);
  update any that match the whole string. `src/task/start-task.ts` builds the runner (`runner.start(options)`).

## Scope

**In scope**: `src/mcp.ts`, `src/task/run-task.ts` (the reason string only), `src/task/start-task.ts` (only if needed to
pass the confirmation to a new session), `skill/jev-browse/SKILL.md`, `AGENTS.md`, `test/jev-browse.test.ts`.
**Out of scope**: the commit-risk gate's logic and thresholds. Do not run `verify:langfuse` or touch the Chrome on 9333.

## Git workflow

Commits: `fix: honour confirm_irreversible on a new session's first call`, `docs: say an agent may confirm only the
irreversible action the user named`. No AI attribution. Do NOT push.

## Steps

1. New-session confirmation (test first): a unit test (or an MCP-level test if `test/` has one; otherwise a
   `BrowserTask`/start-task test) showing that a new session started with the confirmation clicks a risky target once
   without handing back. Then pass `confirm_irreversible` into the new session (e.g. `task.update({ confirmIrreversible:
   true })` right after `runner.start`, or a start option). Commit 1.
2. The contract text, everywhere the agent reads it:
   - Tool description line: `needs_confirmation → the next click looks irreversible (delete, pay, send). Set
     \`confirm_irreversible: true\` only when the user's own request names this action and its target (e.g. "delete the
     repository X" → the clicks that delete X); for anything else, stop and ask the user. Each confirmation covers one click.`
   - `confirm_irreversible` field description: `Allow exactly one click flagged as irreversible — only for the action and
     target the user's request names.`
   - Reason string: `Clicking "${label}" looks irreversible (risk N). Confirm only if the user's request named this action
     and target; otherwise ask the user.` (update tests that assert the old full string).
   - SKILL.md row: same rule in the skill's words, with the Forgejo example (two clicks: the danger-zone button, then the
     dialog's button — each needs its own confirmation, both covered by the user's "delete X").
   - AGENTS.md: one sentence in the invariants.
   `pnpm install`, `pnpm typecheck`, `pnpm test` → all pass. Commit 2.
3. `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0` (headless; the model key is in the gitignored `.env` —
   never read or print it).

## Done criteria

- [ ] typecheck/test exit 0 (new-session test red first); `pnpm verify` 8/8; red-team 0 violations
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- The change seems to need edits to the commit-risk gate itself.

## Maintenance notes

- The rule lives in text the agent reads (tool description, reason, skill); the real-agent suite (gate R4) is its test.
