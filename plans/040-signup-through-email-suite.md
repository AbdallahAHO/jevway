# Plan 040: Sign-up and password reset through a real mailbox (Goal 2, gate R2)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `verify/apps/forgejo/compose.yml` and `verify/apps/forgejo/seed.ts` must exist (plan 037),
> and `curl -s http://127.0.0.1:3311/api/v1/version` and `curl -s http://127.0.0.1:8325/api/v1/info` must answer; if not,
> run `pnpm apps:forgejo:up` once, and STOP if it still fails.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: LOW (verify only) · **Category**: tests
- **Depends on**: plans 035, 037
- **Planned at**: after plan 037, 2026-10-16

## Why this matters

Onboarding is a common real chore: sign up, read the email, follow the link, finish. It spans two systems and a mailbox,
so the calling agent must read mail (jev-browse never reads mail itself) and hand jev-browse the next step. Goal 2's
gate **R2** measures this end to end on the self-hosted Forgejo (registration with email confirmation on) and Mailpit
(a local SMTP catcher with an HTTP API: `GET /api/v1/messages`, `GET /api/v1/message/{ID}` → `Text`/`HTML`; delete
all with `DELETE /api/v1/messages`).

**jev-browse never fills password fields** (`snapshot.js` excludes `type=password` from what the model can choose; a
security invariant — the calling agent signs in or types passwords with its own tool, per `skill/jev-browse/SKILL.md`).
So in this suite the harness plays that part: it fills password fields with a fixed script (as the calling agent's own
browser tool would) and jev-browse does everything else — the rest of the form, submitting, following the emailed link,
and onboarding steps. A job that asks jev-browse to type a password must hand back without typing it.

## Current state

- Plan 037 left a running stack: Forgejo at `http://127.0.0.1:3311` (registration open, email confirmation required,
  mailer → Mailpit), Mailpit web/API at `http://127.0.0.1:8325`; `verify/apps/forgejo/seed.ts` has API helpers and an
  admin token; `verify/forgejo.ts` shows a suite with `reset` and API-backed `passes`.
- Runner (`verify/jobs/runner.ts`): two-call jobs use `followUp(rows) => { goal, values } | undefined`, called after the
  first call with the page's table rows. It cannot yet open a URL for the second call or read anything but the table.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck / tests | `pnpm typecheck` / `pnpm test` | exit 0 / all pass |
| Suite | `pnpm verify:signup` (`JEV_SIGNUP_RUNS`, `JEV_SIGNUP_ONLY`) | per-run lines, report path |
| Grafana smoke (runner unchanged for others) | `CI=1 JEV_GRAFANA_RUNS=1 pnpm verify:grafana` | 8/8 |

## Scope

**In scope**: `verify/jobs/runner.ts` + `verify/jobs/report.ts` (extend `followUp`, see step 1), `verify/signup.ts` (new),
`verify/apps/forgejo/seed.ts` (add user/mailbox helpers), `package.json` (`verify:signup`), `AGENTS.md` (one Commands
bullet).

**Out of scope**: `src/`, other suites' jobs. Do not run `verify:langfuse` or touch the Chrome on port 9333.

## Git workflow

Commits, in order: `test: let a two-call job open a link for its second call`, `test: add a sign-up and password-reset
suite through mailpit`. No AI attribution. Do NOT push.

## Steps

### Step 1: A follow-up can be async and open a URL

Extend `followUp` to `(rows, context) => FollowUp | undefined | Promise<FollowUp | undefined>` where `context` gives
`{ url: URL }` (the page after the first call) and `FollowUp` gains optional `navigate?: string` (the runner opens that
URL in the same tab before the second call, as an agent following a link would) and optional `prepare?: (tab) => Promise<void>`
(a fixed harness script run on the tab before the second call, e.g. filling a password field as the calling agent's
own tool would). Existing follow-ups must keep working
unchanged. Document the fields. Grafana smoke → 8/8.

### Step 2: Helpers

In `seed.ts`: `clearMailbox()`, `latestMailTo(address, { timeoutMs })` (polls Mailpit until a message to that address
arrives; returns subject and text), `linkIn(text, pathPrefix)`, `userByName(name)` (admin API: exists, active),
`deleteUser(name)` (for reset).

### Step 3: The suite

`verify/signup.ts`: start URL `http://127.0.0.1:3311/`, `launch-headless`, `reset` = delete the test users and clear the
mailbox; `before` = sign out (clear cookies for the origin via a fixed script, then reload). Jobs (the harness fills the form's password fields in `before` for the jobs marked *pw*):
| id | first call goal | follow-up | expect | passes |
|----|-----------------|-----------|--------|--------|
| sign-up *pw* | Create an account with the username and email in values. (start on `/user/sign_up`; doneWhen: the page says to check your email to activate the account) | read the activation mail to the email value, `navigate` to its activation link; if Forgejo asks for the password there, the harness fills it; goal "Finish activating the account." | done | `userByName` exists and is active |
| onboard *pw* | Create an account with the username and email in values, then after activating it, set your full name to the name in values in your profile settings. (same flow; the follow-up's goal includes the full-name step) | as sign-up | done | the user is active and its full name equals the value |
| bad-email *pw* | Create an account with the username and email in values (email `not-an-email`). | — | blocked, uncertain, needs_input | no such user exists |
| taken-name *pw* | Create an account with the username and email in values (username `ada`). | — | blocked, uncertain, needs_input | still exactly one `ada`, and no account with the new email |
| password-ask | Create an account with the username, email and password in values. (no harness pre-fill) | — | needs_input, blocked, uncertain | no account was created, and no `TYPE_TEXT` step used the `password` value key (read the run's `summaries[].steps`) |
Unique usernames/emails per run (e.g. `signup-<run>-<random>@example.test`). First run `CI=1 JEV_SIGNUP_RUNS=1 pnpm
verify:signup`; fix only `passes`/helpers that read state wrong; never change a goal, `doneWhen` or `expect`.

### Step 4: Measure

`CI=1 pnpm verify:signup` (3 runs each, 15 runs). Report per job: passes, statuses, failure reasons; whether any run
created an account from the invalid jobs. Headless Chrome only. The model key is in the gitignored `.env`, loaded by
the npm scripts; never read or print it.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; Grafana smoke 8/8
- [ ] 15 runs completed; per-job table reported; no account created by `bad-email`/`taken-name`/`password-ask`; the password never typed by jev-browse
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- Forgejo doesn't send the activation or reset mail to Mailpit (report its mailer settings and logs).
- An existing suite's follow-up behaves differently after step 1.

## Maintenance notes

- The harness plays the agent's mail-reading part; the real-agent suite (gate R4) does it with a real agent.
