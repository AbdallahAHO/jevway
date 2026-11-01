# Plan 092: A bot wall found in the page ends the run `blocked`, and `done` never lands on a challenge

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `verify/real-world.ts` must have `const BOT_WALL = /verify(ing)? you are (human|not a bot)|…/i` and read
>   ``document.title}\n${(document.body?.innerText ?? "").slice(0, 600)`` for it.
> - `src/task/run-task.ts` must have `const stopDone = async (reason: string, decision?: Decision)` and every `done`
>   must end through it (`rg -n "stop\('done'" src/task/run-task.ts` lists only the line inside `stopDone`).
> - `src/task/run-task.ts`'s loop must start with `this.#tab.disarmConfirm();` then the `++decisions > maxSteps * 2` check.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: LOW–MED (a new hand-back on pages no task can pass; decoys must not trip it) · **Category**: robustness (public sites, prior-art S5)
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

npm serves Cloudflare's managed challenge to headless Chrome on every run. In the baseline at `ef49de1`
(`verify/out/real-2026-10-18T08-24-16-820Z/npm-{1,2,3}.json`) each run answered WAIT 25 times and ended
`step_budget` after **49.6–50.2 s and 25 Jev requests**, on a page titled "Just a moment..." whose whole text was:

```
www.npmjs.com
Performing security verification
This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.
Ray ID:
a4c627515b445548
Performance and Security by
Cloudflare
Privacy
```

Today only the harness knows a wall (`verify/real-world.ts:106`, `BOT_WALL`). Its first whole-body regex misread
Hacker News comments ("Google Captcha v3", "captchas") as a wall (plans/LOG.md, 2026-10-18); plan 086 narrowed it to the
title and the first 600 characters, but one word ("captcha") near the top of any page still trips it. A calling agent
gets a long `step_budget` (or a confident `done` on the wall) instead of a hand-back that says what stopped it.

Prior art (`docs/prior-art.md` S5): jkudish/jev-browser stops before spending a Jev call on a challenge
(`src/navigate.ts:762-821`), waits 8 s for it to clear itself, and checks the final page again so a run never ends `done`
on one (`:1147-1157`). Its detector (`src/lib.ts:474-524`) is DOM-only: a challenge title, or 3+ body markers that include
a brand phrase, so an article quoting one or two challenge lines is not a wall. wingman
(`src/core/page-scripts.ts:406-460`) only counts a captcha widget that is visible and large (≥ 16000 px², not
`size=invisible`). MaciejWiatr (`server/browser_tools.py:446-451`) looks for recaptcha/hcaptcha/turnstile iframes.

## Current state

- `src/task/run-task.ts` `#loop()`: `page = await this.#tab.observe()`, then per iteration `disarmConfirm()`,
  `++decisions` (budget `maxSteps * 2`), `#decideWithRetry(page)`. Every `done` goes through `stopDone` (line 331),
  which first closes a menu the run opened.
- `PageState` already carries `title` and the viewport's visible `text` (`src/browser/tab.ts:55`).
- `verify/real-world.ts` judges a wall after the run with `BOT_WALL` on title + first 600 chars, reports it `⊘ bot wall`
  and leaves walled runs out of the pass rate.
- `skill/jev-browse/SKILL.md:59` already says: never try to solve or bypass a challenge; hand the click to the user.

## Design decisions

1. **One module, `src/browser/bot-wall.ts`**, pure, no model question:
   `detectBotWall({ title, text }, widgets = [])` → `{ name, evidence } | undefined`.
   - **What it reads:** the title and the first 600 characters of the text, whitespace collapsed and lower-cased
     (Cloudflare splits "Performance and Security by" and "Cloudflare" over two lines). A challenge page puts everything
     at the top; comments and articles that discuss captchas live below it.
   - **A wall is** either
     - a challenge title (`just a moment...`, `attention required! | cloudflare`, `please wait... | cloudflare`) with at
       least one body marker, or
     - 3+ distinct body markers including a brand phrase (`ray id:`, `performance and security by cloudflare`,
       `performance & security by cloudflare`, Google's `our systems have detected unusual traffic from your computer network`),
       or
     - a visible, large challenge widget (see 3) with 2+ body markers.

     Markers are matched longest first, and a marker inside one already counted is not counted again ("unusual
     traffic" inside Google's sentence is one marker).
   - **Not a wall:** a sign-in page (no sign-in words are markers: `verify:signup` must keep running), an article
     quoting "verify you are human" (1 marker, no brand), a thread mentioning captchas ("captcha" alone is not a marker).
2. **No `cf-mitigated` header.** Reading it needs `Network.enable` and response capture in `Tab` (shared with other
   work), and it adds no stopping power: jkudish's own code never lets the header alone stop a run, because a challenge
   that auto-passed still answers with it. DOM signals only.
3. **Naming the wall.** The reason names the check: `Cloudflare`, `reCAPTCHA`, `hCaptcha`, `Turnstile`, or a
   `"unusual traffic" page`. Text can't say which widget a page embeds (it sits in a cross-origin
   iframe), so only once a wall is found the tab is asked for the visible challenge widgets: iframes whose `src` names
   recaptcha / hcaptcha / challenges.cloudflare.com, or `.g-recaptcha` / `.h-captcha` / `.cf-turnstile` boxes, visible,
   ≥ 16000 px² and not `size=invisible` (wingman's rule). A Cloudflare page with a Turnstile box is
   `Cloudflare Turnstile`. That read is one `tab.evaluate`, only on a page already judged a wall; the check on every
   other step costs nothing (it reads the `PageState` already observed).
4. **Where the run checks:**
   - **Before each decision**, at the top of the loop and before `++decisions`: a wall gets up to `wallWaitMs` to
     clear itself (the page observed again every second). Cleared: the loop goes on, and no decision was spent. Still a
     wall: `blocked` with the reason
     `The page is a bot check (<name>; seen: <up to 4 markers>) that did not clear by itself; jev-browse never tries to get past one. A person can pass it in this tab, then continue the session.`
     A wall that clears and comes back in the same call is not waited out again: it ends `blocked` at once.
   - **In `stopDone`**, after the menu close and before `stop('done')`: when the page changed since the decision
     (`tab.fresh`), it is read again, and a final page that is a wall gets the same wait; cleared, the loop decides again; still a wall, `blocked` with that reason. So `done` is never returned on a
     challenge.
5. **The wait, `wallWaitMs`, default 8000.** A `TaskOptions` field (as `changeWaitMs` is), so tests set it to 0. The
   value comes from prior art; our own runs only show that npm's headless challenge never clears (50 s each, 3/3), so
   8 s bounds patience rather than matching a measured clear time. The fixture that clears after 2 s checks the wait
   works.
6. **The harness imports the same module.** `verify/real-world.ts` drops `BOT_WALL` and judges the final page with
   `detectBotWall(await tab.observe())`, independently of the run's status (ground truth stays a separate read). Its
   `⊘ bot wall` reporting stays, now with the wall's name.
7. **Statuses unchanged.** `blocked`, as for any page the run can't act on.

## Scope

**In scope:**
- `src/browser/bot-wall.ts` (new): the detector and the widget read.
- `src/task/run-task.ts`: the two check sites and the `wallWaitMs` option. Kept local; nothing else moves.
- `verify/real-world.ts`: the shared detector.
- `verify/reader.ts` + `verify/fixture/reader/bot-wall-*.html`: live, model-free fixtures (a Cloudflare-like challenge,
  an article quoting "verify you are human", a Hacker News-like thread about captchas, a challenge that clears after
  2 s, a reCAPTCHA-style "unusual traffic" page).
- `test/bot-wall.test.ts` (detector) and `test/jev-browse.test.ts` (the run).
- `AGENTS.md` Invariants, `README.md`, `skill/jev-browse/SKILL.md`, the `browser_task` description.

**Out of scope:**
- Any attempt to pass a challenge (clicking a checkbox, solving, stealth flags, cookies).
- Sign-in walls (prior-art J2).
- The `cf-mitigated` header.
- The `TaskStatus` set.

Never read `.env`.

## Git workflow

Branch `wt/exec-a-walls`. Commits:
1. `docs: add plan 092 a bot wall ends the run blocked`
2. `test: a bot wall ends the run blocked and never done`
3. `feat: end a run blocked on a bot wall instead of spending its steps`

Lowercase conventional commits. **No AI attribution of any kind.** Do NOT push.

## Steps

### 1. Tests first
- `test/bot-wall.test.ts`: the npm page above is a Cloudflare wall; an article quoting "verify you are human" and a
  Hacker News-like thread with "Google Captcha v3" and "captchas" are not; a sign-in page is not; Google's "unusual
  traffic" page is; a "Just a moment..." title alone with no marker is not; widgets name reCAPTCHA, hCaptcha, Turnstile.
- `test/jev-browse.test.ts` (`fakeTab` pages):
  - a run that starts on the wall makes **0** Jev requests and ends `blocked`, its reason naming Cloudflare;
  - a wall that clears (pages: wall, wall, article) is waited out and the run goes on to `done`;
  - a DONE decided while the final page turns into a wall ends `blocked`, never `done`;
  - a decoy page runs as before.
- Run them red.

### 2. The rule
Implement decisions 1–6. `pnpm typecheck` and `pnpm test` pass.

### 3. Live, model-free fixtures
`verify/reader.ts`: the detector on each fixture through a real `observe()`, and a `BrowserTask` with an `ask` that
throws on the wall (ends `blocked` with 0 requests) and on the clearing page (gets past it after ~2 s and reaches the
`ask`).

### 4. Measure
- `pnpm verify` 8/8; `pnpm verify:redteam` 0 violations; `pnpm verify:gotchas` strict.
- `JEV_REAL_RUNS=3 pnpm verify:real`: npm ends `blocked` naming Cloudflare in ~10 s with 0 requests; hacker-news never
  flagged; every other site's pass count against R7's 13/18 at `ef49de1`.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm verify:reader` exit 0, with the new tests red first
- [ ] `pnpm verify` 8/8; red-team 0; gotchas strict
- [ ] npm walled runs end `blocked` with a reason naming the wall, in seconds; hacker-news never flagged
- [ ] `git diff --stat main` lists only in-scope paths

## STOP conditions

- A red-team violation.
- Any decoy, a sign-in page, or a site that passed at baseline flagged as a wall.
- Anything that interacts with a challenge.

## Maintenance note

The markers are Cloudflare's and Google's wording as of 2026-10. A new challenge text that fails to trip the detector
costs only what it cost before (the run spends its steps). If a site's normal page trips it, the evidence list in the
reason says which markers matched; narrow those, don't lower the 3-marker bar.
