# Plan 075: The agent guidance says start on the page where the change is made, and check other pages in a second call

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 070 must be on main (`git log --oneline -15 | rg "check confirm_target against the page"`), because both
> edit the tool description in `src/mcp.ts` and `skill/jev-browse/SKILL.md`. Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW (agent-facing text) · **Category**: contract (gate R4 quality)
- **Planned at**: commit `913470b`, 2026-10-16

## Why this matters

In the round-6 R4 gate, 11 of 20 hand-backs needed the agent to re-plan. All runs passed, but each re-plan costs a call.
A diagnosis of all 20 hand-backs (2026-10-16) found two causes that text can fix.

1. **The wrong starting page: 3 re-plans, 4 counting a `needs_input` that was one in substance** (milestone ×2 runs).
   - The agent started on the repository page with "create a milestone…".
   - Jev followed the global top-nav "Milestones" link at 0.85, a list with no create control. The run ended `blocked`
     after the global "Create…" menu toggled.
   - One re-plan even dropped the repository URL and landed on the global page again.
   - The agent then used `/ada/app/milestones/new` on its third call, and both runs passed. It knows the pattern but
     didn't use it first.
2. **A `done_when` about another page: 2 re-plans** (settings ×2).
   - "…and the repository navigation has no Wiki tab" can't be judged on the settings page, whose sidebar always
     lists "Wiki".
   - So the run did the work, then wandered (scrolls, Tags, Units) and ended `uncertain` or `needs_input`.
   - The agent's final check in a second call on `/ada/app` took 0 steps.
   - SKILL.md already says "Describe only what the final page itself shows", but without this case.

## Current state

- `skill/jev-browse/SKILL.md`, "## Call it well", items 1 to 7:
  - item 1: "Start with `url` (new background tab) or `tab`…";
  - item 4: `done_when`, "Describe only what the final page itself shows: …".
- The `src/mcp.ts` tool description: "Use it to REACH a page state…", "Pass `done_when`: visible evidence of success…".
- `README.md` has the same guidance in its usage section. Check, and keep it consistent.

## Scope

**In scope:** `skill/jev-browse/SKILL.md`, `src/mcp.ts` (the description text only), `README.md`.

**Out of scope:** any code, and the suites' prompts.

Never read `.env`. The Forgejo stack is shared: use it only on your reviewer's go.

## Git workflow

Commit: `docs: tell callers to start where the change is made and check other pages after`. No AI attribution. Do NOT push.

## Steps

1. **The text.**
   - **SKILL.md item 1:** add `Start on the page where the change is made, with a URL built from the site's own pattern
     (/owner/repo/milestones/new, /owner/repo/settings), not a parent page: Jev follows the links it sees, and a
     same-named global link ("Milestones" in the top bar) can win. After a hand-back on the wrong page, fix url; don't
     re-describe the route in words.`
   - **SKILL.md item 4:** add `Keep it to the page the call ends on. To check another page (the repository's tabs after
     a settings change), end this call at the save and check in a second call.`
   - **Tool description:** add one sentence for each, shorter.
   - **README:** the same two points, if its usage section covers `url` or `done_when`.

   Run `pnpm typecheck` (the description is a template string). Commit.
2. **Measure** when your reviewer says Forgejo is free:
   `JEV_AGENT_RUNS=2 JEV_AGENT_ONLY=milestone,settings,triage pnpm verify:agent`. Report the number of hand-backs needing a
   re-plan, against 11 of 20 at `5961f99`, with milestone 3 and settings 5 then, and the chore pass rate.

## Done criteria

- [ ] `pnpm typecheck` exit 0; the agent run reported with re-plans per chore
- [ ] `git diff --stat` lists only the three in-scope files

## STOP conditions

- Any chore that passed at `5961f99` fails.
