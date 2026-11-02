## What this changes

<!-- What a caller or a user sees differently after this PR. Link the issue it closes. -->

## How it was checked

<!-- The tests you added (red first), and any live suite you ran with its result. Live suites are optional: they cost API credits. -->

## Checklist

- [ ] The PR title is a conventional commit (`feat: …`, `fix: …`, `docs: …`): it becomes the squashed commit and sets the next version
- [ ] `pnpm release:check` passes (typecheck, tests, build, package contents)
- [ ] Tests describe behaviour a caller sees, and pass without an API key
- [ ] Docs updated where behaviour changed (README, `docs/reference.md`, `skill/jevway/SKILL.md`, the tool descriptions in `src/mcp.ts`)
- [ ] Model output still only selects observed ids or value keys (see the invariants in `AGENTS.md`)
