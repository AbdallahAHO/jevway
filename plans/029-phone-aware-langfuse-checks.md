# Plan 029: Two Langfuse jobs accept the phone layout's route and evidence

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat f91840e..HEAD -- verify/langfuse.ts`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (verify suite only)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `f91840e`, 2026-10-16

## Why this matters

The Langfuse suite (`pnpm verify:langfuse`, `JEV_LANGFUSE_DEVICE=iphone-15` for the phone layout) scores 16 real jobs
by a page check on the final URL/text **and** the run's status. Measured on an emulated iPhone 15 on 2026-10-16 and
diagnosed from the recordings, two jobs fail for the suite's own reasons, not jev-browse's:
- **prompt-usage** (0/3): the phone Prompts table has only Name / Versions / Actions — no observations-count link — so
  the model took the other real route: prompt page → "Linked Generations" tab → a generation. Each run ended `done` on
  a generation peek showing its user/assistant input and output (done check 0.92), which is exactly the job's
  `doneWhen`. The check only accepts the desktop route `/observations?…promptName…`.
- **failed-experiment** (#2, #3): the model opened the right run's results page (the URL passes the check), but the phone
  results page shows no run name and no error count — only a table of dataset item inputs with the run's SUMMARY and
  SCORES — so `doneWhen` "The results page of the experiment run with one error is open" can never be seen, and the
  done check rejected DONE (0.42/0.28/0.23).

## Current state

`verify/langfuse.ts`:
```ts
  {
    id: 'prompt-usage',
    …
    goal: `Go to Prompts, open the list of observations (generations) that used the langfuse-docs-assistant-chat prompt, and open the most recent one. ${READ_ONLY}`,
    doneWhen: 'A single generation that used the langfuse-docs-assistant-chat prompt is open, showing its input and output.',
    check: 'An /observations page filtered by promptName with one observation open (peek/observation in the URL)',
    passes: (url) => url.pathname.endsWith('/observations') && /promptName/.test(url.search) && /peek=|observation=/.test(url.search),
  },
  …
  {
    id: 'failed-experiment',
    …
    goal: `Go to Experiments. ${READ_ONLY}`,
    firstDoneWhen: 'The Experiments list is showing.',
    doneWhen: 'The results page of the experiment run with one error is open.',
    followUp: (rows) => { … goal: `Open the experiment run that started at the time in run_started. ${READ_ONLY}`, values: { run_started: … } },
    check: 'The URL is an experiment results page (/experiments/results or a dataset run)',
    passes: (url) => /\/experiments\/results|\/runs\//.test(url.pathname),
  },
```
The phone run's final URL for prompt-usage is on the prompt's own page, with the Linked Generations tab and a peek:
read one from `verify/out/langfuse-2026-10-16T09-35-28-310Z/results.json` (`results[].job.id === 'prompt-usage'`,
`runs[].url`) to confirm the exact path and parameters before writing the check (the diagnosis read it as
`/prompts/<name>?tab=linked-generations` with `peek`/`observation`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Check against saved URLs | the node one-liner in step 3 | prints the expected booleans |

## Scope

**In scope**: `verify/langfuse.ts` — the `prompt-usage` job's `check`/`passes` and the `failed-experiment` job's
`doneWhen` only.

**Out of scope**: goals, other jobs, `src/`. Do not run `verify:langfuse` or touch the Chrome on port 9333 (your
reviewer measures it).

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: accept the linked-generations route for prompt-usage`
  2. `test: name what both layouts show in failed-experiment's done evidence`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: prompt-usage accepts both real routes

`passes` becomes: the desktop route as today, **or** the prompt's own page for `langfuse-docs-assistant-chat` with the
Linked Generations tab and one generation open (`peek=` or `observation=` in the query) — match exactly what the saved
phone URLs show. Update `check` to describe both routes in one sentence. Keep it a pure function of the URL.

**Verify**: `pnpm typecheck` → 0. Commit 1.

### Step 2: failed-experiment's done evidence

`doneWhen` becomes exactly: `"An experiment run's results page is open: a table of its dataset item inputs with the run's summary and scores."`
Leave the check as is (it already accepts any results page; it never pinned the run).

**Verify**: `pnpm typecheck` → 0. Commit 2.

### Step 3: Prove the check against saved URLs

With a throwaway script outside the repo (`$TMPDIR`), load `verify/out/langfuse-2026-10-16T09-35-28-310Z/results.json`
(phone) and `verify/out/langfuse-2026-10-16T09-01-46-722Z/results.json` (desktop), import the job list's `passes` for
prompt-usage (copy the function if importing `verify/langfuse.ts` would start the suite — it calls `runJobs` at import;
do **not** import it), and print `passes(new URL(run.url), '')` for every prompt-usage run in both. Expected: all 3
phone runs and all 10 desktop runs true.

## Test plan

The saved-URL check in step 3; your reviewer re-runs the phone and desktop suites after merging.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] Step 3 output: 3/3 phone and 10/10 desktop prompt-usage URLs pass
- [ ] `git diff --stat f91840e..HEAD` lists only `verify/langfuse.ts`

## STOP conditions

- The saved phone URLs don't show a single, recognisable route (report them).
- You are about to change a goal or another job.

## Maintenance notes

- A job's check must accept every real route a person could take on every layout the suite runs; a `doneWhen` must
  name what the final page shows on all of them.
