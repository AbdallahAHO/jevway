# jevway

MCP server + CLI that hands browser goals to TypeSafe Jev (one `/v1/systemone` decision request per step, plus follow-ups such as the per-click commit-risk question) and returns a short summary to the calling agent.

Humans start at [CONTRIBUTING.md](CONTRIBUTING.md). The full behaviour, with every number, is in [docs/how-it-works.md](docs/how-it-works.md) (HIW below); every parameter and flag is in [docs/reference.md](docs/reference.md). This file is the short form: commands, the rules the code must keep, and gotchas.

## Commands
- `pnpm test`: offline unit tests (vitest), no key, no network
- `pnpm typecheck` / `pnpm build` (emits `dist/`, copies `snapshot.js`)
- `pnpm release:check`: the gate CI runs on every PR and push to `main` (typecheck, test, build, `npm pack --dry-run`)
- `pnpm mcp` / `pnpm cli --help`: run from source (Node ≥24 strips types); both load `.env`. `pnpm cli mcp` is the same server as `pnpm mcp`
- `pnpm cli run|look|journey|sessions|end|inbox …`: one JSON document on stdout, NDJSON events on stderr, exit 0/1/2. Sessions live in a background daemon (`pnpm cli stop`); tests point `JEVWAY_STATE_DIR` at a temp folder
- `pnpm cli doctor [--plan | --json]`, `pnpm cli setup [--client <name> --print]`, `pnpm cli skill [--install <dir>]`. `doctor --live` makes a real Jev request: never in tests
- Live suites (`pnpm verify*`) spend credits and need a key in `.env`: the one list is [docs/verification.md#suites](docs/verification.md#suites). `pnpm verify:replay [--record] <dir>` replays the fixture suites offline; `pnpm report:render <folder>` rebuilds a report offline
- Releases are release-please + `pnpm release`: see [CONTRIBUTING.md#releases](CONTRIBUTING.md#releases). Never bump `version` by hand and never `npm publish` locally

## Layout
The file-by-file map is [HIW §14](docs/how-it-works.md#14-code-map).

## Invariants
A **Noul** is a yes/no question in a Jev request; its answer is a probability from 0 to 1. Each rule links to where it is spelled out.

### What the model may decide
- Model output only selects observed ids or supplied keys; never a selector, coordinate, script or typed text. The one exception is opt-in `allowCoordinateClicks` ([HIW §4](docs/how-it-works.md#4-what-the-model-decides-and-what-code-decides), [§10](docs/how-it-works.md#10-box))
- TYPE_TEXT types only `values[key]`; no fitting value is fed back once, then `needs_input` ([HIW §3](docs/how-it-works.md#3-the-action-space))
- UPLOAD sets only a file declared in `files` (Jev sees key and file name only); a URL file is fetched `https`-only, inside the host rules, from public addresses pinned against rebinding ([HIW §9.10](docs/how-it-works.md#910-files-in-and-out))
- A `totp` code is computed by code at typing time and masked for the session; the model never produces it ([HIW §9.2](docs/how-it-works.md#92-secrets))
- `secret_keys` values reach Jev only as `[secret:<key>]` and are scrubbed from every request, page read, summary, trace and run-folder text and name; images are not masked; never handed to `tab.want` ([HIW §9.2](docs/how-it-works.md#92-secrets))
- Password fields are never listed; only filled/empty is sent ([HIW §2.1](docs/how-it-works.md#21-observe))
- Screenshot marks come only from snapshot rects and are removed before input; recorded (`sharp`) shots never go into a request ([HIW §10](docs/how-it-works.md#10-box), [§13](docs/how-it-works.md#13-recording-and-replay))
- Thresholds are tuned per model: never retune Jev's baseline on another model's data; `GUARDS` are Jev-only provisional values ([HIW §11](docs/how-it-works.md#11-models-and-routes), [§5](docs/how-it-works.md#5-loop-guards))

### Reading the page
- Only visible, enabled, on-screen controls are listed (plus `tab.want` rows holding a supplied value, wide rows, hover-only controls); skeleton placeholders are waited out up to 1.5 s; scrolls fall back to the largest scrollable pane ([HIW §2.1](docs/how-it-works.md#21-observe))
- Frames are read in an isolated world with their own id range; freshness, cover, input counter, settle, Enter and hover run in the target's frame; a slow or failing frame is skipped, never an error ([HIW §9.7](docs/how-it-works.md#97-frames))
- A code split into 4–8 one-character boxes is one `fill` target, typed box by box ([HIW §2.1](docs/how-it-works.md#21-observe), [§2.5](docs/how-it-works.md#25-act-over-cdp))
- `jevway_look` only observes: no Jev request, no input, no ids ([HIW §1.4](docs/how-it-works.md#14-looking-without-acting))

### Acting and loop guards
- PRESS_ENTER only right after typing into a search-like field that still has focus; PRESS_ESCAPE only while something is expanded ([HIW §3](docs/how-it-works.md#3-the-action-space))
- Loop guards are generic, never per site ([HIW §5](docs/how-it-works.md#5-loop-guards))
- Every input is checked fresh against the observation; a stale refusal re-reads and doesn't spend the decision budget ([HIW §2.5](docs/how-it-works.md#25-act-over-cdp))
- A click the page never received ends `blocked` (`InputNotDelivered`) and is never retried ([HIW §2.5](docs/how-it-works.md#25-act-over-cdp))
- Native dialogs get the answer that changes nothing, except the confirmed click's own confirm ([HIW §9.5](docs/how-it-works.md#95-native-dialogs))
- Only tabs the session's tab opened are followed; nothing else is attached, read or closed ([HIW §9.6](docs/how-it-works.md#96-new-tabs))
- Downloads are claimed only from the session's own tab, frames and opened tabs ([HIW §9.10](docs/how-it-works.md#910-files-in-and-out))

### Hand-backs and statuses
- A risky click is `needs_confirmation`; a confirmation needs `confirm_target` shown on the page, allows one click, and only on the flagged control ([HIW §6](docs/how-it-works.md#6-irreversible-actions))
- Cancel and `max_seconds` are checked before every decision and input; an input under way is never aborted ([HIW §9.8](docs/how-it-works.md#98-cancellation-and-time-budget))
- Host lists only narrow, layer by layer; leaving them ends `blocked` without navigating back ([HIW §9.1](docs/how-it-works.md#91-hosts))
- Page errors and sign-in walls stop the run only above their thresholds and after the done checks ([HIW §9.4](docs/how-it-works.md#94-sign-in-walls-and-page-errors))
- A bot wall is judged without a model, never interacted with, and never ends `done` ([HIW §9.3](docs/how-it-works.md#93-bot-walls))
- In a visible browser a wall waits for a person (no Jev request, no input); headless never waits ([HIW §9.9](docs/how-it-works.md#99-waiting-for-a-person))
- `stuck` is recorded in the trace only; nothing reads it ([HIW §2.2](docs/how-it-works.md#22-build-the-request))
- `ask_user` is built from the scrubbed summary, quotes labels, title and URL only, and never pre-fills `confirm_target` ([HIW §8.1](docs/how-it-works.md#81-asking-the-user))

### Finishing
- `done` needs the `done_when` check; every path to it goes through `stopDone` ([HIW §7.1](docs/how-it-works.md#71-how-done-is-decided))
- `checks` are evaluated by code on the final page, never sent to Jev, and override only overridable stops; evidence is a span code cut, copied word for word ([HIW §7.2](docs/how-it-works.md#72-post-processing-on-the-final-page))

### Sessions, output, inbox, setup
- Session ids are full `randomUUID()`s; start-only fields are ignored on a continue; writing output never changes or hangs the outcome ([HIW §13](docs/how-it-works.md#13-recording-and-replay))
- An inbox's password and token never reach a result, error, event, log or Jev; an inbox is not a session ([HIW §1.3](docs/how-it-works.md#13-the-disposable-inbox))
- `jevway setup` writes only on an explicit yes, whole files, never another server's entry ([HIW §1.5](docs/how-it-works.md#15-setup))
- Verification asserts ground truth (`window.__fixture`, an app's API, the URL), never the returned status alone ([verification.md](docs/verification.md))

## Gotchas
- MCP runs on SDK v2 through `serveStdio(createServer)`. Never `server.connect(new StdioServerTransport())`: it serves 2025 clients only. The factory may run twice per connection, so it only builds the server; the runner and the one session service stay at module level in `src/mcp.ts`, and the adapter holds no session state
- `tools/list` and the instructions have ceilings pinned in `test/mcp/server.test.ts`: measure before adding tool text, and state each rule once (shared rules in the instructions, a parameter's rule in its description)
- `@modelcontextprotocol/client` is a dev dependency (tests, `verify/`)
- Tests must pass without a key: stub `TYPESAFE_API_KEY` in tests that start a runner (CI has none). Inbox tests use a fake `fetch`, never the network
- `snapshot.js` is vendored from jev-ultrafast: keep it diffable
- No browser-level `waitForDebuggerOnStart`: it would pause the user's tabs (why followed tabs are set up late, [HIW §9.6](docs/how-it-works.md#96-new-tabs))
- `onStep` / `onEvent` listeners only hear: one that throws is ignored
