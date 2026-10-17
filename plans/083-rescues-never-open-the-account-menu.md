# Plan 083: The rescues never open the signed-in user's account menu; a page's content doesn't fold there

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `src/task/run-task.ts` must have `#openDisclosure(decision, page)` with
> `const favourite = blocked ? foldedFavourite(decision.answers, clicks) : undefined;` and
> `overflowFolds(decision.answers, clicks)`, and `this.#opened.add(action.node!)` after `record(true)`. Otherwise STOP.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW (narrows a rescue) · **Category**: bug (gate R5 margin)
- **Planned at**: commit `bfe5436`, 2026-10-17

## Why this matters

Langfuse on iPhone 15 (gate R5) misses one session-to-user run per gate round, the same way each time. Round 6 run 2 and
round 7 run 3 both went like this:
1. Sessions, sorted by Total Cost, the costliest session opened. The user who had it is folded behind the "+1" chip
   ("Show 1 more session details") on the phone layout.
2. The model is unsure (0.2–0.3).
3. On the next BLOCKED, the disclosure rescue opens the click head's collapsed favourite, the global **"Account menu"**
   (the signed-in user's avatar), at 0.43–0.48.
4. The next step is "Settings" at 0.31–0.32. The run leaves the session page and never comes back, ending `uncertain`.

Across every Langfuse report (2026-10-17 count), the disclosure rescue opened:

| Target | Times |
|---|---|
| "More actions" | 30 |
| "Show 1 more session details" | 12, the right fold here |
| "Filters 1" | 6 |
| "More options" | 5 |
| "Account menu" | 3 (2 distinct runs; one report is a copy), each followed by Settings and a miss |

The account menu holds the signed-in user's own settings and sign-out, never the page's folded content. A normal click by
the model can still open it ("open my profile settings" needs it). Only the rescues, which open a fold *on the model's
behalf*, should skip it.

In round 7 run 3 the rescue had first tried the "+1" chip, and that click did not execute, with no history note. Step 1
finds out why.

## Current state

`src/task/run-task.ts` `#openDisclosure`:

```ts
const favourite = blocked ? foldedFavourite(decision.answers, clicks) : undefined;
const likely = favourite && favourite.probability >= minConfidence && !this.#opened.has(favourite.action.node!) ? favourite : undefined;
// A person who can't find something opens the "+1" / "More" overflow first, even when it looks unlikely.
const folded = likely ?? overflowFolds(decision.answers, clicks).find((fold) => !this.#opened.has(fold.action.node!));
```

- `foldedFavourite` and `overflowFolds` are in `src/jev/decide.ts`. Read both.
- `#opened` is filled only after a rescue click executes (`if (decision.via === 'disclosure') this.#opened.add(action.node!)`).
- The trace: `verify/out/worktrees/exec-r7-gates-langfuse/langfuse-2026-10-16T21-15-01-484Z/session-to-user/run-3/trace.json`.
  - Entry 7: the "+1" rescue at 0.3, `executed: false`, `targetCheck` visible 0.79, overlap 0.54.
  - Entry 8: "Account menu" via disclosure, executed.
- Round 6's copy: `verify/out/gates-r6/langfuse-r5-iphone-x3/session-to-user/run-2/trace.json`.
- Tests: `test/jev-browse.test.ts`. The block `describe('BLOCKED while the click head favours a collapsed control', …)`
  (about line 1783) is the pattern.

## Scope

**In scope:**
- `src/task/run-task.ts` and/or `src/jev/decide.ts`: the rescue's candidate filter.
- `test/jev-browse.test.ts`.
- `AGENTS.md`: one clause in the loop-guards line.

**Out of scope:**
- Normal clicks on the account menu.
- The rescue's order (favourite first, then overflow).
- The Langfuse suite and its jobs.

Never read `.env`. Use the signed-in Chrome on `http://127.0.0.1:9333` only for this plan's runs, one suite at a time. It
is shared with the reviewer's gate runs later. Never use the Forgejo stack or the Chrome on 9444.

## Git workflow

Commits:
1. `test: the rescues never open the account menu`
2. `fix: keep the account menu out of the fold rescues`

Lowercase conventional commits. **No AI attribution of any kind**: no Co-Authored-By, no "Generated with", no
session links or trailers, no mention of an AI assistant. Do NOT push.

## Steps

1. **Diagnose the dropped "+1" (no code change).** From round 7 run 3's trace and the code, say which branch of the loop
   ran `record(false)` for entry 7 without a history note, and whether that is right. Candidates:
   - a stale refusal (plan 078), which pushes no history;
   - the covered check;
   - an unreachable target;
   - another branch.

   If you can't tell from the trace, replay on 9333 with `JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_ONLY=session-to-user pnpm verify:langfuse`
   and read the new traces. Report what you find. If it is a separate bug (a rescue click silently dropped every time on
   this page), report it before step 2 and wait for your reviewer.
2. **Tests first:**
   - **BLOCKED.** The click head favours a collapsed "Account menu" (0.45), and a collapsed "+1" overflow chip ("Show 1
     more session details") is listed. The rescue opens "+1", not the account menu.
   - **Unsure.** The account menu is never an overflow pick.
   - **Names.** The account-menu test matches "Account menu", "User menu", "Open user navigation menu" and
     "Profile menu". It does not match "Show 1 more session details", "User details", "More actions" or "Filters 1".
   - **Normal clicks.** A normal CLICK on "Account menu" chosen by the model is acted on as before.

   Run them red. Commit 1.
3. **The rule.** One module-level pattern, for example
   `const ACCOUNT_MENU = /\b(account|profile)\s+menu\b|\buser(\s+navigation)?\s+menu\b/i;`, applied to both candidate
   sources in `#openDisclosure` (the favourite and the overflow folds). Put it where the folds are chosen.
   - One comment: the signed-in user's account menu holds their own settings, never the page's folded content, so a
     rescue never opens it; the model still can.
   - AGENTS.md: add "the rescues never open the signed-in user's account menu" to the disclosure clause.

   `pnpm test` and `pnpm typecheck` → pass. Commit 2.
4. **Measure** (9333, one suite at a time):
   - `JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_RUNS=10 JEV_LANGFUSE_ONLY=session-to-user pnpm verify:langfuse`. Report
     the passes, rescue targets and outcomes.
   - `JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_RUNS=1 pnpm verify:langfuse` → no job worse than round 7's 47/48 slice.
   - `CI=1 JEV_GRAFANA_DEVICE=iphone-15 JEV_GRAFANA_RUNS=1 pnpm verify:grafana`.
   - `pnpm verify` → 8/8; `pnpm verify:redteam` → `violations: 0`.

## Done criteria

- [ ] Step 1 reported
- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first
- [ ] session-to-user phone ×10 reported, with 0 account-menu rescues; Langfuse phone ×1 and Grafana phone ×1 reported
- [ ] `pnpm verify` 8/8; red-team 0
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- Step 1 finds a separate bug: report it and wait.
- Any Langfuse phone job that passed in round 7 fails twice in the ×1 slice and its re-run.
