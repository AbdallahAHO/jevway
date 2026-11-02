# Plan 126: verification codes split into one-character boxes

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Never push, never merge into `main`, never run `npm publish`.
>
> **Drift check (run first)**:
> - `src/browser/snapshot.js` lists each editable text input as a `fill` action plus an `Open …` `click` twin, and
>   computes `guards` for every listed node.
> - `src/browser/tab.ts` `fresh()` compares `[pageKey, guard]` for a `fill`, and `pageKey` holds every input's value.
> - `src/task/run-task.ts` types `const text = decision.valueKey ? await this.#textFor(decision.valueKey, values) : undefined;`
>   and records `value_kept: field.value === this.#scrub(text)`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: LOW (the reader merges boxes it already lists into one target; the loop,
  guards, thresholds, consent rules and statuses are untouched) · **Category**: autonomy
- **Planned at**: commit `da216e4`, 2026-11-02

## Why this matters

Many sign-in and sign-up pages split a one-time code into 4–8 one-character inputs. Today the reader lists every box
as its own textbox; Jev picks one and jevway types the whole code into it, so the field keeps one digit (or the page's
own script spreads it unpredictably), the submit fails, and the agent gets a hand-back it can't fix. This hits an email
code from `values` (e.g. from the inbox tools) and a `totp` code (plan 124) alike.

## Current state

- `snapshot.js` lists each box as `fill` + `Open …` `click`, each with its own guard; nothing knows they belong together.
- `Tab.act(fill)` presses the field, selects all and types every character as key events into that one field.
- `value_kept` compares the observed field's value with the typed text (both scrubbed).

## Scope

**In scope:** `src/browser/snapshot.js` (one additive block: facts about short inputs), new `src/browser/code-boxes.ts`
(pure: the grouping rules, the character split), `src/browser/tab.ts` (group the main frame's actions; type a group box
by box), `src/browser/frames.ts` (group each frame's actions before placing them), `src/task/run-task.ts` (length
mismatch rule, masking a secret's boxes, `value_kept` from the typing), tests under `test/browser/`, `test/task/`,
`verify/reader.ts` + `verify/fixture/reader/split-code*.html`, docs sections.

**Out of scope:** PIN boxes of `type=password` (never listed or typed, as every password field; left out on purpose);
codes split into groups of more than one character (`123-456` as two 3-character fields: those are separate fields
today and stay so); a paste fast path; journeys beyond what `Tab.act` gives them for free.

## Decisions

1. **Where detection lives.** Unit tests have no DOM, so the rules are a pure TS function over facts the reader
   collects. `snapshot.js` adds a `box` fact object to each listed `fill` on an `<input>` that could be a box: a
   `maxlength` of 1–4, or no `maxlength` and at most 64 px wide. The facts: `max` (maxLength, -1 when unset), `mode`
   (inputmode), `otp` (`autocomplete=one-time-code`), `type`, `form` and `within` (identities of the form and of the
   parent and grandparent) and `name` (the group's name: see 4). Every box stays listed by the reader, so `identity()`,
   `guards`, `pageKey` and `marker` cover each one as before.
2. **The rules** (`groupCodeBoxes` in `src/browser/code-boxes.ts`), all must hold:
   - a box holds one character: `maxlength=1`; or no `maxlength`, at most 64 px wide, and `inputmode`
     numeric/decimal/text/tel, `type` tel/number, or `autocomplete=one-time-code`. Any other `maxlength` (a date's
     2/2/4, a phone's 3/3/4) is never a box;
   - 4 to 8 boxes, consecutive among the listed fields (no other field between them), not hover-only;
   - one container (all share the parent, or all share the grandparent: each box wrapped once) and one form (or none);
   - laid out left to right on one row: each box's centre within half a box height of the first's, each further right
     than the one before, widths within 1.5× of each other.
   Password boxes never reach the rules (never listed); a lone `maxlength=1` field is a field.
3. **What Jev sees.** One `fill` target per group: the first box's node (so ids stay stable and the model still selects
   an observed id), `boxes: [node…]`, `rect` the union of the boxes (Box answers and screenshot marks see the whole
   group), `value` the boxes' values joined, `label` `<name> (<N> boxes)`. The first box's `Open …` click twin is
   relabelled the same way; the other boxes and their twins are not listed. Element ids are renumbered after the
   removal. Runs in `Tab.observe` on the main frame and in `Frames` on each frame before placing its actions, so a group
   inside an iframe is one target too.
4. **The group's name**, first that exists: the container's `aria-label`/`aria-labelledby` or a fieldset's legend
   (up to 3 levels up), or a short line (≤ 80 characters, no control in it) right before the boxes; then the words the
   boxes' own labels share once numbers and "of" are dropped ("Digit 1 of 6" → "Digit") unless that is a generic word
   (digit, character, box, number, input, field); else `Verification code`.
5. **Typing.** `Tab.act` on a group splits the text into one character per box (`codeCharacters`: as given; or, if that
   doesn't fit, with spaces and hyphens removed, so `123 456` fits six boxes) and types box by box through `act` itself:
   the first box against the decision's page (the same freshness check as any TYPE_TEXT), every later box against a
   fresh `observe()` (which also waits for the page's auto-advance to settle), so each box gets the freshness check, the
   hit test, the delivered-press check, select-all and real key events. A box already holding its character (the page
   advanced or spread it) is skipped, so nothing is typed twice. At the end code reads the boxes and reports
   `kept` = the joined values equal the characters (unknown when the page already navigated). No paste fast path: key
   events per box work on every widget probed, and a paste the page distributes would need its own verification anyway.
   The group (by its first node and box list) must still be listed at every box, or it is a `StalePage`.
6. **`value_kept`** of a group step is the typing's `kept` when known, else the usual field comparison. A `false` is
   handled by the loop's existing rules.
7. **Length mismatch.** When the value doesn't fit the box count, nothing is typed: fed back once (`not_executed`:
   `the "<key>" value has N characters but this field has M boxes; …`), the second time on the same group `needs_input`
   (`missing` names the group via the existing `missingFields`). A `totp` code is computed first (and so registered
   with the scrubber), then compared.
8. **Secrets.** Before typing a secret key (in `secret_keys`, or a `totp` key) into a group, each box node is noted
   with the key; every later observation the run reads (`#observe`, so requests, summaries, looks and the run folder)
   shows the key's marker as the value of any listed action on those nodes, joined or not (a group the page broke up
   shows one box per action). Page text is not touched beyond the usual value scrub: box values are not page text, and
   a single digit elsewhere on the page stays. The stripped form of a secret (`123 456` typed as `123456`) is registered
   with the scrubber too.
9. **Story and recording.** One step: `Typed the "otp" value into "Verification code (6 boxes)".`; the step shot
   outlines the union rect, so the whole group.
10. **No new parameters**: the MCP tool list is unchanged (token delta 0).

## Git workflow

1. `docs: add plan 126 split code boxes`
2. `test: describe codes split into one-character boxes` (red)
3. `feat: read and type verification codes split into boxes`
4. `docs: describe split code boxes`

## Steps

1. Tests (offline, no key):
   - `test/browser/code-boxes.test.ts`: grouping on action fixtures mirroring the HTML fixtures (positive: 6 and 4
     `maxlength=1` boxes, `inputmode` boxes without `maxlength`, wrapped boxes, a frame's boxes; negative: DD/MM/YYYY
     2/2/4, phone 3/3/4, a lone `maxlength=1`, three boxes, boxes on two rows or in two containers, another field
     between); naming; `codeCharacters`.
   - `test/browser/tab-code-boxes.test.ts` (fake CDP): box-by-box typing, skipping a box the page already filled,
     `kept` true/false, a group that vanished mid-way is stale.
   - `test/task/run-task-code-boxes.test.ts` (fake tab): one step and its story; mismatch fed back once then
     `needs_input`; a secret's boxes masked in the next request and the summary, digits elsewhere untouched; totp.
2. Reader fixtures `verify/fixture/reader/split-code*.html` + checks in `verify/reader.ts` (listed as one target,
   typed, auto-advance, iframe, negatives).
3. Implement.
4. Docs: `docs/reference.md` (Limits / what it reads), `docs/how-it-works.md` (reader + typing), `AGENTS.md` invariant.
5. Live (lock `live-1`): (a) 6 boxes with auto-advance, server-side TOTP check, through the built MCP server with
   `totp`; (b) 6 boxes without auto-advance, a plain `values` code; (c) a 4-box PIN page. Statuses, stories, leak check.

## Done criteria

- [ ] new tests red first, then green; `pnpm release:check` passes; `pnpm verify:reader` passes
- [ ] a split code is one target and is typed one character per box, verified
- [ ] a secret typed across boxes never reaches a request or an output, reassembled or digit by digit
- [ ] tool-list token delta 0
- [ ] live (a)–(c) recorded in the report

## STOP conditions

- The change would alter a guard, a threshold, the consent rule or a status.
- The model's output would become typed text, a selector or a coordinate in any path.
