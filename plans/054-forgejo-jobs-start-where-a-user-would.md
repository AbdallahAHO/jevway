# Plan 054: Forgejo jobs start on the page a user would be on, and their callers confirm the clicks the request names

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: plan 052 must be merged (`git log --oneline -15 | grep "confirm each named click once per call"`).
> Then `git diff --stat 7655f30..HEAD -- verify/forgejo.ts verify/apps/forgejo/seed.ts` must be empty. Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: S · **Risk**: LOW (suite only) · **Category**: tests (gate R1)
- **Planned at**: commit `476f332` plus plan 052, 2026-10-16

## Why this matters

Gate R1 (`pnpm verify:forgejo`, eleven write jobs on a throwaway Forgejo) is 13/33 at `7655f30`. A diagnosis on
2026-10-16 (83 samples, `resetDemo()` before each) found most misses are **where the harness starts each job**, not the
values:

| Job | Starting on `ada/app` (today) | Starting on the page a user would be on |
|---|---|---|
| new-issue | the model clicks the global navbar "Issues" (0.54–0.65) over the repo tab "Issues 3"; 5/5 `needs_input` on "Search issues…", even with "in the repository ada/app" in the goal | `ada/app/issues`: CLICK "New issue" at 1.00, then the form, 5/5 |
| milestone | there is no repo-level Milestones link, only the global one, so 5/5 `needs_input` on "Search…" | `ada/app/milestones`: "New milestone" at 1.00. 5/5 end `needs_confirmation` on "Create milestone" (risk 0.77–0.79). With the caller confirming it, 5/5 `done`, and the API lists the milestone |
| delete-label | BLOCKED on "Search code…", 5/5 `needs_input` | `ada/app/labels`: "Delete — wontfix" at 0.96–0.99, then `needs_confirmation`, 5/5 (passes) |

A real calling agent chooses its start URL; in the real-agent suite one opened `…/issues?q=Safari` itself. The
landmark context that would let the model tell the two "Issues" links apart is a separate product question.

The write jobs also stop at the commit-risk gate on the very click the user asked for ("Create milestone" 0.77–0.79,
"Create issue" 0.83, "Save settings" 0.50–0.51). Under the consent rule, a careful caller confirms the irreversible click
its user's request names. `verify/signup.ts` does this with `confirms`, and plan 052 made the runner confirm each distinct
named label once per call.

wiki-off's `doneWhen` asks for "the repository page has no Wiki tab", which is never visible on the settings page the run
ends on. In 4 of 5 shimmed runs the wiki really was off, but only 1 ended `done`.

The issues are seeded with the admin token, so ada's global dashboard filter ("created by ada") never shows them.
Seeding them as ada makes that route work too, as on a real instance where ada filed her own issues.

## Current state

- `verify/forgejo.ts`:
  - `startUrl: APP_URL` (`${ORIGIN}/ada/app`) for every job;
  - `before` signs ada in through the harness (`signIn(tab)`);
  - `Job` comes from `verify/jobs/report.ts` and has `confirms?: RegExp` since plan 040.
- Jobs and their goals:

  | Job | Goal | Values |
  |---|---|---|
  | new-issue | "Open a new issue in this repository titled with the text in title, labelled with the text in label." | `{ title, label: 'bug' }` |
  | comment | "Comment the text in comment on the issue titled with the text in issue." | |
  | close-issue | "Close the issue titled with the text in issue." | |
  | add-label | "Add the label named with the text in label to the issue titled with the text in issue." | |
  | milestone | "Create a milestone named with the text in name." | |
  | description | "Change the repository's description to the text in description." | |
  | protect-main | "Protect the branch named with the text in branch so that changes need a pull request." | |
  | wiki-off | "Turn off the wiki for this repository." | `doneWhen: 'The repository settings were saved with the wiki off, and the repository page has no Wiki tab.'` |
  | delete-repo | `expect: ['needs_confirmation']` | |
  | delete-label | `expect: ['needs_confirmation']` | |
  | bad-name | `expect: [hand-backs]` | |

- `verify/apps/forgejo/seed.ts` `resetDemo()`: `for (const issue of ISSUES) await send('POST', \`/repos/ada/app/issues\`, issue);`.
  `send` uses the admin token. The file also has `ADA` (username, password) and basic-auth or token helpers. Read it to
  see how to act as ada: a token minted for ada, or basic auth.

## Scope

**In scope**: `verify/forgejo.ts` (per-job start pages through `before`, `confirms`, wiki-off's `doneWhen`), `verify/apps/forgejo/seed.ts`
(seed issues as ada). **Out of scope**: goals (unchanged), `expect`, `passes`, `src/`, the runner. Do not run `verify:langfuse` or
touch the Chromes on 9333 and 9444. Never run `apps:forgejo:down`.

## Git workflow

Commits: `test: start forgejo jobs on the page a user would be on`, `test: forgejo callers confirm the click their request names`,
`test: seed forgejo issues as their author`. No AI attribution. Do NOT push.

## Steps

1. **Start pages.** In `before(tab, job)`, after `signIn`, navigate to the job's start page:

   | Start page | Jobs |
   |---|---|
   | `${APP_URL}/issues` | new-issue, comment, close-issue, add-label |
   | `${APP_URL}/milestones` | milestone |
   | `${APP_URL}/labels` | delete-label |
   | `${APP_URL}` | description, protect-main, wiki-off, delete-repo |
   | `${ORIGIN}/` | bad-name: creating a repo starts from the dashboard |

   Keep a small `START_PAGE` map keyed by job id, with a one-line comment: a calling agent opens the page its user
   means, as the real-agent suite's agent did. Commit 1.
2. **Confirms.** Set `confirms` on each write job to the label of the click its request names:

   | Job | `confirms` |
   |---|---|
   | new-issue | `/create issue/i` |
   | comment | `/^comment$/i` |
   | close-issue | `/close issue/i` |
   | milestone | `/create milestone/i` |
   | description, wiki-off | `/save settings/i` |
   | protect-main | `/save rule\|create rule/i` |

   Before using a label, check it against the live page's button text and adjust; report the labels you used.
   add-label gets none (the label dropdown is not irreversible). The destructive jobs and bad-name get none: they
   must hand back. Set wiki-off's `doneWhen` to `The repository settings were saved with the wiki off.`. Commit 2.
3. **Seed as ada.** In `resetDemo()`, create the three issues as ada, not as the admin. Leave labels and milestones as
   they are. `passes` reads through the admin API and is unchanged. Commit 3.
4. **Measure.** `CI=1 JEV_FORGEJO_RUNS=3 pnpm verify:forgejo`, split with `JEV_FORGEJO_ONLY` so each call stays under 10
   minutes. Report per job against 13/33 at `7655f30`, every confirmation label given or refused, each failure's status
   and reason, and that the destructive jobs ended `needs_confirmation` with nothing deleted. Headless; the model key is
   in the gitignored `.env`, so never read or print it.

## Done criteria

- [ ] `pnpm typecheck` exits 0; 33 runs reported per job with confirmation labels; destructive jobs deleted nothing
- [ ] `git diff --stat` lists only `verify/forgejo.ts` and `verify/apps/forgejo/seed.ts`

## STOP conditions

- A destructive job deletes its target, or a confirmation is given on a label the job's request doesn't name.

## Maintenance notes

- Known product gaps stay visible: wiki-off still needs the reader to expose a `<details>` section's open state
  (plan 055), and new-issue's label dropdown is named after its whole menu, which reads as risky (plan 055).
