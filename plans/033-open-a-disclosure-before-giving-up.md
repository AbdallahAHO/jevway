# Plan 033: Before handing back "blocked", open the collapsed control the model was already leaning toward

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat d534ab1..HEAD -- src/task/run-task.ts src/jev/decide.ts test/jev-browse.test.ts`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (a new way a BLOCKED decision becomes a click; it goes through the irreversible-click gate like any
  click, with the element judged by name)
- **Depends on**: plan 030 (same file; DONE)
- **Category**: bug
- **Planned at**: commit `d534ab1`, 2026-10-16

## Why this matters

Phone layouts fold controls away behind disclosures ("Show more details", "⋯"). Diagnosed on an emulated iPhone 15:
in Langfuse's trace-to-prompt job the "prompt: … v29" link that desktop shows inline is folded behind
"Show more details". In the last decision before the run ended `blocked`, the click head put **0.57** on
"Show more details", but the operation head chose BLOCKED (0.47 vs CLICK 0.41). trace-to-prompt went 0/3 on phone
(2 of those `blocked` this way); dataset-source showed the same shape behind a "⋯" (2 runs, less certain).

A collapsed control (`aria-expanded="false"`) is, by its own declaration, something that reveals more when opened.
When the model is about to say "nothing can make progress" while its click head already favours such a control,
opening it once and deciding again is what a person does. The click must still face the irreversible-click gate, with
the element judged by name (a missing judgment counts as certain risk, as for box rescues).

## Current state

- `src/task/run-task.ts`, decision handling (after the done checks):
  ```ts
        // Blocked on a page that already meets the completion condition means there is nothing left to do.
        const blockedOnMetGoal = decision.operation === 'BLOCKED' && !decision.fieldsWithoutValue.length && doneProbability >= LAST_LOOK_DONE;
        if (doneWhen && blockedOnMetGoal) { record(false); return stop('done', …, decision); }

        decision = this.#boxRescue(decision, page);
        …rejected DONE… covered retry… then const handBack = this.#handBack(decision); …
  ```
  `#boxRescue` (pattern to mirror) turns a stuck decision into `{ ...decision, via: 'box', operation: 'CLICK', action,
  target, confidence, targetConfidence: undefined, commitRisk }`, with `commitRisk` taking the element's by-name risk
  (`decision.elementRisks?.[target] ?? 1` when `this.#options.elementRisk`). Its `via` field is typed `'box'`; widen the
  type if you add another value.
- `src/jev/decide.ts`: the click head's distribution is `decision.answers.click_target?.probabilities`
  (`Record<targetIndex, number>`), targets are `space.targets.CLICK[index]` (a `PageAction`; `action.expanded` is the
  element's `aria-expanded` as a string, e.g. `'false'`). `elementRiskTargets(input, space, decision)` decides which
  click targets get a by-name risk question (today: the chosen click and the box match).
- Tests: `test/jev-browse.test.ts`. `scriptedJev` answers a choice question with the scripted id at confidence 0.95 and
  puts probability 1 on it (`answer(choice, ids, confidence)`); a Noul question with `script[id] ?? 0`. Look at how
  `click_target` probabilities appear in the answers (`probabilities: Object.fromEntries(ids.map((id) => [id, id ===
  choice ? 1 : 0]))`). `page({ actions })` and `bookingActions` build pages; add an action with `expanded: 'false'`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass (110 before) |
| Live fixtures | `pnpm verify` | `8/8` |
| Gotchas | `pnpm verify:gotchas` | strict 90/90 last time |
| Red-team | `pnpm verify:redteam` | `violations: 0` |

## Scope

**In scope**: `src/task/run-task.ts`, `src/jev/decide.ts` (`elementRiskTargets` only), `test/jev-browse.test.ts`
(`loop gotchas` and the Jev-request tests).

**Out of scope**: thresholds, instruction texts, `snapshot.js`, `tab.ts`. Do not run `verify:langfuse` or touch the Chrome
on port 9333 (your reviewer measures the phone runs after merging).

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: a blocked step whose click head favours a collapsed control`
  2. `feat: open a collapsed control once before handing back blocked`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Tests (red first)

1. `'opens a collapsed control the click head favours instead of handing back blocked'`: a page whose actions include
   `{ id: 'more', kind: 'click', node: 20, role: 'button', label: 'Show more details', expanded: 'false' }` and no fill
   actions; script `[{ operation: 'BLOCKED', click_target: '<that target id>', risk_<id>: 0.02 }, { operation: 'DONE' }]`
   with `elementRisk: true` in the options; pages with distinct fingerprints → `acted` is `[{ label: 'Show more details' }]`
   and the run ends `done`.
2. `'opens it only once per element'`: the same, but the script keeps answering BLOCKED with the same click target →
   it is clicked once, then the run hands back `blocked`.
3. `'does not open a control that is not collapsed'`: the favoured target has no `expanded` attribute → `blocked`, nothing
   clicked.
4. `'a collapsed control judged risky by name asks for confirmation'`: as test 1 with `risk_<id>: 0.9` →
   `needs_confirmation`, nothing clicked.
5. Request shape: with `elementRisk: 'chosen'`, a BLOCKED answer whose top click candidate has `expanded: 'false'` asks
   `risk_<id>` for it.
Find the target id for the added action by building the action space the way existing tests do (`buildActionSpace`).
Run `pnpm test`: tests 1, 2, 4, 5 fail. Commit 1.

### Step 2: The rule

- `decide.ts` `elementRiskTargets`: when the decision is `BLOCKED` and the click head's top candidate (highest
  probability in `answers.click_target.probabilities`) is a target whose action has `expanded === 'false'`, include it.
  Update the function's comment.
- `run-task.ts`: right after `#boxRescue`, if the decision is still `BLOCKED` with no `fieldsWithoutValue`, take the click
  head's top candidate; if its action has `expanded === 'false'`, its probability is at least `this.#options.minConfidence`,
  and its node has not been opened this way earlier in the run (keep a `Set` of nodes on the task), turn the decision
  into a CLICK on it (`via: 'disclosure'`, `confidence` = that probability, `targetConfidence: undefined`,
  `commitRisk` = `this.#options.elementRisk ? (decision.elementRisks?.[id] ?? 1) : (decision.commitRisk ?? 1)`), and add
  the node to the set. It then flows through the normal hand-back checks (the irreversible-click gate applies) and
  execution. One-line comment: a person opens the folded section they were already looking at before giving up.

**Verify**: `pnpm typecheck` → 0; `pnpm test` → all pass. Commit 2.

### Step 3: Measure

`pnpm verify` → 8/8; `pnpm verify:gotchas` → strict per profile (last 30/30 each); `pnpm verify:redteam` →
`violations: 0` (a bait page may have collapsed menus; nothing irreversible may be clicked). Headless Chrome only. The
model key is in the gitignored `.env`, loaded by the npm scripts; never read or print it. Split long suites with
`_ONLY`/`_PROFILES` to stay under 10 minutes per call.

## Test plan

Five unit tests (opens once, not twice, not for non-collapsed controls, risky ones are gated, the risk is asked), red
first; live gotchas, red-team and `pnpm verify` as guards. Phone Langfuse is measured by the reviewer.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; tests 1, 2, 4, 5 shown red before step 2
- [ ] `pnpm verify` 8/8; gotchas strict per profile; red-team 0 violations
- [ ] `git diff --stat d534ab1..HEAD` lists only the three in-scope paths

## STOP conditions

- Any red-team violation, or gotchas strict below 29/30 on any profile.
- The rule seems to need label matching ("Show more", "⋯") rather than `aria-expanded` — report the case instead.

## Maintenance notes

- Only `aria-expanded="false"` qualifies; overflow buttons that don't declare it are not opened by this rule. One open
  per element per run keeps it from toggling.
