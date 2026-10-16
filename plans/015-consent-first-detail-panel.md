# Plan 015: The consent-first fixture opens a result the way real apps do

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat bbfae1d..HEAD -- verify/fixture/gotchas/consent-first.html verify/gotchas.ts`
> On any output (the files changed since this plan was written), STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (one test fixture; no `src/` change)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `bbfae1d`, 2026-10-16

## Why this matters

The gotcha suite (`pnpm verify:gotchas`) runs the real model on small local pages and passes a run only when the
page's own state shows the goal reached **and** the run ended `done`. The `consent-first` page (a cookie banner over
a search box) is the suite's only remaining strict miss: in the last two measurements it reached the goal in every
run but ended `uncertain` in 4 of 18, always the same way — the model chose DONE three times and the separate done
check scored "A search result for latency is open." at 0.31–0.46, under the 0.5 bar. Even its passing runs scored only
0.50–0.60.

The cause is the fixture, not jev-browse: opening a result appends **one line of text** under the unchanged results
list. Nothing on the page looks "open". Real docs sites show the article on its own (a heading, body text, a way
back). The `late-content` fixture had exactly this gap and was fixed the same way in an earlier plan; its done check
has been reliable since. This plan applies that fix to `consent-first` and measures the done-check score, not only the
pass count.

## Current state

- `verify/fixture/gotchas/consent-first.html` — markup and the click handler that opens a result (excerpt):
  ```html
  <main>
    <h1>Docs</h1>
    <input type="search" id="q" aria-label="Search docs" placeholder="Search docs">
    <button type="button" id="go">Search</button>
    <div id="list"></div>
    <section id="detail" hidden></section>
  </main>
  ```
  ```js
    const link = event.target.closest('#list a');
    if (link) {
      event.preventDefault();
      const { id } = link.dataset;
      later(() => {
        document.getElementById('detail').hidden = false;
        document.getElementById('detail').textContent = `${docs.find(([key]) => key === id)[1]} (${id})`;
        window.__fixture.opened = id;
      });
    }
  ```
  `docs` is an array of `[id, title, text]`. `later(effect)` delays the effect by 300–800 ms under the `churn`
  profile (`?chaos=1`) and runs it at once otherwise. The `if (chaos) { … }` block at the top churns `#list` and
  toggles a banner; leave it untouched.
- The pattern to copy — `verify/fixture/gotchas/late-content.html` (opening a run hides the list and shows a panel):
  ```js
    // Opening a run replaces the list with the run's own panel, as real apps do; "Back to runs" returns to the list.
    ...
    if (event.target.closest('#back')) {
      event.preventDefault();
      later(() => {
        detail.hidden = true;
        table.hidden = false;
        window.__fixture.opened = null;
      });
      return;
    }
    ...
    later(() => {
      table.hidden = true;
      detail.hidden = false;
      detail.innerHTML = `<h2>Run ${id}</h2><dl>…</dl><a href="#" id="back">Back to runs</a>`;
      window.__fixture.opened = id;
    });
  ```
  Its CSS gives the panel structure: `#detail h2 { margin: 0 0 8px; }`.
- `verify/gotchas.ts` scenario (do not change it):
  ```ts
  {
    id: 'consent-first',
    goal: 'Search for the text in query and open the first result.',
    values: { query: 'latency' },
    doneWhen: 'A search result for latency is open.',
    passes: `window.__fixture.opened === 'result-1'`,
  },
  ```
- The suite writes `verify/out/gotchas-<timestamp>/report.json`: an array of runs, each with `scenario`, `profile`,
  `run`, `passed`, `reached`, and `summary` (`status`, `reason`, `done_probability`, `steps`).
- The model key is in the gitignored `.env`, loaded by the npm script. **Never read or print `.env`.**

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| This scenario, 5 runs per profile | `JEV_GOTCHAS_ONLY=consent-first JEV_GOTCHAS_RUNS=5 pnpm verify:gotchas` | 15 run lines, a totals table, a report path |
| Done-check scores from a report | `jq -r '.[] \| "\(.profile)-\(.run) \(.summary.status) \(.summary.done_probability)"' verify/out/gotchas-<timestamp>/report.json` | one line per run |

## Scope

**In scope**: `verify/fixture/gotchas/consent-first.html` only.

**Out of scope**: `verify/gotchas.ts` (the goal, `doneWhen` and `passes` stay exactly as they are), `src/` (any
threshold, including the 0.5 done bar), every other fixture.

## Git workflow

- Commit on the branch your reviewer gave you: `test: open consent-first results on their own panel`. Lowercase
  conventional commit, no AI attribution. Do NOT push.

## Steps

### Step 1: Measure the baseline

Run `JEV_GOTCHAS_ONLY=consent-first JEV_GOTCHAS_RUNS=5 pnpm verify:gotchas` in the foreground (about 2 minutes).
Record per profile: strict passes, and the `done_probability` of every run (jq command above). Compute the median
`done_probability` across the 15 runs.

**Verify**: 15 run lines printed and a report path. Keep the numbers for NOTES.

### Step 2: Give an opened result its own panel

In `consent-first.html`:
1. CSS: add `#detail h2 { margin: 0 0 8px; }` next to the existing `#detail` rule.
2. Opening a result (inside the existing `later(() => { … })`): hide `#list`, show `#detail`, and set
   `detail.innerHTML` to `<h2>${title}</h2><p>${text}</p><a href="#" id="back">Back to results</a>`, where `title` and
   `text` come from the `docs` entry for `id`. Keep `window.__fixture.opened = id`. The search box and button stay.
3. "Back to results": a click on `#back` (check it **before** the result-link check, and `return` after it, as in
   late-content) runs `later(() => { detail.hidden = true; list.hidden = false; window.__fixture.opened = null; })`.
4. Add a one-line comment above the handler, worded like late-content's: opening a result replaces the list with the
   result's own panel, as real apps do; "Back to results" returns to the list.

Do not change the consent banner, the search logic, the `docs` array or the `chaos` block.

**Verify**: `pnpm typecheck` → exit 0. Then open the page in headless Chrome through the suite (step 3); there is no
separate syntax check for fixture HTML.

### Step 3: Measure again

Run the same command as step 1. Record the same numbers.

**Verify**: 15 run lines. Expected: strict passes 15/15 (or close) and a clearly higher median `done_probability`
than step 1.

## Test plan

The fixture is the test. The before/after measurement (steps 1 and 3) is the evidence; there is no unit test to add.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0
- [ ] Step 1 and step 3 numbers reported side by side: strict passes per profile, every run's status and
      `done_probability`, and the median `done_probability`
- [ ] `git diff --stat bbfae1d..HEAD` lists only `verify/fixture/gotchas/consent-first.html`

## STOP conditions

- After step 2, any run's page check fails (`reached` false) — the panel broke the ground truth; report the run.
- After step 2, the median `done_probability` is still ≤ 0.6, or strict misses remain via "Jev chose DONE 3×" —
  report each such run's `done_probability` and reason. Do **not** change `doneWhen`, the goal, or any threshold.
- You are about to edit a file other than `consent-first.html`.

## Maintenance notes

- Fixtures should end where real apps end: a detail that is visibly "open" (heading, body, way back). A one-line
  result under an unchanged list measures the fixture, not the agent.
- Live suites: headless Chrome only (the suite launches its own). Never touch the Chrome on port 9333.
