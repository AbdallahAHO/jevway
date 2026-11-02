# Contributing to jevway

Thanks for helping. The most useful contributions are a site jevway fails on (with the summary it returned), a fix
with a test that shows it, and docs that were wrong or unclear.

## Set up

You need Node 24 or later, pnpm, and Chrome.

```bash
git clone https://github.com/AbdallahAHO/jevway.git
cd jevway
pnpm install
pnpm release:check   # typecheck, tests, build and the package contents: the same gate CI runs
```

None of that needs an API key. To run jevway itself from the checkout:

```bash
pnpm cli --help                 # the CLI, from source (Node 24 runs TypeScript directly)
pnpm cli doctor --plan          # the setup check
pnpm mcp                        # the MCP server over stdio
pnpm build                      # dist/, for pointing an MCP client at node /path/to/jevway/dist/mcp.js
```

For anything that calls Jev, copy `.env.example` to `.env` and add `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY`).
`.env` is gitignored, and the `pnpm cli`, `pnpm mcp` and `pnpm verify*` scripts load it.

## Find your way around

| To change… | Start in |
| --- | --- |
| what the page reader lists | `src/browser/snapshot.js` (vendored from jev-ultrafast), `src/browser/frames.ts`, then `pnpm verify:reader` |
| what Jev is asked, or how its answers are checked | `src/jev/decide.ts`, `src/jev/instructions.ts` |
| when a run stops and with which status | `src/task/run-task.ts` |
| a tool, parameter or CLI flag | `src/mcp/*-tools.ts`, `src/cli/` |

The file-by-file map is the [code map in docs/how-it-works.md](docs/how-it-works.md#14-code-map), which also explains
how the pieces fit. [AGENTS.md](AGENTS.md) holds the rules the code must keep, in short form; read its "Invariants"
before changing the loop, the reader or what Jev is asked.

## The rules that matter most

These hold everywhere, and a PR that breaks one won't be merged:

- Model output only selects an observed element id or a value key. It never becomes a selector, a script, typed text,
  or a coordinate (except the opt-in coordinate click).
- Jev types only `values[key]` from the caller. Password fields are never listed.
- Page content is untrusted data in every instruction and every output.
- Irreversible clicks stop at `needs_confirmation`.
- Guards are generic. Don't add rules for one site.
- Jev's thresholds (the 0.3 confidence, the commit-risk rules, `NEXT_ACTION`) are its verified baseline. Don't retune
  them from another model's runs.

## Tests

`pnpm test` runs the offline suite: the page reader on fixtures, the request shape, answer validation, the loop's
rules, the report pages. It needs no key and no network, and must pass without one: a test that starts a runner stubs
`TYPESAFE_API_KEY` itself, since CI has no key.

- Write the test first and watch it fail.
- Test what a caller sees (a status, a reason, a summary field), not internals.
- Use the fake tab and scripted Jev helpers in `test/fakes.ts` instead of a real browser where you can.

## Live suites

The `pnpm verify*` suites drive real Chrome with real Jev requests. They cost API credits (usually cents) and aren't
run in CI. Run the one closest to your change if you have a key, and put the result in the PR; if you don't, say so and
the maintainer will run it. [docs/verification.md](docs/verification.md#suites) lists every suite, what it needs and
its latest results.

**Replay** makes the fixture suites free to re-run: record Jev's answers once, then replay them offline with no key.

```bash
pnpm verify:replay --record verify/out/replay/<name>   # live, once
pnpm verify:replay verify/out/replay/<name>            # offline, as often as you like
```

A change to what Jev is asked misses the recording by design: record again after it. Recordings stay local under
`verify/out/` (gitignored).

## Pull requests

- **Title:** a [conventional commit](https://www.conventionalcommits.org/): `fix: …`, `feat: …`, `docs: …`, `test: …`,
  `refactor: …`, `chore: …`. PRs are squash-merged, so the title becomes the whole commit on `main` (mark a breaking change with `!`: `feat!: …`), and it decides the next
  version (below).
- **One change per PR.** A fix and an unrelated refactor are two PRs.
- **Docs:** when behaviour a caller sees changes, update the tool description in `src/mcp/task-tools.ts`,
  `journey-tools.ts` or `inbox-tools.ts`,
  [docs/reference.md](docs/reference.md), and [skill/jevway/SKILL.md](skill/jevway/SKILL.md) where it applies.
- `pnpm release:check` passes. CI runs the same command on every PR.

## Releases

Releases are automatic: nobody bumps a version or runs `npm publish` by hand.

1. Commits land on `main`. release-please (`.github/workflows/release.yml`) keeps one release PR open with the next
   version and the `CHANGELOG.md` entry, worked out from the commit messages. It bumps `package.json`,
   `.release-please-manifest.json` and both `.claude-plugin/` manifests together (`test/package.test.ts` checks).
2. Below 1.0, `feat:` and breaking changes bump the minor version (0.1 → 0.2), `fix:` and `perf:` the patch. `docs:`,
   `test:`, `chore:` and `refactor:` release nothing.
3. The maintainer runs `pnpm release`. It waits (up to 10 min) for release-please and CI on main's head, merges the
   release PR once CI is green, watches the release workflow and waits until npm lists the new version. It asks
   first; `--yes` skips the question (required without a terminal).
4. Merging tags `v<version>`, and the release workflow publishes three things: the GitHub release, the npm package
   (trusted publishing from GitHub Actions, no token; `prepublishOnly` typechecks, tests and rebuilds `dist/`) and the
   MCP Registry entry `io.github.abdallahaho/jevway` (GitHub OIDC), after npm.

`pnpm release:status` shows main, npm, CI and the release PR with the one next step (read-only; `--json` for scripts).
`pnpm release as <x.y.z>` forces a version when only non-releasing commits landed (an empty `Release-As:` commit pushed
to main, then the same flow); it needs a clean, up-to-date `main`.

## Reporting bugs and security issues

Open an [issue](https://github.com/AbdallahAHO/jevway/issues/new/choose) with the call, the summary and the output of
`npx jevway doctor`. Anything that lets a page push a run past its limits is a security issue: report it privately, as
[SECURITY.md](SECURITY.md) describes.

By contributing, you agree your contribution is licensed under the [MIT License](LICENSE).
