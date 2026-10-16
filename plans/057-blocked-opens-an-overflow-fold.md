# Plan 057: A BLOCKED step opens a collapsed overflow control ("+1", "More actions") once before handing back

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat f35d4ca..HEAD -- src/task/run-task.ts src/jev/decide.ts` must be empty; otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: MED (a new rescue path that clicks) · **Category**: bug (gate R5, phones)
- **Planned at**: commit `f35d4ca`, 2026-10-16

## Why this matters

Langfuse on a phone (gate R5) is 37/48, and the target needs 39. Two jobs fail 3 of 3 the same way, diagnosed live on
2026-10-16:
- **session-to-user**: the user ID sits behind a header chip "+1", listed as
  `button "Show 1 more session details"` with `expanded: 'false'`. Tapping it shows a dialog with the user link.
- **dataset-source**: the source-trace link sits behind `button "More actions"` (`expanded: 'false'`). Opening it lists
  `link "View source observation"`. On the phone it is nowhere else. On desktop the link is in the header.

In both, the model answered **BLOCKED** with the target one disclosure away. The existing rescue `#openDisclosure` opens a
collapsed control only when it is the click head's **top** candidate. Here the overflow chips scored near 0 (the top
candidates were "Open menu" 0.42 and "Account menu" 0.37), so it never fired.

A person who can't find something on a phone opens the "+1" / "More" / "⋯" overflow first. An overflow label is
generic: "Show N more …", "+N", "More", "More actions", "More options", "…", "⋯", "⋮".

## Current state

- `src/task/run-task.ts`:
  ```ts
    // A person opens the folded section they were already looking at before giving up: BLOCKED, yet the click head leans
    // toward a collapsed control. It then faces the same hand-back checks as any click, judged by name when that is on.
    #openDisclosure(decision: Decision, page: PageState): Decision {
      if (decision.operation !== 'BLOCKED' || decision.fieldsWithoutValue.length) return decision;
      const folded = foldedFavourite(decision.answers, buildActionSpace(page.actions).targets.CLICK ?? {});
      if (!folded || folded.probability < this.#options.minConfidence || this.#opened.has(folded.action.node!)) return decision;
      const { elementRisk, pageRisk } = this.#options;
      const byName = decision.elementRisks?.[folded.id] ?? 1;
      const commitRisk = !elementRisk ? (decision.commitRisk ?? 1) : pageRisk ? Math.max(byName, decision.commitRisk ?? 0) : byName;
      return { ...decision, via: 'disclosure' as const, operation: 'CLICK', action: folded.action, target: folded.id, confidence: folded.probability, targetConfidence: undefined, commitRisk };
    }
  ```
  `#opened` (a `Set<number>` of nodes) is filled after a `via: 'disclosure'` click executes, so each control is opened
  at most once per task.
- `src/jev/decide.ts`:
  - `foldedFavourite(answers, clicks)` returns the click head's top candidate if its `expanded === 'false'`.
  - `elementRiskTargets(input, space, decision)` adds that folded candidate to the per-element risk questions when the
    operation is BLOCKED, so it is judged by name in the same request. An unjudged element counts as risk 1 in
    `#openDisclosure`, which would hand back `needs_confirmation`, so a new candidate **must** be judged too.
- Tests: `test/jev-browse.test.ts` has the disclosure tests (search `disclosure`, and the phone fold scripted test near
  "A phone layout folds details away"). Copy their `scriptedJev`/`fakeTab` pattern.

## Scope

**In scope**: `src/jev/decide.ts` (an `overflowFold(clicks)` helper beside `foldedFavourite`, and `elementRiskTargets`),
`src/task/run-task.ts` (`#openDisclosure`), `test/jev-browse.test.ts`, `AGENTS.md` (one clause in the loop-guards line).

**Out of scope**: snapshot labels, thresholds, the commit-risk gate. Do not run `verify:langfuse` until your reviewer says 9333
is free. Never touch the Chrome on 9444.

## Git workflow

Commits: `test: a blocked step opens an overflow control before handing back`, `fix: open a collapsed overflow control once when blocked`.
No AI attribution. Do NOT push.

## Steps

1. **Tests first** (scripted, offline):
   - A BLOCKED decision whose click head favours an uncollapsed "Open menu", on a page that lists `button "Show 1 more
     session details"` with `expanded: 'false'`. The run clicks the overflow control (`via: 'disclosure'`), then a
     scripted CLICK on the revealed link, then DONE.
   - The same with `button "More actions"`.
   - An overflow control already opened once in the task is not opened again: the second BLOCKED hands back `blocked`.
   - A collapsed control whose label is not an overflow (e.g. "Filters", `expanded: 'false'`), with low head
     probability, is **not** opened. The existing top-candidate path is unchanged.
   - The overflow control is judged by name: the request built for that BLOCKED decision includes it in the element-risk
     questions. A high by-name risk hands back `needs_confirmation` and doesn't click.

   Run them red, then commit 1.
2. **The rule.**
   - In `decide.ts`, add `overflowFold(clicks)`: the first collapsed (`expanded === 'false'`) click target whose label
     (trimmed) matches the overflow pattern:
     `/^(\+\d+|show \d+ more\b.*|more( actions| options| items)?|…|⋯|⋮|\.\.\.)$/i`, or an icon name containing
     "ellipsis".
   - When several match, take the one the click head ranks highest, even if near 0.
   - Include it in `elementRiskTargets` when the operation is BLOCKED, next to `foldedFavourite`.
   - In `#openDisclosure`, when there is no `foldedFavourite` (or it fails its checks), fall back to `overflowFold`:
     - skip a node in `#opened`;
     - use the same commit-risk computation;
     - set `confidence` to `this.#options.minConfidence` so the unsure guard treats it as a deliberate try, not a
       confident choice.
   - One comment: a person who can't find something opens the "+1" / "More" overflow first, even when it looks unlikely.
   - `pnpm test` and `pnpm typecheck` → pass. Add one clause to AGENTS.md's loop-guards line. Commit 2.
3. **Measure**, headless unless noted; the model key is in the gitignored `.env`, so never read or print it:
   - `pnpm verify` → 8/8.
   - `pnpm verify:gotchas` → strict per profile.
   - `pnpm verify:redteam` → `violations: 0`. Watch confirm-modal: it must not open anything destructive.
   - `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` → 8/8.
   - `CI=1 JEV_GRAFANA_RUNS=1 JEV_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana` → 8/8.
   - Only when your reviewer says 9333 is free:
     `JEV_LANGFUSE_DEVICE=iphone-15 JEV_LANGFUSE_RUNS=3 JEV_LANGFUSE_ONLY=session-to-user,dataset-source pnpm verify:langfuse`
     → report against 0/3 each. 9333 rules: read-only, don't restart or sign out, close only your own tabs.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0 (new tests red first); `pnpm verify` 8/8; red-team 0 violations
- [ ] gotchas and Grafana desktop and phone reported; the two Langfuse phone jobs reported
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- A red-team violation, or gotchas strict below 29/30 on any profile.
- The overflow click is ever executed without being judged by name (when element risk is on).

## Maintenance notes

- The label pattern is generic but English. If localized sites matter later, add an icon-name route ("ellipsis",
  "more") rather than more words.
