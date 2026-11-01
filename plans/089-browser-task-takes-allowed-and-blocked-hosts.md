# Plan 089: `browser_task` takes allowed and blocked hosts, checked after every step

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - Plan 088 is in: `src/task/run-task.ts` has `const halt = limit.stopped();` at the top of the loop.
> - `src/mcp.ts` `journey_start` keeps `stay_within`; `browser_task` has no host argument.
> - `src/task/start-task.ts` `start()` calls `Tab.open(cdp, url)` with nothing before it but the `url`/`tab` check.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: LOW (a new stop; no new action, nothing changes without the lists) · **Category**: safety
- **Planned at**: commit `39f5928` (on top of plan 088), 2026-11-01

## Why this matters

`docs/prior-art.md` S2. In `auto` mode `browser_task` drives the user's signed-in Chrome, and nothing keeps a run on the
sites the caller meant: journeys have `stay_within` (`src/mcp.ts:170`), `browser_task` has nothing. A link, a redirect or
a form post can take the run to another site (an SSO page, a payment provider, an ad), and the run keeps deciding and
acting there with the user's cookies.

Seen elsewhere: jiawei686 `jev_ultrafast_mcp/safety.py:32-46` (allow/deny lists, but checked only on explicit
navigations, so a click that leaves the domain gets through), wy-coliney `bridge.mjs:42-48`, nexibeo
`background.js:64,72`, MaciejWiatr `browser_tools.py:56-65`, wingman `src/core/policy.ts`. fastbrowse blocks at the
network layer with `Fetch` (later step, out of scope).

## Current state

- `start()` (`src/task/start-task.ts`) opens `url` in a new tab or finds an open `tab`, then builds a `BrowserTask`.
- `#loop` (`src/task/run-task.ts`) observes, then per iteration: stop check (088) → decision → hand-back checks → input →
  observe (and wait for a change) → guards. `page.url` is `location.href` of the top document.
- MCP/CLI pass options through `start()` and `update()`.

## Decisions

1. **Patterns.** An exact host (`en.wikipedia.org`, `127.0.0.1`, `[::1]`) or `*.example.com`, which matches any
   subdomain at any depth (`a.example.com`, `a.b.example.com`) and **not** the apex `example.com` (list both when both are
   meant). Compared on the URL's hostname: lowercase, IDN in punycode, no port, a trailing dot dropped. A scheme, port,
   path, `*` anywhere else or an empty pattern is an error for the call, never silently ignored. An empty list means
   the argument was not given.
2. **Merge (server env, then the call, then later calls).** `JEV_ALLOWED_HOSTS` / `JEV_BLOCKED_HOSTS` (comma or space
   separated) set the server's lists. Each layer can only narrow what is set before it:
   - blocked = every layer's blocked hosts together;
   - allowed = the newest list given, which must lie inside the one before it: each exact host matched by an earlier
     pattern, each `*.x` covered by an earlier `*.y` (x is y or ends in `.y`). A list that would widen it is an error that
     names the pattern ("a call can only narrow them"), not a silent drop.
   - a later call on the same session narrows the session's lists the same way.
   - blocked wins over allowed.
3. **URLs without a host.** `about:blank`, `about:srcdoc` (an empty document, the state every new tab starts in) and
   `chrome-error://` (Chrome's error page for a failed load, showing nothing from any site) always pass. A `blob:` URL
   is judged by the host of its origin. Any other URL without a host (`data:`, `file:`, `chrome:`, `view-source:`) is
   outside when an allowed list is set, and passes when only a blocked list is.
4. **When the run checks.**
   - The start URL, in `start()`, before the tab opens: outside means the call fails (`browser_task failed: Not opened:
     …`), no tab, no session. A `tab` start is read by the first observe and checked before the first decision (reading
     a page changes nothing).
   - `page.url` before every decision (top of the loop, after 088's stop check). This also catches a redirect of the
     start URL and a navigation that lands late.
   - `page.url` right after every executed step (after its observe and change-wait, before any guard, last look or
     automatic Escape), because a click can leave the site; an explicit navigation is not the only way out.
5. **Leaving ends the run `blocked`**, the reason naming the host and the list it broke:
   - before a decision: `Left the allowed hosts: localhost is outside the allowed hosts (127.0.0.1); the run stopped without going back`
   - after a step: `After "Partner offer" the page left the allowed hosts: localhost is outside …; the run stopped without going back`
   - blocked host: `… evil.example is a blocked host (*.example) …`
   The run never navigates back by itself; the caller decides (the session stays usable).
6. **Journeys keep `stay_within`** unchanged.

## Scope

**In scope:** new `src/task/hosts.ts` (patterns, merge, the URL check: pure functions), `src/task/start-task.ts` (env +
start URL), `src/task/run-task.ts` (`hosts` option, `update()`, the two loop checks), `src/mcp.ts`, `src/cli.ts`,
`test/hosts.test.ts`, `test/jev-browse.test.ts`, `verify/run.ts` + fixture pages, `verify/real-world.ts` (reads the env
lists so the Wikipedia run can be measured with them), `AGENTS.md`, `README.md`, `skill/jev-browse/SKILL.md`.

**Out of scope:** network-level blocking (`Fetch`), popup tabs, iframes, journeys.

Never read `.env`.

## Git workflow

1. `docs: add plan 089 allowed and blocked hosts`
2. `test: allowed and blocked hosts end a run that leaves them`
3. `feat: browser_task takes allowed and blocked hosts`
4. `test: a link to another host ends the live run blocked`

Lowercase conventional commits; no AI attribution; do not push.

## Steps

### 1. Tests first

`test/hosts.test.ts`: exact and wildcard matching (apex excluded, depth, case, trailing dot, punycode), invalid patterns,
the merge (env ∪ blocked, narrowing allowed, widening throws), URLs without a host, blocked over allowed.

`test/jev-browse.test.ts`:
- A click that lands on another host ends `blocked` naming it; no decision is made there.
- A start page already outside (a `tab`, a redirect) ends `blocked` before any request.
- A blocked host by wildcard.
- `start()` with an outside `url` throws and never opens a tab; env narrowing: a call can't widen `JEV_ALLOWED_HOSTS`.
- A later call narrows the session's lists; a widening one throws.
- Without lists, other hosts are fine (unchanged behaviour).

### 2. Implement (decisions above). `pnpm typecheck`, `pnpm test`. Docs as listed.

### 3. Measure

- New `pnpm verify` scenario: `offhost.html` on `127.0.0.1` links to `http://localhost:<port>/partner.html` (same
  server, another host) with a "Claim the offer" button. With `allowed: ['127.0.0.1']` and the goal to claim it, the
  run ends `blocked` naming `localhost`; ground truth: the tab is on localhost and `window.__fixture.claimed` is false.
- `JEV_ALLOWED_HOSTS=en.wikipedia.org,*.wikipedia.org JEV_REAL_RUNS=1 JEV_REAL_ONLY=wikipedia pnpm verify:real`: passes as
  without the list.
- With plan 088: `pnpm verify` all, red-team 0, gotchas strict.

## Done criteria

- [ ] tests red first; `pnpm typecheck`, `pnpm test` exit 0
- [ ] the off-host scenario passes from ground truth; Wikipedia unaffected
- [ ] `git diff --stat main` lists only in-scope paths

## STOP conditions

- A run decides or acts on a page outside its hosts (any request whose page URL is outside, any input after leaving).
- A call or later call widens the allowed hosts without an error.

## Maintenance note

The check reads the top document's URL, so an iframe or a popup tab on another host is not covered, and requests the
page makes to other hosts are not blocked. `Fetch`-level blocking (fastbrowse) is the next step if callers need that.
