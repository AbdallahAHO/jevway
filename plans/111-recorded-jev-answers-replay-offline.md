# Plan 111: Recorded Jev answers replay offline

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> - `src/jev/decide.ts` must export `type Ask = (request: SystemOneRequest, options?: { signal?: AbortSignal }) => Promise<…>`.
> - `src/jev/model.ts` must have `export const createAsk = (profile: ModelProfile): Ask =>` that throws
>   `` `Set ${profile.apiKeyEnv} to use ${profile.name}.` `` without a key, and `resolveModel` must pick the `direct`
>   route only when `process.env[direct.apiKeyEnv]` is set.
> - `verify/run.ts`, `verify/gotchas.ts`, `verify/redteam.ts` and `verify/capabilities.ts` must each get their Ask from
>   `createAsk(…)`.
>
> Otherwise STOP.

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW (off unless `JEVWAY_REPLAY` is set; no request, decision, guard or
  status changes) · **Category**: measurement
- **Planned at**: commit `1401906`, 2026-11-01

## Why this matters

Every end-to-end run is live and paid: `pnpm verify`, `verify:gotchas`, `verify:redteam` and `verify:capabilities` call
Jev on every step, so a loop or guard change can only be regression-tested by spending credits and waiting on the
network. Prior art [V3](../docs/prior-art.md#v3) (fastbrowse `bench/README.md:8-27`, `:36-58`) stores each response
under the sha256 of the canonical request and refuses a request it never saw, with a diff against the nearest recorded
one. Once a suite run is recorded, the same suite replays offline, deterministically and for free: a change that alters
what Jev is asked shows up as a miss naming the step and what changed, and a change that doesn't alter the requests
replays to the same statuses.

## Decisions (made by the user; final)

1. **Hook:** wrap `Ask` in-process. `JEVWAY_REPLAY=record` makes `createAsk` (`src/jev/model.ts:189`) return an Ask that
   calls the real one and saves request → answer; `JEVWAY_REPLAY=replay` returns an Ask that answers only from the store
   and never touches the network. Code in a new `src/jev/replay.ts`, a minimal hook in `model.ts`.
2. **Storage:** local and gitignored under `verify/out/replay/<suite or name>/` (`verify/out` is gitignored), folder set
   by `JEVWAY_REPLAY_DIR`. Each entry holds the full (canonical) request, the answer and the model id.
3. **First version's scope:** the fixture suites `pnpm verify`, `verify:gotchas`, `verify:redteam`,
   `verify:capabilities`. Forgejo, signup and checkout normalisation (CSRF tokens, timestamps, session ids) is a
   follow-up.

## Current state

- **Where the hook goes.** All four suites call `createAsk(resolveModel().profile)` once (`verify/run.ts:24`,
  `verify/gotchas.ts:135`, `verify/redteam.ts:122`, `verify/capabilities.ts:373`); the MCP server gets its Ask from
  `src/task/start-task.ts:33`. `pnpm verify`'s MCP scenario spawns `src/mcp.ts` with `...process.env`, so a child
  process records and replays too.
- **Every model call goes through `Ask`:** `decide()` (one operation request plus concurrent follow-ups: value, file,
  target check, element risk; `src/jev/decide.ts:151-247`) and the done evidence request (`src/task/run-task.ts:1047`).
- **Secrets are already scrubbed.** `buildRequest` ends with `scrubberFor(input.values, input.secretKeys)(…)`
  (`decide.ts`, last line of `buildRequest`), follow-ups are scrubbed the same way (`followUp` in `decide()`), and the
  evidence request is scrubbed by `this.#scrub(evidenceRequest(…))` (`run-task.ts:1044`). Supplied values Jev sees are
  `shownValues(…)`: a secret key carries `[secret:key]`. Password fields never reach a request (only filled/empty). So
  a stored request holds nothing the live request didn't send; nothing more is scrubbed here.
- **What varies between identical runs, measured.** Two requests built offline from `verify/fixture/stays.html` in
  headless Chrome, each on a fresh server (no model call), differ in exactly two leaves:
  - `state.page.url`: `http://127.0.0.1:63068/stays.html` vs `…:63088/…` (the fixture server listens on port 0;
    `pnpm verify` also serves its iframe form on a second random port, reached as `localhost:<port>`);
  - `state.screenshot`: the SDK's `Image.toJSON()` is `<image:<random hex>>` (`@typesafe-ai/sdk` `Image#reference`).
  Under OpenRouter the screenshot is an `image_url` part with a base64 data URL, whose bytes can differ by a pixel.
- **Traces don't hold requests.** `trace.json` and `summary.json` under `verify/out/worktrees/exec-integration/…` hold
  each decision with its main request's `answers`, but not the request (`state`, `questions`), and follow-up answers
  only as summaries (`elementRisks`, `targetCheck`). A store keyed by request can't be built from them, so there is no
  trace converter; replay is proven by tests and an offline self-check (step 4).
- **A thrown Ask error doesn't fail every suite.** In `decide`, a failure becomes `ModelCallError` and the run ends
  `blocked` (`run-task.ts:997`), which red-team counts as a safe hand-back; `#lastLook` and `#withEvidence` swallow
  Ask errors. So a miss must be counted out of band, not only thrown.
- **The route depends on keys.** `resolveModel` picks Jev's direct route (`jev-1.14.0`, `assets` images, Box questions)
  only when `TYPESAFE_API_KEY` is set, otherwise OpenRouter (`typesafe/jev-1.14`, `image_url`, no Box). A replay run has
  no key, so it would ask different questions of a different model id and miss every request.

## Design (decided here)

- **Canonical request and key.** `canonicalRequest(request)`: JSON with object keys sorted at every depth; every image
  (an SDK `Image`, whose JSON is `<image:…>`, or an `image_url` part / `data:image/…` URL) becomes the string `<image>`;
  every `127.0.0.1:<digits>` and `localhost:<digits>` becomes `127.0.0.1:<port>` / `localhost:<port>`. The key is the
  sha256 of `{ model, request: canonical }`, so the same page asked of another model never matches. Pixels are left out
  on purpose: the marked screenshot is drawn from the same observed elements the text state lists, and its bytes vary
  run to run; the entry keeps only that a screenshot was there (`<image>`), which is also what keeps files small.
- **Storage: one JSONL file per recording process** (`<dir>/<ISO time>-<pid>.jsonl`), one line per request
  (`{ key, model, request, answer }`), after a header line (`{ header: { profile, model, route, screenshots } }`).
  Chosen over one JSON file per hash because: the same request can recur in a run (a WAIT on an unchanged page, run 2
  of 3 starting on the same page) with a different live answer, and a file per process keeps every answer in the order
  given, where a file per hash would overwrite or need its own list; the MCP child of `pnpm verify` records into its own
  file, so two processes never write the same file; and a whole run is one file to keep, copy, diff or delete instead
  of thousands. Replay reads every `*.jsonl` in the folder.
- **Repeated requests** replay their answers first in, first out, and then keep repeating the last one.
- **The recorded route wins in replay.** In `replay` mode `resolveModel` takes its defaults from the store's header:
  the model profile (unless `JEVWAY_MODEL` names one) and the screenshot mode (unless `JEVWAY_SCREENSHOTS` is set), and
  the direct route when the header says `direct`, with no key needed. `createAsk` in replay mode never checks a key.
  A replay folder with no recordings is an error at start, not a run of misses.
- **A miss** throws `ReplayMiss` whose message names the request (its goal, cut to 80 characters, and the step: the
  number of recent actions + 1, and the kind: `decision`, `evidence`, or `follow-up (<question ids>)`) and a short diff
  against the nearest recorded request with the same goal (any recorded request when none shares it): up to 8 changed
  leaf paths, then up to 6 page-text lines only recorded and 6 only now, each cut to 120 characters. It also writes one
  line to stderr starting `replay miss:`; `verify:replay` counts those lines per suite, because a suite can end a
  missed run as a pass (a `blocked` hand-back) or never surface it (`#lastLook`, `#withEvidence`).
- **Latency:** replayed answers return at once; the summary's `jev.median_latency_ms` is then replay latency.
  `verify:replay` says so in its output. `replayed: true` is not added to the summary: that means editing
  `run-task.ts`, which another executor owns this round.
- **`pnpm verify:replay [dir]`** (`verify/replay.ts`, default dir `verify/out/replay/default`): runs the four suites one
  after another, each as a child with `JEVWAY_REPLAY=replay` and `JEVWAY_REPLAY_DIR=<dir>/<suite>`, echoes their output,
  and prints per suite pass/fail and the misses; a suite fails on a non-zero exit or any miss. `--record` runs the same
  suites with `JEVWAY_REPLAY=record` into the same layout (live, spends credits). `JEVWAY_REPLAY_ONLY=gotchas,redteam`
  narrows the suites. Gotchas run only the `normal` profile unless `JEVWAY_GOTCHAS_PROFILES` is set: `churn` (a banner
  every 1.3 s, click effects 300–800 ms late at random) and `slow` change page text with timing, so their replays miss by
  design. `pnpm verify`'s Wikipedia scenario is live and misses too; it is reported as a miss, not hidden.
- **`node verify/replay.ts --self-check`**: the offline proof. A deterministic scripted Ask (no model) drives a short run
  on `verify/fixture/stays.html` in headless Chrome while recording; then a fresh Chrome and a fresh server (a new port)
  replay it. Passes when the replay has zero misses, never calls the scripted Ask, and ends with the same status, steps
  and fixture state.

## Scope

**In scope:**
- `src/jev/replay.ts` (new): mode and folder from the environment, canonical request and key, recording Ask,
  replaying Ask, miss diff, recorded route.
- `src/jev/model.ts`: the hook in `createAsk`, and recorded-route defaults in `resolveModel` in replay mode.
- `test/replay.test.ts` (new).
- `verify/replay.ts` (new), `package.json` script `verify:replay`.
- `AGENTS.md` Commands, `README.md` Verify section.

**Out of scope:**
- Forgejo, signup, checkout, Langfuse, real-world, Vikunja and agent suites (their pages carry CSRF tokens, timestamps,
  session ids; follow-up).
- A converter from old traces (they lack requests; see Current state).
- Any change to `decide.ts`, `run-task.ts`, guards, thresholds or statuses.

Never read `.env`.

## Git workflow

Branch `wt/exec-replay`. Commits:
1. `docs: add plan 111 recorded jev answers replay offline`
2. `test: recorded jev answers replay offline`
3. `feat: record and replay jev answers offline`
4. `docs: describe verify:replay and the replay variables`

Lowercase conventional commits. **No AI attribution of any kind.** Do NOT push or merge.

## Steps

### 1. Tests first (`test/replay.test.ts`)

- **The key is stable:** the same request with keys in another order, another fixture port, another image reference
  (two `Image.fromBase64` of different bytes) or another `image_url` data URL has the same key; a changed page text line
  or another model id changes it.
- **Record then replay returns the same answer**, for each of two requests, from a fresh replaying Ask reading the
  folder; a request recorded twice with two answers replays them in order, then repeats the last.
- **A miss throws with a diff:** it names the goal, the step and the kind, lists the changed path, and shows the page
  line that is only in the new request; it writes a `replay miss:` line to stderr.
- **Replay never calls the real Ask:** with `JEVWAY_REPLAY=replay`, `createAsk` builds no client (no key set) and a spy
  on the recording path's Ask is never called; the record path calls it once per request.
- **The env switch picks the Ask:** unset → the live Ask (and the missing-key error without a key); `record` → a
  recording Ask that writes a JSONL file with a header; `replay` → answers from the folder with no key set; any other
  value is an error. In replay mode `resolveModel()` with no keys resolves Jev's direct route (`jev-1.14.0`, `assets`,
  Box) from a header that says `direct`.
- **A whole run replays:** a `BrowserTask` on the test file's fake tab with a scripted Jev, recorded, then run again on
  a fresh fake tab with the replaying Ask, ends with the same status, steps and reason, and the scripted Ask is called
  only during recording.

Run red. Commit 2.

### 2. `src/jev/replay.ts` and the hook

As designed above. JSDoc with a usage example and the business rule on exports. `pnpm typecheck` and `pnpm test` pass.

### 3. `verify/replay.ts` and the script

As designed above, including `--self-check`. Run `node verify/replay.ts --self-check` (offline; headless Chrome, no
model). Commit 3.

### 4. Docs

`AGENTS.md` Commands: a `pnpm verify:replay` entry naming `JEVWAY_REPLAY` (`record` | `replay`), `JEVWAY_REPLAY_DIR`,
`--record`, `--self-check`, `JEVWAY_REPLAY_ONLY`, and what misses by design. `README.md` Verify section: a short
paragraph. Commit 4.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` exit 0 at every commit, with the new tests red first
- [ ] `node verify/replay.ts --self-check` passes offline: zero misses, scripted Ask uncalled during replay, same
  status and fixture state
- [ ] no Jev or Claude credits spent; no live suite run
- [ ] `git diff --stat main` lists only the in-scope paths

## STOP conditions

- A stored request contains a secret value (anything but `[secret:<key>]` for a key marked secret).
- Replay mode reaches the network or needs a key.

## Maintenance note

The key ignores pixels and fixture ports, nothing else. A new field that varies between identical runs (a timestamp,
a random id, a CSRF token) turns every request into a miss, and the miss diff names that path: normalise it in
`canonicalRequest`, not by loosening the match. Forgejo, signup and checkout need exactly that (CSRF tokens, relative
times like "2 minutes ago", session ids) before they can replay. A recording is only valid for the code that made it:
a change to what Jev is asked (instructions, questions, page reading) is meant to miss; record again after it.
