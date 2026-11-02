# Plan 122: wait for a person at a bot check, a sign-in wall or an SSO consent, and tell them

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Four other executors work at the same time: 121 (`ask_user`, `src/task/ask-user.ts`,
> `src/task/present.ts`), 123 (inbox), 124 (TOTP typing in `run-task.ts`), 125 (files). Keep `run-task.ts` edits in the
> wall code.
>
> **Drift check (run first)**:
> - `src/task/run-task.ts` has `wallAfterWait`, `stopAtWall`, `#signInWall` and `wallWaitMs: 8000` in `DEFAULTS`.
> - `src/task/start-task.ts` `createRunner(source, choice)` builds `new BrowserTask(page, decider, {...})` in `start`.
> - `SessionEvent` in `src/session/session-service.ts` has exactly `started`, `step` and `finished`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MEDIUM (a run may now stay alive up to 120 s at a wall; the loop,
  guards, statuses and Jev's requests are otherwise unchanged) · **Category**: autonomy without losing the person
- **Planned at**: commit `75fa054`, 2026-11-02

## Why this matters

- A bot check that does not clear in 8 s ends `blocked` (`src/task/run-task.ts` `wallAfterWait`/`stopAtWall`), and a
  sign-in wall ends `blocked` at once (`#signInWall`). Nobody is told; the person learns about it only when the agent
  relays the hand-back, by which time the agent has to start another call.
- With a visible browser the person is usually right there. Passing a Cloudflare box or signing in takes them seconds,
  if they know. Bringing the tab forward, a desktop notification and a live progress line close the gap without
  jevway ever touching the challenge.

## Current state

- `wallWaitMs` (8 s) self-clear wait for a bot check, once per call, polling `findBotWall` every 250 ms; then `blocked`
  with `wall: { kind: 'bot_check', origin, name }`. No Jev request is spent on a wall.
- A sign-in wall: Jev's `sign_in_wall` Noul ≥ 0.7 with an empty field no supplied value fits → `blocked` with
  `wall: { kind: 'sign_in', origin }`.
- `run({ onStep })` reports history entries; `SessionService.task` turns them into `step` events (MCP progress, CLI
  NDJSON). `createRunner(source)` knows the browser source; the task does not.

## Scope

**In scope:** `src/notify/` (new), the wall code in `src/task/run-task.ts`, new `src/task/person-wait.ts`,
`src/task/start-task.ts`, `wait_for_person_seconds` in `src/mcp/task-tools.ts`, `--wait-for-person` in
`src/cli/run-command.ts`, tests in `test/notify/` and `test/task/`, doc and skill sections.

**Small touches outside the owned list (reported):**
- `src/session/session-service.ts`: forward `waitForPersonSeconds` in `continueTask` (it lists the fields a continue
  may change; without it the per-call parameter is dropped on every call after the first), and a `waiting` event.
- `src/recording/describe-step.ts`: one `case` so the story reads "A person passed the Cloudflare check." instead of
  `WAIT_FOR_PERSON "…"`.
- `test/mcp/server.test.ts`: the tool-list token ceiling, raised by exactly the measured delta.

**Out of scope:** solving, clicking or scripting a challenge; `ask_user` (121; `wall` stays intact for it);
`present.ts` (`next` for a wall is unchanged); OS-level window raising beyond CDP; Windows toasts.

## Decisions

1. **Who knows the browser is visible: the runner.** `createRunner(source)` passes `person: { visible, notify }` to
   every task it starts (start-only; `update()` ignores it). `visible` is false for `launch-headless`, and for any
   source whose `Browser.getVersion` user agent says `HeadlessChrome` (a headless Chrome behind an explicit port);
   true otherwise (`auto`, `launch`, a port). A task built directly (tests) is visible unless told otherwise.
2. **The number.** `TaskOptions.waitForPersonSeconds` is per call like `maxSeconds` (kept until a later call changes
   it). `BrowserTask` defaults it to **0**, so a task built directly never waits (every existing bot-wall test keeps
   its timing). The runner fills it: the call's value, else `JEVWAY_PERSON_WAIT_SECONDS` (whole seconds ≥ 0; anything
   else → 120), else 120. The effective wait is `visible ? seconds : 0`, computed in the task, so a later call on a
   headless session that passes 120 still waits 0. MCP `wait_for_person_seconds` 0–600; CLI `--wait-for-person` 0–3600
   (int flags). The wait counts against `max_seconds` like everything else.
3. **When it waits.** At most once per wall kind per call (`bot_check`, `sign_in`, `sso`), and only when the effective
   wait is > 0:
   - **Bot check**: after the existing 8 s self-clear wait, in `wallAfterWait` (so both call sites, before a decision
     and in `stopDone`, get it). A check that comes back after a person passed it ends `blocked` at once, as today.
   - **Sign-in wall**: where `#signInWall` would end the run, after the page is confirmed fresh.
   - **SSO consent** (decision 6): before a decision, after the bot-wall check.
4. **While waiting** (`src/task/person-wait.ts`, one loop for all three): bring the tab forward
   (`Page.bringToFront`, then best-effort `Target.activateTarget` for the window, both through `tab.send`, errors
   ignored); send one desktop notification; tell a `waiting` note at once and then every 10 s; read the page every
   1 s with `observe()` (no Jev request, no input, no script on the challenge beyond the existing read-only
   challenge-box probe); stop early on `limit.stopped()` (cancel, `max_seconds`), whose reason then ends the run as
   today. Tabs the page opens during the wait are the person's (a "Sign in with Google" popup) and are never followed:
   they are taken off the tab's queue and dropped. If the session's tab closes, the wait ends and the loop handles the
   closed tab as it does today.
5. **When a wall counts as passed** (code only, conservative):
   - Bot check: `findBotWall` finds none on a fresh read (today's self-clear rule).
   - Sign-in: the page is still the wall while any of these holds: (a) it shows a password field (filled or not: a
     typed password is not yet a sign-in); (b) it is on the wall's origin + pathname and still lists any field the wall
     had empty (filled or not: a person mid-typing is still signing in); (c) its pathname looks like a sign-in step
     (`login`, `log-in`, `signin`, `sign-in`, `sign_in`, `session(s)`, `auth`, `oauth`, `sso`, `saml`, `2fa`,
     `two-factor`, `mfa`, `otp`, `verify`, `challenge` as a path segment); (d) it is an SSO page (decision 6). Passed
     needs **two reads in a row** (1 s apart) that are not the wall, so a blank page mid-redirect never counts.
   - SSO: two reads in a row not on an SSO page.
   When passed, one history entry `{ operation: 'WAIT_FOR_PERSON', element: 'A person passed the Cloudflare check' }`
   (or "A person signed in at github.com", "A person finished signing in with Google"), confidence 1, page_changed
   true; Jev sees it in `recent_actions`, and the loop goes on in the same call. Nothing is added to history while
   waiting.
6. **SSO consent: included, by URL only.** An SSO page is a URL on an identity provider's sign-in host
   (`accounts.google.com` → Google, `appleid.apple.com` → Apple, `login.microsoftonline.com` / `login.live.com` →
   Microsoft) that carries a third-party sign-in request: `client_id` and `redirect_uri` (raw or URL-encoded inside a
   `continue` parameter) or `SAMLRequest`. That is the definition of "another site asks this account to sign in", it
   holds on the chooser, the password step and the consent screen, and it never holds when the goal is on the
   provider's own pages (no `redirect_uri`). No page-text check: the text is localised and we have no captures, while
   the URL rule is the protocol's own. With a wait of 0 (headless, disabled) nothing changes: Jev decides as today. When
   the wait runs out it ends `blocked` with `wall: { kind: 'sign_in', origin: <provider origin>, name: 'google' |
   'apple' | 'microsoft' }`, so 121's `ask_user` and today's `next` ("Sign in at …") apply unchanged.
7. **Reasons.** With no wait, every reason is byte-for-byte today's. When a wait ran out, the reason keeps today's text
   and adds what happened, e.g. `… that did not clear by itself, and nobody passed it in the 120 s jevway waited with
   the tab in front; jevway never tries to get past one. …` and `The page asks to sign in at https://github.com and no
   supplied value fits its fields; nobody signed in during the 120 s jevway waited. Sign in there …`. `wall` is
   unchanged.
8. **Progress.** `run({ onWait })` hears `{ message, seconds_left }` and the URL; `SessionService` turns it into
   `{ type: 'waiting', session, message, seconds_left, url }`. The CLI prints it as NDJSON like every event. MCP sends
   `notifications/progress` with the message and a progress value between the last step's number and the next
   (`n + waited / (wait + 1)`), so progress keeps increasing as the spec requires and Claude Code's idle timer resets.
   Message: `Waiting for you to pass the Cloudflare check in the Chrome window (45 s left)`.
9. **Notification** (`src/notify/`): `person-messages.ts` builds every person-facing phrase from the wall kind, the
   host and the wall's name only, never page text: notification `Pass the Cloudflare check in the Chrome window`,
   `Sign in to github.com in Chrome`, `Finish signing in with Google in Chrome`. `desktop.ts`
   `desktopNotifier({ env, platform, run })`: undefined when `JEVWAY_NOTIFY` is `off` (also `0`, `false`, `no`) or on
   Windows; macOS `osascript -e 'display notification "<escaped>" with title "jevway"'`, Linux `notify-send jevway
   <message>` (absent → nothing); always `execFile` (no shell), 5 s timeout, fire and forget, every error swallowed.
   The task calls it inside a `try`: a notifier only hears.
10. **Timing is injectable**: `person.pollMs` (1000) and `person.tickMs` (10000) for tests; never exposed as
    parameters.
11. **The wall says whether a person can act** (asked for by 121's `ask_user`): every `wall` gains
    `person_can_act` (false in a headless browser, true otherwise) and, when a wait ran out, `waited_seconds`.
    `kind`, `origin` and `name` are unchanged. In a headless browser the reason ends with what is needed instead of
    "A person can pass it in this tab": `This browser is headless, so nobody can pass it here: a visible browser is
    needed (JEVWAY_BROWSER=auto or launch).` (bot check) and `pass the values, or sign in with a visible browser
    (JEVWAY_BROWSER=auto or launch; this one is headless), then call again.` (sign-in). Decision 7's "byte for byte"
    holds for a visible browser with a wait of 0.
12. **`JEVWAY_PERSON_WAIT_SECONDS` and `JEVWAY_NOTIFY` are read by the process that runs the task** (the MCP server, the
    in-process CLI run, or the daemon as it was started). They are not added to the daemon's settings fingerprint, so a
    running daemon keeps its values until `jevway stop`; documented.

## Git workflow

Branch `wt/exec-person-wait`. Commits, in order:
1. `docs: add plan 122 wait for a person at a wall`
2. `test: describe waiting for a person at a wall` (red)
3. `feat: add desktop notifications for a person to act`
4. `feat: wait for a person at a bot check, sign-in or sso page` (with `wait_for_person_seconds` and
   `--wait-for-person`: the adapter tests need the task option, so one commit keeps every commit green)
5. `docs: describe waiting for a person`

Lowercase conventional commits. **No AI attribution of any kind**. Do NOT push or merge.

## Steps

1. Tests first (no key, `test/fakes.ts`):
   - `test/notify/notify.test.ts`: message texts per kind; never page text; AppleScript escaping; `off` → no notifier;
     darwin/linux commands through an injected `run`; Windows → none; a failing `run` never throws.
   - `test/task/person-wait.test.ts`: a bot check that clears after N reads → the run continues and ends `done` in the
     same call, with the history line and one Jev request; the wait runs out → `blocked`, reason names the wait, `wall`
     intact; headless (`visible: false`) → no wait, today's reason; notification once with the right text; tab brought
     to front; `waiting` notes at the start and every tick; cancel during the wait → "Cancelled by the caller";
     `max_seconds` during the wait → `step_budget`; sign-in wall cleared by leaving the path (two reads), not cleared
     while a password field shows; SSO detection (positive and negative URLs) and an SSO wait that passes; opened tabs
     during the wait are not followed; the per-call value survives `update()`, and a headless session stays 0.
   - Runner: `createRunner('launch-headless')` gives `visible: false`; the env default and `JEVWAY_NOTIFY=off`.
   - Session service: a `waiting` event; MCP progress carries the message; CLI `--wait-for-person` reaches the request.
2. Implement `src/notify/`, then `src/task/person-wait.ts`, the run-task wiring, start-task, session events, adapters.
3. Measure `tools/list` tokens before and after; raise the ceiling by exactly the delta.
4. Docs: `docs/reference.md` (parameter, flag, env rows, the blocked text), `docs/how-it-works.md` §9.3/9.4,
   `skill/jevway/SKILL.md` (the bot-check line), `AGENTS.md` (the bot-wall invariant, layout line for `src/notify/`).
5. `pnpm release:check`. Live check with `live-1`: a headed Chrome on a debugging port, a local "challenge" page
   (`verify/fixture/reader/bot-wall-cloudflare.html`, which never clears) that the test script navigates away mid-wait.

## Done criteria

- [ ] New tests red first, then green; `pnpm release:check` passes
- [ ] No Jev request, input or script on a challenge during a wait (asserted: `requests`, `acted`)
- [ ] Visible `wait 0` runs produce today's reasons byte for byte; headless ones say a visible browser is needed
- [ ] Tool-list delta measured and the ceiling raised by exactly that
- [ ] Live check numbers recorded, or reported as unit-tested only

## STOP conditions

- Passing a wall would need any input to the page.
- The wait would need a Jev request per poll.
- A change would alter `TaskStatus`, a guard, a threshold or the consent rule.

## Maintenance note

The SSO host list and the sign-in path words live in `src/task/person-wait.ts`; add a provider there with a test
URL. The notification wording lives only in `src/notify/person-messages.ts`.
