# Plan 124: 2FA authenticator codes the model never sees

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Four other executors work in parallel (121 `ask_user`, 122 the wall wait in
> `src/task/run-task.ts`, 123 the inbox, 125 files): keep the run-task diff small and local to the TYPE_TEXT value, the
> options and the scrubber. Never push, never merge into `main`, never run `npm publish`.
>
> **Drift check (run first)**:
> - `src/task/run-task.ts` types `const text = decision.valueKey ? values[decision.valueKey] : undefined;` and
>   `#observe()` returns the page unscrubbed when `secretKeys` is empty.
> - `src/jev/secrets.ts` exports `secretMarker`, `shownValues` and `scrubberFor(values, secretKeys)`.
> - `src/task/run-limit.ts` exports `startRunLimit` with `pause(ms)` (never throws).
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: LOW (one new input resolved by code at typing time; the loop, guards,
  thresholds, consent rules and statuses are untouched) · **Category**: autonomy
- **Planned at**: commit `75fa054`, 2026-11-02

## Why this matters

A sign-in on the person's own account that asks for an authenticator code hands back `needs_input` today, and the
agent must ask the person to read a 6-digit code off their phone, then race the 30 s window through another call. An
agent that already holds the person's authenticator secret for that account (they gave it, for this purpose) should be
able to pass it once and let code type the current code, without the model ever seeing the secret or the code.

## Current state

- `values` + `secret_keys` (plan 10x, `src/jev/secrets.ts`): Jev sees `[secret:<key>]`, the value is typed as given and
  scrubbed (all its forms) from every request, summary, trace, story, run-folder text and file name.
- TYPE_TEXT types exactly `values[decision.valueKey]` (`src/task/run-task.ts`); the model only picks the key.
- `files` is the precedent for a caller input kept apart from `values`: checked before the run (`checkUploadFiles`),
  the model picks a key, code resolves it.

## Scope

**In scope:** new `src/task/totp.ts`; `src/jev/secrets.ts` (extra secret entries); in `src/task/run-task.ts` the
`totp` option, its intake in the constructor and `update()`, the TYPE_TEXT value resolution, the scrubber's inputs and
the values handed to `decide()`; `src/session/session-service.ts` (early check, forward on continue, goal scrub);
`src/mcp/task-tools.ts` (`totp`); `src/cli/run-command.ts` (`--totp`); tests under `test/task/`, `test/jev/`,
`test/cli/`, `test/mcp/`; docs sections in `docs/reference.md`, `docs/how-it-works.md`, `skill/jevway/SKILL.md`,
`AGENTS.md` (one invariant line).

**Out of scope:** HOTP (counter-based) codes; journeys; replay protection (typing the same code twice in a period);
reading codes from SMS or email (plan 123's inbox is for disposable sign-ups).

## Decisions

1. **Shape.** `totp: { "<key>": "<secret>" }` (MCP), `--totp '{"otp":"…"}'` (CLI), `totp?: Record<string, string>` on
   `TaskOptions`. The secret is either base32 (RFC 4648 alphabet, case-insensitive; spaces, hyphens and trailing `=`
   ignored) or an `otpauth://totp/<label>?secret=…&digits=…&period=…&algorithm=…` URI. A record like `values` and
   `files`, so several accounts can each have a key, and the key names the account's field for Jev.
2. **Kept apart from `values`.** The secret text is never in `values`, so `tab.want`, `valueKeysIn` and every other
   reader of `values` never sees it. Only `decide()` gets `{ ...values, [key]: secret }` with the key added to the secret
   keys, so `supplied_values` and the value question show `[secret:<key>]` and Jev can choose it for a field; `decide`'s
   own whole-request scrub then covers the secret text too.
3. **Always secret, for the session.** A `totp` key joins the task's secret keys when it is taken (no `secret_keys`
   needed), so the page scrub in `#observe` runs with only `totp` given. Once secret, always secret (as today).
4. **Resolved at typing time, by code.** When Jev's TYPE_TEXT picks a `totp` key, the loop computes the code (RFC 6238:
   HMAC-SHA1 default, 6 digits, 30 s; `digits` 6–8, `period` 1–300 s and `algorithm` SHA1/SHA256/SHA512 from a URI;
   Node `crypto`, no dependency), registers it with the scrubber, and only then records the step and types it. Codes
   are registered before the input, so the page read right after typing (the field's value, a page that echoes it) is
   already scrubbed.
5. **Freshness threshold: 8 s** (at most a third of the period for short periods). When fewer remain in the current
   period, the loop waits for the next period (`limit.pause`, so a cancel or the time budget ends it at the existing check
   right before the input) and types that period's code. Reason: after typing, the run still observes the page, decides
   the submit click (one request plus the commit-risk follow-up, typically 2–5 s) and clicks; 3 s would routinely send a
   code that expired on the way, and servers that accept the previous period are common but not universal. Cost: at
   most 8 s, on average about 1 s per code typed. After the wait the code is computed for the new period's start (or
   later), never the old one, so a frozen test clock gives the same answer as a real one.
6. **Scrubbing generated codes.** `scrubberFor(values, secretKeys, more)` takes extra `[key, value]` entries that are
   always secret: each `totp` key's text as given, its bare base32 secret (for a URI), and every code generated this
   session (append-only, so an old code stays masked too). A short code means a 6-digit number on the page that
   happens to match is masked: the existing rule "a garbled text is the safe failure" holds. `value_kept` keeps working
   (both sides become the marker).
7. **Validation before the run.** A bad base32 character, a secret under 80 bits (16 base32 characters; also catches a
   6-digit code passed by mistake), an empty one, a URI that is not `otpauth://totp/` or lacks `secret`, or a bad
   `digits`/`period`/`algorithm`, and a key given in both `values` and `totp` on the same call, are input errors
   `totp.<key>: …`. The message never contains the secret. Checked in the session service before the browser opens a
   tab (new session) and in `BrowserTask` (constructor and `update`, for direct callers); the CLI reports it as a usage
   error (exit 2).
8. **Later calls.** `totp` keys stay for the session; a later call's `totp` replaces a key, and a later `values` for the
   same key replaces it with a plain value (it stays secret). The newest wins.
9. **Not in scope, on purpose.** No replay protection (a code typed twice in a period); no HOTP.
10. **Outputs.** Recorded screenshots, `final.jpg` and video are pixels: a typed code is visible there, as a typed
    secret already is (documented). Nothing else on disk or in a response holds the secret or a code.

## Git workflow

1. `docs: add plan 124 totp codes`
2. `test: describe totp codes typed by code` (red)
3. `feat: type authenticator codes computed at typing time`
4. `docs: describe totp codes`

## Steps

1. Tests (all offline, no key):
   - `test/task/totp.test.ts`: RFC 6238 Appendix B vectors (SHA1/SHA256/SHA512 seeds of 20/32/64 bytes, 8 digits, all
     six times); 6-digit default; base32 forms; otpauth URIs honouring digits/period/algorithm; rejected inputs name the
     key and never echo the secret; the near-expiry wait with an injected clock.
   - `test/jev/secrets.test.ts`: extra entries are scrubbed.
   - `test/task/run-task-totp.test.ts` (fake tab): Jev picks `otp`, the typed text equals the generated code;
     requests, summary, trace and the recorded `summary.json`/`index.html` hold only `[secret:otp]`, never the code or
     the secret; a page echoing the code is scrubbed; works without `secret_keys`; a later call replaces the key; bad
     secrets and a key in both `values` and `totp` are refused; the session service refuses before starting a tab.
   - CLI `--totp` passes through and a bad one exits 2; the MCP `totp` param reaches the service.
2. Implement `src/task/totp.ts`, the scrubber entries, the run-task intake and resolution, the plumbing.
3. Docs: `docs/reference.md` section, `docs/how-it-works.md` secrets section, skill rule, `AGENTS.md` invariant.
4. Live (a `live-1`/`live-2` lock): a local fixture with a password step and a 2FA step that checks the code
   server-side with the same secret; `jevway_task` through the MCP server end to end; report numbers and folder.

## Done criteria

- [ ] new tests red first, then green; `pnpm release:check` passes
- [ ] the typed text equals the generated code; no request, summary, trace or run-folder text holds the secret or a code
- [ ] bad secrets are input errors naming the key, before a tab opens
- [ ] the tool-list token delta measured and the ceiling raised by exactly that
- [ ] the live 2FA fixture run recorded in the report

## STOP conditions

- The change would alter a guard, a threshold, the consent rule or a status.
- The model's output would become typed text in any path.

## Maintenance note

Another code-at-typing-time input (a generated password, say) belongs in the same place: a key kept apart from
`values`, shown to Jev only as a marker in `decide()`'s values, resolved in `#textFor`, and registered with the
scrubber before the input.
