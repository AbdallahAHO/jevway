# Plan 123: a disposable inbox for test and demo sign-ups, built in and bundled

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md` and
> `plans/LOG.md`; do not edit them. Four other executors work in parallel this round (121 `ask_user`, 122 wall wait,
> 124 TOTP, 125 files): keep edits inside the files listed under Scope, and add sections to shared docs rather than
> rewriting them. Never push, never merge into `main`, never run `npm publish`.
>
> **Drift check (run first)**:
> - `src/mcp/server.ts` has `TOOLS_IN_ORDER` with `task` and `journeys`, and `setting('JEVWAY_TOOLS', …, ['all', 'task', 'journeys'])`.
> - `src/daemon/protocol.ts` `Method` has no `inbox.*` member; `src/daemon/server.ts` has a `handlers` record.
> - `src/setup/skill-command.ts` exports `installSkill(source, parent, { force })` and installs into `<dir>/jevway` only.
> - `skill/jevway/SKILL.md` has the bullet "A sign-up needing an email: use a throwaway inbox service …".
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: LOW (new tools and a new command; the run loop, guards, consent rules,
  statuses and Jev's request are untouched) · **Category**: autonomy
- **Planned at**: commit `75fa054`, 2026-11-02

## Why this matters

A sign-up that sends a verification email stops the agent: the skill says "use a throwaway inbox service" and leaves
the agent to find one, call its API by hand and keep its password somewhere. The owner's own `disposable-inbox` skill
(`scripts/inbox.mjs`, mail.tm REST API with mail.gw as the fallback) already does this for agents with a shell. This
plan builds the same thing into jevway (MCP tools and a CLI command, credentials held by jevway) and ships the
standalone script as a second bundled skill for agents that have no jevway.

## Scope

**In scope:**
- New `src/inbox/`: `mail-api.ts` (the mail.tm-compatible REST calls over an injected `fetch`), `message.ts` (pure:
  body text, code, links, filters, excerpt), `inbox.ts` (`createInbox`, `waitForMessage`, `listMessages`,
  `readMessage`, `InboxError`), `inbox-registry.ts` (in-memory inboxes for a process), `inbox-file.ts` (the one-shot
  CLI's env file).
- `src/mcp/inbox-tools.ts` (new) and its registration in `src/mcp/server.ts`; one instructions line in
  `src/mcp/instructions.ts`.
- `src/cli/inbox-command.ts` (new) and one dispatch line in `src/cli/dispatch.ts`.
- `src/daemon/`: `inbox.create`, `inbox.wait`, `inbox.list`, `inbox.read` (`protocol.ts` method names, `server.ts`
  handlers and the error code pass-through for `InboxError`).
- `skill/jevway-inbox/` (new: `SKILL.md`, `scripts/inbox.mjs`), `src/setup/skill-command.ts` (install both skills).
- Tests under `test/inbox/`, `test/cli/`, `test/mcp/`, `test/setup/skill.test.ts`; the tool-list and instructions
  ceilings in `test/mcp/server.test.ts`.
- Docs: `docs/reference.md` (an inbox section, the `jevway skill` lines), `docs/how-it-works.md` (a short section),
  `skill/jevway/SKILL.md` (the email bullet), `AGENTS.md` (layout and an invariant line).

**Out of scope:** `README.md` (the reviewer's); the run loop, `values`/`secret_keys` handling (an inbox code reaches
Jev through the existing `values` path); `jevway setup` (it registers the server, whose built-in tools make the
standalone skill unnecessary there); the Claude Code plugin's `skills` list (same reason).

## Decisions

1. **Its own small registry, not the session service.** An inbox exists before the session that uses it (the address
   goes into the first call's `values`), holds no browser, and outlives a session that ends after the sign-up. Folding
   it into `SessionService` would make a session own something it can't create first. So `createInboxRegistry()`
   holds inboxes in memory: one per `jevway-mcp` process (built once in `createMcpServer`'s outer closure, like the
   tool registrations, so every connection shares it) and one per daemon. The adapter still holds no session state.
2. **Ids.** `jevway_inbox_create` returns `{ inbox, address }`: `inbox` is a `randomUUID()` like session ids. Lookups
   accept the id or the address, so the CLI can name an inbox by its address.
3. **Credentials.** The password is `randomBytes(18)` base64url, held on the inbox object as a non-enumerable property
   (so `JSON.stringify` and `console.log` of an inbox never show it), and the provider's token per call. Neither
   is ever in a result, an error message (any provider text is scrubbed of the password), an event or a log line (the
   daemon logs method names only). Where it lives:
   - MCP: the server process's memory.
   - CLI with a daemon running: the daemon's memory (`jevway inbox create` does **not** start a daemon).
   - One-shot CLI (no daemon): `<out root>/inboxes/<address>.env`, mode 600 in a 700 folder, under the output root
     whose `.gitignore` is `*`. Same `ADDR=` / `PASS=` / `API=` lines as the standalone script, so either reads the
     other's file.
   `wait`/`list`/`read` ask the daemon first when one runs; `unknown_inbox` from it (or no daemon) falls back to the
   env file; neither is `unknown_inbox`, exit 1, with a hint to create one.
4. **Providers and fallback.** Default mail.tm (`https://api.mail.tm`). `createInbox` picks the first active domain,
   makes an account `test-<10 hex>@<domain>` (no token until the first wait, list or read: mail.tm
   rate-limits). If mail.tm is down (network error,
   5xx, 429), offers no active domain or rejects the account, it tries mail.gw (`https://api.mail.gw`, same API) once;
   if that fails too: `InboxError` `inbox_unavailable`, naming both and hinting to ask the user for a test mailbox of
   their own. An explicit `provider` (`mail.tm` | `mail.gw`) uses that provider only: it is how an agent retries once
   when a *site* rejects the first address's domain. The tool never takes a URL (no arbitrary fetch target).
5. **Waiting.** `waitForMessage(inbox, { from?, subject?, timeoutMs, signal, onPoll? })` polls `GET /messages` now and
   then every 3 s, takes the newest message whose sender (name or address) and subject contain the filters
   (case-insensitive), reads it in full and returns it parsed. A 401 refetches the token once; 3 failed polls in a row
   end it `provider_unavailable`. A timeout is a result, not an error: MCP `{ status: "timeout", next }` (not
   `isError`), CLI `{ ok: true, status: "timeout", … }` exit 1 like a hand-back. The signal (MCP cancel, CLI Ctrl-C,
   a dropped daemon connection) stops the wait at once. `timeout_seconds` 1–600, default 120.
6. **What a received email returns.** `{ status: "received", inbox, address, id, from, subject, received_at, code?,
   links, text_excerpt, next }`. `code`: the first standalone 4–8 digit number in subject + text (the standalone
   script's rule). `links`: unique http(s) URLs from text and html, `&amp;` decoded, images and w3.org namespaces
   dropped. `text_excerpt`: the body text (html stripped when there is no text part), whitespace folded, first 600
   characters. `next` says: pass the code in `values` with its key in `secret_keys` on the sign-up session (read the
   excerpt first: a year or order number can come first), or open the verification link with `jevway_task` `url` (a
   new tab in the same browser, so the sign-up's cookies apply). The email is untrusted content, stated in the tool
   description.
7. **MCP tools.** No output schemas (like the journey tools: they would cost ~95 tokens of every tool list).
   `jevway_inbox_create` (`{ provider? }`; hints readOnly false, destructive false, idempotent false,
   openWorld true) and `jevway_inbox_wait` (`{ inbox, from?, subject?, timeout_seconds? }`; readOnly true, destructive
   false, idempotent true, openWorld true). Registered last in the fixed order, under `JEVWAY_TOOLS=all` (default) and
   a new `inbox` set; `task` and `journeys` are unchanged. The rule "test and demo accounts the user asked for only;
   never to get around limits, trials or bans" is stated once in `jevway_inbox_create`'s description and once in the
   server instructions. Each poll sends `notifications/progress` (`progress` elapsed seconds, `total` the timeout).
8. **CLI.** `jevway inbox create [--provider mail.gw] | wait <address> [--from] [--subject] [--timeout 120] | list
   <address> | read <address> <id>`; one JSON document on stdout, `{ type: "inbox_wait", … }` NDJSON progress on
   stderr. `list` prints `{ ok, address, messages: [{ id, from, subject, received_at }] }`; `read` the same fields as a
   received `wait`, with the full `text` instead of the excerpt.
9. **Bundled skill.** `skill/jevway-inbox/` is the owner's script cleaned up: no personal paths or tool names, the
   jevway pairing added, the same safety rules. `jevway skill --install <dir>` installs `jevway` and `jevway-inbox`
   side by side through a new `installSkills` that calls the unchanged `installSkill` per folder (`jevway setup`
   keeps calling `installSkill` for `jevway` alone); the result keeps its top-level `{ ok, status, path, files }` for `jevway` (callers that parse it
   keep working) and adds `skills: [{ name, status, path, files }]` for both. A different folder for either, without
   `--force`, fails `skill_exists` naming it before anything is copied. `jevway skill` still prints jevway's
   SKILL.md; `jevway skill --name jevway-inbox` prints the other.

## Git workflow

1. `docs: add plan 123 a disposable inbox for sign-ups`
2. `test: describe the disposable inbox, its tools and its command` (red)
3. `feat: add the disposable inbox client`
4. `feat: add the jevway_inbox_create and jevway_inbox_wait tools`
5. `feat: add jevway inbox through the daemon or an env file`
6. `feat: bundle the jevway-inbox skill and install it with jevway's`
7. `docs: describe the built-in inbox`

## Done criteria

- [ ] New tests red first for the right reason, then green; `pnpm release:check` passes at every handed-over commit
- [ ] No password or token in any result, error, event, log line or stdout (asserted)
- [ ] Env file mode 600 (asserted)
- [ ] One live round trip on mail.tm (create, wait 10 s → timeout), reported
- [ ] Tool-list token delta measured and the ceiling raised by exactly that

## STOP conditions

- The feature would need a change to the run loop, `values`/`secret_keys` handling, a guard or a status.
- mail.tm's API differs from the standalone script's assumptions in a way the live check shows.
