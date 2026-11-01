# Plan 091: Values the caller marks secret reach Jev by key only and are scrubbed from every output; `needs_input` names its fields

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/jev/decide.ts` `buildRequest` must have `supplied_values: input.values,` and `valueQuestion` must build its
>   options with `` [key, `${key}: ${value}`] ``.
> - `src/task/run-task.ts` `#loop` must start with `this.#tab.want(Object.values(this.#options.values));`, and `stop`
>   must build the `TaskSummary` it returns.
> - `src/browser/tab.ts` `observe()` must evaluate `` `window.__jevWanted=${JSON.stringify(this.#wanted)};${READ_STATE}` ``.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (changes Jev's request, for marked keys only) · **Category**: safety
- **Planned at**: commit `39f5928`, 2026-11-01

## Why this matters

`docs/prior-art.md` S4 and K3.

- Only password fields are protected today (never listed; `password_fields` carries filled/empty only). An API token,
  a one-time code or a card's CVV typed into an ordinary field goes to the model raw:
  - `supplied_values: input.values` (`src/jev/decide.ts:266`), and the value question lists `key: value` (`:300`);
  - once typed, the field's `value`/`current_value` in `elements` and any echo in the page text (`Token abc… copied`).
- It also comes back to the caller and to disk: `page_text`, `steps` (a label that echoes it), reasons, `task.trace`,
  and `recordDir`'s `summary.json`/`index.html`.
- It also reaches the page's own scripts before any field is typed: `tab.want(values)` sets `window.__jevWanted` in
  the page's main world (`src/browser/tab.ts:344`).
- Prior art: Ying-Kai-Liao redacts by key name (`token|otp|card|cvv|pin`, values ≥ 4 chars) by splitting the
  serialized JSON (`src/session.mjs:287-295`, `:681-682`); forvela marks inputs `secret` per entry
  (`src/contracts.js:1-41`); wingman withholds every value (`src/core/withhold.ts`), which would break the `value_for_`
  heads our Jev baseline was verified on.
- K3: a `needs_input` today is a reason string plus `stuck.element`; an agent has to parse the label out of quotes.

## Current state

- `TaskOptions.values` → `BrowserTask.#options.values`, merged in `update()`; `decide()` receives them raw.
- `buildRequest` puts the JSON `state` (page, elements, supplied values, history) and the `questions` in one request;
  follow-up requests reuse `request.state` with new questions (value, target check, element risk).
- `stop()` builds every `TaskSummary`; `run()` hands it to `Recording.finish`, which writes `summary.json` and
  `index.html`. `Recording.step` records a description (labels, value **key**) and the page URL.
- `needs_input` comes from `#handBack`: BLOCKED with `fieldsWithoutValue` (labels) or TYPE_TEXT without a value key.

## Design decisions

1. **Shape: `secret_keys: string[]`** (MCP), `--secret-keys a,b` (CLI), `secretKeys` (`TaskOptions`,
   `DecisionInput`, the verify `Job`). Opt-in per key, not by key-name guessing: a caller knows which value is a secret,
   and name guessing would silently change Jev's request for keys like `pin_code` that may not be secret. Keys
   accumulate over a session (`update()` takes the union): once secret, always secret.
2. **What Jev sees for a secret key:** `[secret:<key>]` in place of the value, in `supplied_values` and in the value
   question (`<key>: [secret:<key>]`). The key name is what lets Jev pick the field; the marker is the same one the
   scrubbed page text shows, so a field that already holds the value reads `[secret:<key>]` and Jev can tell it's filled.
3. **Unmarked values keep today's request byte for byte.** With no secret key, `buildRequest` returns the same object it
   does today (a test asserts deep equality); the scrubber is the identity.
4. **Scrub structurally, at the boundaries; never the page the loop holds.** One pure module `src/jev/secrets.ts`:
   `scrubberFor(values, secretKeys)` returns a function that walks plain objects and arrays and replaces each secret in
   every string (object keys untouched, class instances such as the screenshot `Image` untouched). It is applied to:
   - Jev's request: the whole request where it is put together (`buildRequest`'s return, and each follow-up's
     `{state, questions}`), so every key is covered, also one another branch adds later (plan 102's `last_change`).
     `image_url` parts and the `Image` asset are skipped: base64 can contain a short secret by chance;
   - the `TaskSummary` in `stop()` (reason, url, title, page_text, steps, stuck, confirm_ignored, missing), which is
     also what `Recording.finish` writes;
   - `task.trace` entries added during the run, scrubbed in place once in `stop()`;
   - `Recording.step`'s description and URL.
   The loop keeps raw values: typing, `value_kept`, `#rejectedSubmit` and `showsTarget` compare them.
5. **What counts as an echo:** each secret value as typed, trimmed, URL-encoded and form-encoded (`+` for spaces),
   matched case-insensitively (a page may upper-case a code), longest first, in one pass so one marker never gets
   scrubbed again. Every non-empty value is scrubbed, even a short one: a garbled page text is the safe failure, a
   leaked secret isn't. Documented: mark only real secrets.
6. **`tab.want` gets no secret values**, so a secret never reaches the page's scripts until it is typed into its field.
   A token is never a link label worth scrolling to.
7. **Recorded screenshots and `run.mp4` are not masked.** They are pixels of the real page for people, never sent to a
   model, and a mask would need restyling the user's page (in `auto` mode, their own Chrome) for the whole screencast.
   Documented on `record_dir`: recordings may show a secret as the page shows it (an unmasked field, an echo).
8. **Journeys are out of scope** (their `values` are made-up data by contract).
9. **K3: `missing: { label, role?, path }[]`** on every `needs_input` summary, one entry per field: BLOCKED can name
   several (`fieldsWithoutValue`), TYPE_TEXT names the chosen one. `label` is the field's label (`bareLabel`), `role`
   its ARIA role when the reader has one, `path` the URL pathname it is on. Additive: reasons stay byte-identical.

## Scope

**In scope:** `src/jev/secrets.ts` (new), `src/jev/decide.ts` (values parts of `buildRequest`, follow-ups),
`src/task/run-task.ts` (options, `update`, `want`, `stop`, the decide call), `src/task/recording.ts`, `src/mcp.ts` and
`src/cli.ts` params, `verify/jobs/runner.ts` and `verify/signup.ts` (pass `secretKeys`), tests, `AGENTS.md`,
`README.md`, `skill/jev-browse/SKILL.md`.

**Out of scope:** password fields (already never listed), journeys, masking images.

Never read `.env`.

## Git workflow

Branch `wt/exec-a-consent`. Commits:
1. `docs: add plan 091 secret values reach jev by key only`
2. `test: secret values never reach jev or any output; needs_input names its fields`
3. `feat: let the caller mark values secret, and name the fields needs_input wants`

Lowercase conventional commits. No AI attribution of any kind. Do NOT push.

## Steps

### 1. Tests first

- **`buildRequest` unchanged** with no secret keys (deep-equal to the request built without the option).
- **Jev sees the key only:** `supplied_values.token === '[secret:token]'`, the value question option reads
  `token: [secret:token]`, and the raw value appears nowhere in `JSON.stringify(request)`, also when the page text, a
  label, a field value and the URL echo it (raw, upper-cased, URL-encoded); follow-up questions too.
- **The run still types the real value** into the field Jev picked.
- **Every output is scrubbed:** a scripted run that types a secret on a page echoing it, with `recordDir`: no raw value
  in the summaries, `task.trace`, `summary.json`, `index.html`; `[secret:token]` present.
- **`want` gets no secret values.**
- **Unmarked values untouched** in the summary.
- **K3:** `needs_input` from TYPE_TEXT carries `missing: [{ label: 'Email address', role: 'textbox', path: '/stays' }]`;
  from BLOCKED, one entry per field; reasons unchanged.
- **MCP/CLI:** `secret_keys` reaches the task (through `createRunner().start` / `update`).

Run them red. Commit.

### 2. Implement

As in the design. Docs: AGENTS.md invariant next to the password rule; README and SKILL (`secret_keys`, `missing`,
the recording caveat); MCP descriptions. `pnpm typecheck`, `pnpm test`. Commit.

### 3. Measure (with plan 090)

- `pnpm verify` 8/8, `pnpm verify:redteam` 0, `JEV_CHECKOUT_RUNS=3 pnpm verify:checkout`.
- `forgejo` lock: `JEV_FORGEJO_RUNS=3 pnpm verify:forgejo`; `JEV_SIGNUP_RUNS=3 pnpm verify:signup` with `password`
  marked secret in `password-ask` (the suite passes no code or token; the password is its only secret-like value), then
  `rg` the raw password over `verify/out/signup-*` (traces, results, recordings' JSON/HTML): expect no hits.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; new tests red first
- [ ] suites above as plan 090 lists; signup no worse than main; 0 raw-secret hits in its `verify/out`
- [ ] `git diff --stat main` lists only in-scope paths

## STOP conditions

- A raw secret value in any `verify/out` file other than screenshots/video.
- Jev's request for a run with no secret keys differs from `main`'s.

## Maintenance note

Scrubbing matches the value as typed and its URL encodings, case-insensitively. A page that reformats a secret
(groups a card number `4242 4242…`, masks part of it) is not matched; extend `needlesOf` with measured cases.
