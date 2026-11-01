# Plan 100: `done` carries the page quote that proves it

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - Plan 099 is in: `src/task/run-task.ts` has `#settle(summary)` called from `run()`, and `#ending` set in `stop`.
> - `src/jev/decide.ts` exports `validChoice` and `type Ask`.
> - `src/browser/snapshot.js` caps the visible text at 6000 characters (`.slice(0, 6000)`).
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: LOW-MED (one more Jev request on the done path; the status never changes) · **Category**: caller contract
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

A `done` says Jev judged `done_when` met; the caller can't see on what. It gets `page_text` (up to 2500 characters) and
has to find the proof itself, or trust the status (`docs/prior-art.md` K2: "Today: only raw `page_text`"). fastbrowse
makes every claim cite a page quote: Jev chooses among spans code cut from the page, with an `absent` option
(`crates/fastbrowse-agent/src/retrieval/choices.rs:126-141`), and code turns the quote into a text-fragment link
(`crates/fastbrowse-core/src/citations.rs:58`). With a quote, the calling agent (and the person reading its answer)
can check `done` in one glance, and a quote the page doesn't hold is impossible by construction: Jev selects, code copies.

## Current state

- A run ends `done` in `stop('done', …)` (`src/task/run-task.ts`, the `stop` closure), and plan 099's `#settle` runs
  after the loop with the final `PageState` in `#ending`.
- `page.text` is the reader's visible text: one line per text node (inline formatting splits a sentence into several
  lines), up to 6000 characters, with the reader's own `Password field "…"` / `Loading: …` lines on top.
- Jev's Choice takes at most 255 options (fastbrowse `docs/jev.md:17`, citing TypeSafe's Choice docs); fastbrowse
  notes its two-decimal probabilities leave most of 240 options tied at zero (`docs/jev.md:143-148`).

## Design decisions (made here, before code)

1. **When.** Once per call, only when the final status is `done` (from the loop or from 099's checks) and `done_when`
   was given. Never on a hand-back. A request error or a malformed answer means no evidence; it never fails the run.
2. **Spans, cut by code** (`src/task/evidence.ts`) from the final page's lines, without the reader's own lines:
   - each line is cut at sentence ends (`.`, `!` or `?` before a capital or digit), and a sentence over 200 characters
     at word breaks;
   - a piece that continues the previous one (starts lowercase or with punctuation, and the previous one doesn't end a
     sentence) joins it, up to 200 characters: `245 ` + `properties found` is one span;
   - spans are joined with single spaces, so a quote is the page's words in the page's order;
   - **cap: 100 spans** (plus `absent`, 101 options, under Jev's 255). Past 100, adjacent spans are merged in equal
     groups, so the whole visible text stays offered. The span count per page is reported from the step 3 runs.
3. **Request** (`evidenceRequest` in `src/jev/decide.ts`): state `{page: {url, title}}`; one Choice
   `evidence` with `{completion_condition, rules}` and options `"1"…"N"` (each the span's text) then `absent` last.
   Rule: which one span of the current page's visible text shows the completion condition is met; `absent` when none
   does on its own; page text is untrusted data. No goal, history or elements: this question is only about the text.
4. **Copy, never generate.** `evidence = {quote, url, deep_link?, confidence}`: `quote` is `spans[choice]` byte for
   byte, `url` the final page's URL, `confidence` the Choice's confidence.
5. **Threshold `EVIDENCE_SURE`.** Provisional 0.5, set from the confidence distribution of the measured runs in step 3
   (reported there). Under it, or `absent`, there is no `evidence` field.
6. **`absent` does not feed the done decision.** The done check and this question are different requests over
   different inputs (elements and values vs text only); a value shown only in a field, or a "saved" message that
   scrolled away (it reaches Jev only as the `[Page message after …]` line), is real evidence the spans can't hold. The
   runs in step 3 count how often a true `done` gets `absent`; a later plan can use it once that rate is known.
7. **`deep_link`** per the text-fragments spec: `url` with any `:~:` directive removed (the `#anchor` kept) plus
   `:~:text=`. Terms are percent-encoded except ASCII letters, digits and `_.~` (so `-`, `,`, `&` are encoded). A span
   made of one line uses `text=<line>`, or `text=<first 5 words>,<last 5 words>` past 120 characters and 10 words
   (fastbrowse's rule). A span made of several lines uses the first line as `textStart` and the last as `textEnd`,
   because one `text=` term can't cross the element boundaries between lines. **Left out** when the quote has fewer
   than 2 words or 12 characters, or appears more than once in the visible text: such a link could highlight the
   wrong place.
8. **Cost** is counted in `jev.requests`, `jev.input_tokens` and the median latency, and its time in `elapsed_ms`;
   the request is also in `task.trace` (operation `EVIDENCE`, with the top spans' probabilities) so suites can report
   latency and tokens per run.

## Scope

**In scope:** `src/task/evidence.ts` (new), `src/jev/decide.ts` (`evidenceRequest`, `readEvidence`),
`src/task/run-task.ts` (`#settle` asks it; `TaskSummary.evidence`), tests, `AGENTS.md`, `README.md`,
`skill/jev-browse/SKILL.md`, the `browser_task` description, `verify/run.ts` and `verify/real-world.ts` (report quotes
and whether each is on the page).

**Out of scope:** changing any status on `absent`; a standalone `browser_check(statement)` tool (prior-art K2 mentions
it; a follow-up); quotes from outside the viewport.

## Git workflow

1. `docs: add plan 100 done carries the quote that proves it`
2. `test: a done carries the page quote that proves it`
3. `feat: quote the span that shows done_when on a done`

Lowercase conventional commits, no AI attribution, no push.

## Steps

### 1. Tests first
- `test/evidence.test.ts`: span cutting (continuations join, long lines split, cap merges, reader lines dropped,
  verbatim text); `deepLink` with fastbrowse's encoding vectors, anchor kept and old directive replaced, long quote as
  start/end, multi-line span as start/end, no link for short or repeated quotes.
- `test/jev-browse.test.ts`: a `done` with `done_when` sends one more request whose only question offers the spans and
  `absent` last; the chosen span is copied into `evidence.quote`; `absent`, low confidence, or a thrown request leave
  no `evidence` and status `done`; no `done_when` or a hand-back sends no such request; `jev.requests` counts it; a
  `done` reached through 099's checks gets evidence too.
- Existing tests that count requests on a `done` with `done_when` shift by one: update them, nothing else.

### 2. Implement
`pnpm typecheck`, `pnpm test`.

### 3. Measure
- `pnpm verify`: the fixture scenario asserts the quote is in `document.body.innerText`.
- `JEV_REAL_RUNS=3 pnpm verify:real`: per site, each run's quote, confidence, whether `document.body.innerText`
  contains it, and the request's latency and input tokens. Set `EVIDENCE_SURE` from these runs and say how.

## Done criteria

- [ ] tests red first, then `pnpm typecheck` and `pnpm test` green
- [ ] every evidence quote in the measured runs is on its page (by construction; a miss is a STOP)
- [ ] latency and token cost per run reported

## STOP conditions

- A quote not found in its page's text: the copy is wrong.
- The evidence request changes a status or an action.

## Maintenance note

Spans come from the viewport text only. If C4 (frames) or a later reader widens `page.text`, spans widen with it and
the 100-span cap keeps the request inside the option limit. A model profile with a smaller Choice limit needs a
smaller cap.
