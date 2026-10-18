# Plan 086: Public sites become a gate: fix the suite's judging, add Airbnb, and triage every failure

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `verify/real-world.ts` must have:
> - `SCENARIOS` with `wikipedia`, `mdn`, `github`, `hacker-news`, `npm`, `booking`, `google-flights`;
> - the line ``const BOT_WALL = /verify(ing)? you are (human|not a bot)|performing security verification|unusual traffic|captcha|are you a robot/i;``;
> - ``const botWall = BOT_WALL.test(String(await tab.evaluate('document.body?.innerText ?? ""')));``.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: LOW (verification only; no `src/` change) · **Category**: verification (new gate R7)
- **Planned at**: commit `ef49de1`, 2026-10-18

## Why this matters

`pnpm verify:real` runs jobs on live public sites. It has never been a gate, and before today it last ran on 2026-10-15,
before 8 rounds of changes. Your reviewer ran it ×3 on `ef49de1` today
(`verify/out/real-2026-10-18T08-24-16-820Z/`):

| Scenario | Result | What really happened |
|---|---|---|
| wikipedia, mdn, google-flights | 3/3 each | pass |
| hacker-news | 0/3, all marked "bot wall" | **Suite bug.** Each run reached the right comments page and ended `done`. The bot-wall regex matched the comments' own words ("…except Google Captcha v3…", "…bitten brutally by captchas…"). It reads the whole body text. |
| npm | 0/3, bot wall | a real Cloudflare challenge (as on 10-15) |
| github | 1/3 | 2 runs `blocked` ("The last 3 actions did not change the page"). See step 4. |
| booking | 0/3 | 2 runs ended **`done` on `/city/pt/lisbon.html` with no dates**. 1 run `blocked`: a cookie banner covers the calendar (plan 087). |

Booking's two `done`s are the worst kind of miss, because the caller is told it worked.
- **The page:** Booking's new free-text box ("Search in your own words") sent the first Search to the Lisbon city page,
  which says "Lisbon – 6838 hotels and places", and the dates were dropped.
- **The doneWhen:** "Booking.com's search results page for Lisbon is showing, with a count of properties found" never
  mentions the dates, so the done check had nothing to reject.

The suite has to state the dates before this can be called a jev-browse bug.

Airbnb was probed once by hand on `ef49de1` with the same Lisbon goal. It ended `done` in 6 actions on
`/s/Lisbon--Portugal/homes?…&checkin=2026-11-01&checkout=2026-11-03`, the right dates, with no bot wall. It is a fair
scenario.

## Current state

`verify/real-world.ts` (182 lines):
- **`daysFromNow(days)`** formats dates like "Sunday, November 1, 2026".
- **`Scenario`** = `{ name, url, goal, values?, doneWhen, passes(url: URL) }`.
- **The booking scenario's `passes`:**
  `url.pathname.includes('/searchresults') && /lisbon|lisboa/i.test(url.searchParams.get('ss') ?? '')`.
- **The bot-wall check**, after `task.run()`:

  ```ts
  const url = String(await tab.evaluate('location.href'));
  // Challenge pages can sit at the target URL itself (npm serves Cloudflare's at /package/zod).
  const botWall = BOT_WALL.test(String(await tab.evaluate('document.body?.innerText ?? ""')));
  const passed = !botWall && scenario.passes(new URL(url));
  ```
- **On a failure** it saves `<name>-<run>.json` (summary and trace) and `<name>-<run>.jpg`; `report.json` holds the table.

## Scope

**In scope:**
- `verify/real-world.ts`
- `AGENTS.md`: the `pnpm verify:real` line (add Airbnb to the site list; say a bot wall is judged on the title and the top
  of the page)

**Out of scope:**
- `src/`, `skill/`, and the other suites.
- Any change to a scenario's goal wording except Booking's `doneWhen`.

Never sign in, book or submit anything on a live site. Never read `.env`.

## Git workflow

Commits:
1. `test: judge a bot wall by the top of the page, not the whole text`
2. `test: name the dates in the booking check and add an airbnb scenario`

Lowercase conventional commits. **No AI attribution of any kind**: no Co-Authored-By, no "Generated with", no session
links or trailers, no mention of an AI assistant. Do NOT push.

## Steps

### 1. Bot walls

A challenge page says so at the top. Judge the wall on `document.title` plus the first 600 characters of
`document.body.innerText`. Keep the regex, and update the comment.

**Verify, before and after the change, with a small scratch script (outside the repo)** that applies the old and new
predicates to two live pages read in a headless Chrome through `connectChrome('launch-headless')`:
- `https://news.ycombinator.com/item?id=50138531`: old says wall, new says not.
- `https://www.npmjs.com/package/zod`: both say wall. If npm shows no challenge to you, say so, and test with any
  Cloudflare challenge you can reach.

Commit 1.

### 2. Booking states the dates

Change the booking scenario:
- **`doneWhen`:** ``Booking.com's search results for Lisbon are showing for ${daysFromNow(14)} to ${daysFromNow(16)}, with a count of properties found.``
- **`passes`:** keep today's checks, and also require the check-in and check-out dates in the URL.
  - Find Booking's real parameter names by doing the search by hand once in a headless or headed Chrome. Don't let Jev
    do it. Expect `checkin=YYYY-MM-DD&checkout=YYYY-MM-DD`; if the names differ, use what Booking uses and say so.
  - Add a helper `isoDaysFromNow(days)` next to `daysFromNow`. Use the local date, not UTC.

### 3. Airbnb

Add the scenario:

```ts
{
  name: 'airbnb',
  url: 'https://www.airbnb.com/',
  goal: `Search for stays in Lisbon from ${daysFromNow(14)} to ${daysFromNow(16)} and show the search results. Do not sign in, book, or reserve anything.`,
  values: { destination: 'Lisbon' },
  doneWhen: `Airbnb search results for stays in Lisbon are listed for ${daysFromNow(14)} to ${daysFromNow(16)}.`,
  passes: (url) => url.pathname.startsWith('/s/') && /lisbon|lisboa/i.test(url.pathname) &&
    url.searchParams.get('checkin') === isoDaysFromNow(14) && url.searchParams.get('checkout') === isoDaysFromNow(16),
}
```

`pnpm typecheck` passes. Commit 2.

### 4. Diagnose GitHub (no code change)

From `verify/out/real-2026-10-18T08-24-16-820Z/github-1.json`, `github-2.json` and the passing `github-3.json`:
1. **The failing runs saw 4 elements** ("Skip to content", "Search GitHub", "advanced search", "prefixes"). The passing
   run saw 50+.
2. **After typing,** the failing runs chose WAIT at 0.18–0.23 instead of PRESS_ENTER. The field then came back as the
   button "Open Search GitHub", and three clicks on it changed nothing.

Find out, with the reader on the live page (scratch script, `tab.observe()` after load and after typing):
- whether `github.com/search?type=repositories` now opens a search overlay or dialog on load, in some loads;
- whether PRESS_ENTER was offered at decision 1 of the failing runs (the request's operations);
- why the field closed (focus lost after the WAIT?).

Report it as **site-changed**, **jev-browse** or **flaky A/B layout**, with the evidence. Fix nothing.

### 5. Measure and triage

```
JEV_REAL_RUNS=5 pnpm verify:real
```

All 8 scenarios: 40 runs, about 25 minutes. Then for **every** run that did not pass, read its trace and jpg and give:
- the scenario, run, status and reason;
- one triage label:
  - **bot wall:** the suite reports it, and it doesn't count;
  - **site-changed:** the job as written is no longer possible on the live site;
  - **suite:** a judging error;
  - **jev-browse:** the run could have succeeded and didn't;
- for `jev-browse` failures, the decision where it went wrong.

For Booking specifically, report each run's last URL and whether it ended `done`. The question is whether, with the
dates in `doneWhen`, jev-browse still says `done` on the city page.

## Done criteria

- [ ] step 1's before/after output shown (HN not a wall with the new check; a real challenge still is)
- [ ] `pnpm typecheck` and `pnpm test` exit 0
- [ ] step 4 reported with a label and evidence
- [ ] the ×5 table, plus a triage line for every failed run
- [ ] `git diff --stat main` lists only `verify/real-world.ts` and `AGENTS.md`

## STOP conditions

- Any run signs in, books, or submits a form on a live site: stop the suite and report the trace.
- Booking or Airbnb serves a bot wall on 3 or more of 5 runs: report it. Your reviewer decides whether it stays in the
  gate.

## Maintenance note

Live sites change under the suite (Booking's search box changed between 10-15 and 10-18). Your reviewer's gate rule:
- **site-changed:** a scenario failing this way is suspended from the gate until its job is rewritten, and the
  suspension is recorded in the index;
- **bot wall:** never counts;
- **everything else:** counts.

Keep scenario judging on the URL, the only ground truth a live site gives.
