# Plan 121: every hand-back carries a ready-made question for the person

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Never push.
>
> **Drift check (run first)**:
> - `src/task/present.ts` must export `nextFor` and `presentSummary`, with `next` right after `story` in the head.
> - `src/task/run-task.ts` must build `missing` in `missingFields(decision, page)` and `stuck` in `stuckOn(decision)`.
> - `src/jev/decide.ts` must label candidates `` `[${index}] ${label}` ``.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: LOW (a new field on results; the loop, guards and consent rules are untouched) · **Category**: agent contract
- **Planned at**: commit `75fa054`, 2026-11-02

## Why this matters

jevway can't call the calling agent's own ask tool (Claude Code's AskUserQuestion, Codex's `request_user_input`, …),
and the owner turned MCP elicitation off. Today a hand-back says what to do in prose (`next`, `reason`), and each
agent writes its own question for the person, often answering it itself. A result that needs a person should carry the
question ready to pass on, in the shape those ask tools take, so the agent maps it 1:1 and the person gets the same
clear question whatever agent they use.

## Current state

- `TaskSummary` (`src/task/run-task.ts`) carries `missing` (`{ label, role?, path }` per field) on `needs_input`,
  `wall` (`{ kind: 'sign_in' | 'bot_check', origin, name? }`) on a wall `blocked`, and `stuck`
  (`{ operation, element?, candidates }`) on **every** non-done status with a decision. Candidates are
  `[<index>] <label>`, top 5 by probability.
- `missing` holds only `fill` fields (TYPE_TEXT targets): a `<select>` is listed as one `select` action per option
  (`Field → Option`) and Jev picks among them itself, so a select is never a missing field. Radios are `click` actions
  with role `radio` and no group name, so they can't be tied to a field.
- `presentSummary` gets the summary only, no page controls. `next` comes from `nextFor(summary)`.
- The CLI prints `presentSummary` with `next` rewritten by `cliNext` (flags instead of parameters).

## Scope

**In scope:** new `src/task/ask-user.ts`; `src/task/present.ts` (`ask_user` after `next`, `next` wording);
`missingFields` in `src/task/run-task.ts` (an optional `options` per field); the `ask_user` field in the
`jevway_task` output schema (`src/mcp/task-tools.ts`); `src/mcp/instructions.ts` (one line); `cliNext` applied to
`ask_user.then` in `src/cli/run-command.ts`; `skill/jevway/SKILL.md` (one rule); `docs/reference.md` (an `ask_user`
subsection); tests.

**Out of scope:** the wall wait and notification (plan 122), elicitation, journeys, any change to statuses, reasons or
guards.

## Decisions

1. **Shape**, close to the common ask-tool shape:
   ```ts
   interface AskUser {
     question: string;                     // one sentence ending in "?"
     header: string;                       // ≤ 12 characters
     options?: { label: string; description: string }[]; // 2–4, page order (no recommendation on page choices)
     fields?: { key: string; label: string; options?: string[] }[]; // free-text answers, each a `values` key
     then: string;                          // what the agent does with the answer, in parameter names
   }
   ```
   `options` → the tool's options; `fields` → free text (the tool's "Other", or a plain question). The `then` line
   names the session, parameters and keys. One question per round. No `id`: the agent makes one if its tool wants it.
2. **`needs_input`**: when `missing` is non-empty. `question`: `What should I enter for "<label>"?` (one field) or
   `What should I enter for "<a>", "<b>" and "<c>"?`. `header`: the label cut on a word to 12 characters (one field),
   else `Details`. `fields`: `{ key: <slug of the label>, label }` (`Phone number` → `phone_number`; a label with no
   letters or digits → `value_<n>`; duplicates get `_2`). A field whose label looks secret (password, passcode, PIN,
   token, API key, secret, CVC/CVV, card number, one-time code) adds `"secret": true` and `then` says to list its key in
   `secret_keys`. `then`: `Call again with this session and the answers in `values.<key>`, …`.
   Each field carries its page choices as `fields[].options` when the run found some. With one field that has 2–4
   choices, they also become `options` (description `A choice the page lists for "<label>"`); more than 4 stay in
   `fields[].options` only, so the person is not shown a cut list as if it were all of them.
3. **Choices on the page** come from the run, since the summary has no controls: `missingFields` adds
   `options?: string[]` to a missing field when the final page lists a `select` whose label (before ` → `) is the
   field's, or the field is an expanded combobox and the page lists `option` rows: up to 10, each cut to 80 characters,
   distinct, additive (existing `missing` readers are unaffected). The page the run reads is already scrubbed of secret
   values, and password fields are never listed actions, so neither can reach `options`. Radio groups are not tied (no
   group name in the listing). This is the only `run-task.ts` edit, far from the wall code.
4. **`needs_confirmation`**: control from `stuck.element` (the decision's action label), page from `title`, else the
   URL's host and path. `question`: `Click "<control>" on "<page>"?`; header `Confirm`; options `Confirm`
   (`Do it: allows this one click`) and `Don't` (`Stop here; nothing is clicked`), in that order and neither marked
   recommended: consent is the person's. `then`: if confirmed, call again with this session, `confirm_irreversible:
   true` and `confirm_target` set to the person's own words naming the target, never page text; if not, tell the user
   it was not done. Without a control (a coordinate click), the question says "the control boxed on the screenshot".
5. **`uncertain`** with at least 2 distinct candidates (prefix `[N] ` stripped, cut to 40 characters) at probability
   ≥ 0.05: `Which one should I click on "<page>"?` (CLICK), `… choose …` (SELECT), else `Which one did you mean?`;
   header `Which one`; options the top 4 in Jev's order, description `Jev's choice N of M` style is avoided (model
   output); description `Continue with "<label>"`. `then`: call again with this session and the chosen one named in
   `goal`. Gated on the status, not on `stuck`, which every hand-back has.
6. **Walls** (`blocked` with `wall`): `sign_in` → `Sign in to <origin> in the Chrome window jevway uses?` header
   `Sign in`; `bot_check` → `Pass the <name> check in the Chrome window jevway uses?` (`cloudflare` → Cloudflare,
   `recaptcha` → reCAPTCHA, `hcaptcha` → hCaptcha, `turnstile` → Turnstile, `unusual-traffic` → Google's
   unusual-traffic, else `bot`), header `Bot check`. Options `Done` (`I did it; continue`) and `Skip` (`Leave it; stop
   here`). `then`: on Done call again with this session (same goal); on Skip tell the user the step was not done. The
   wording reads the same whether plan 122's wait ran and timed out or never ran.
7. **No `ask_user`** for `done`, `step_budget`, `blocked` without a wall, `uncertain` without two candidates, and
   `needs_input` without `missing` (a missing file names no field yet; plan 125 owns files).
8. **Untrusted page text**: only control labels, the title and the URL go in, always quoted, whitespace collapsed,
   control characters and backticks removed, quotes turned to `'`, cut to 60 characters with `…` (option labels 40).
   Never `page_text`, `reason` or evidence. Secrets: the summary is scrubbed before `presentSummary`, so a label holds
   only `[secret:<key>]`; nothing new reads values.
9. **`next`** points at `ask_user` when present, keeping "call again with this session" so `cliNext` still rewrites it
   (e.g. needs_input: `Put `ask_user` to the user with your ask tool unless their request already answers it, then add
   the answers to `values` and call again with this session.`). The bot-check line keeps "never try to get past it".
10. **Placement and adapters**: `ask_user` right after `next` in concise and full results; the MCP output schema adds
    it as an open object (question, header, then strings); the CLI prints it with `then` rewritten by `cliNext`.

## Deviations from the owned-files list

Agreed with the coordinator before building:
- `src/task/run-task.ts`: `missingFields` adds the optional `options` per field (decision 3).
- `src/cli/run-command.ts`: `cliNext` is applied to `ask_user.then`, so the CLI's `then` names flags (decision 10).

## Steps

1. This plan. Commit.
2. Red tests: `test/task/ask-user.test.ts` (each status from realistic summaries, select options, secret marker,
   hostile long label cut, absent cases), `test/task/present.test.ts` (placement, `next`), `test/mcp` (schema
   validity of a result with `ask_user` over a real client), `test/cli` (the CLI result carries it, `then` in flags).
3. Implement `ask-user.ts`, wire `present.ts`, `missingFields`, schema, CLI.
4. Docs: skill rule, instructions line, reference subsection. Measure the tool-list tokens; raise the ceiling by
   exactly the delta if it trips.
5. `pnpm release:check`.

## Done when

- Every hand-back that needs a person carries `ask_user`; `done`, `step_budget` and plain `blocked` don't.
- An MCP client validates the result against the output schema; the CLI result carries the same field.
- `pnpm release:check` passes.
