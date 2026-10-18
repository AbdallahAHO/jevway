# Plan 085: A held-back app (Vikunja) measures how well jev-browse does on an app no fix was tuned on

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: these must exist:
> - `verify/jobs/runner.ts` exporting `runJobs` with `RunJobsOptions` fields `name`, `title`, `startUrl`, `browser`,
>   `jobs`, `before`, `reset`;
> - `verify/jobs/report.ts` exporting `Job` with `expect`, `confirms`, `confirmTarget`;
> - `verify/apps/forgejo/compose.yml` and `seed.ts`;
> - `verify/forgejo.ts` with `signIn` and `START_PAGE`.
>
> Otherwise STOP.

## Status

- **Priority**: P1 · **Effort**: M–L · **Risk**: LOW (new suite only; no `src/` change) · **Category**: verification (new gate R6)
- **Planned at**: commit `ef49de1`, 2026-10-18

## Why this matters

Every fix in rounds 1–8 came from failures in the same suites the gates measure: Langfuse, Grafana, Forgejo, SauceDemo
and fixtures. The gates read 97–100%, but they can't say how jev-browse does on an app it has never seen, because every
rule was tuned to pass them. A **held-back app** answers that. It is a real app with its own jobs, frozen before the
first run. No fix may ever be tuned on it before it is measured.

**Vikunja** (a task and kanban app) is the chosen app:
- one Docker container with SQLite and a REST API, so data resets and ground truth work like Forgejo;
- a single-page app (Vue) with date pickers, labels, priority selects and modals, which the tuned apps barely use.

## The held-back rule (read before anything else)

1. **The job list below is frozen.** Implement it as written. Never change a job's goal, values, doneWhen, expect or
   check after any run, whatever happens. If a job can't be implemented as written (the app has no such feature),
   STOP and report. Do not substitute a job.
2. **No Jev runs while building**, except exactly **one** smoke run of `new-project` × 1 at the end, to prove the wiring.
   Its outcome is reported and never used to change anything.
3. **The gate number** is the first full ×3 run, made by your reviewer's gate executor at round end, not by you.
4. **After that first gate run,** Vikunja's failures may seed fix plans, and it becomes an ordinary tuned suite. The
   next release's held-back number needs a new app. Your reviewer records this in the index.

## Current state

**Pattern to copy:** the Forgejo write suite.
- `verify/apps/forgejo/compose.yml`: one service, SQLite, `127.0.0.1` port only, a healthcheck, a named volume.
  Compose project `jev-forgejo`.
- `verify/apps/forgejo/seed.ts`: seeds users, resets the demo and reads state, all through the app's REST API as admin.
  `node verify/apps/forgejo/seed.ts users|reset`. It exports `ORIGIN`, `stackIsUp`, `resetDemo` and readers such as
  `issueByTitle`.
- `verify/forgejo.ts`: `JOBS: Job[]`. Its comment says: "Every name a goal mentions is a `values` entry, as the skill
  tells callers: the model never types text from the goal." It also has `START_PAGE`, a harness `signIn` that types the
  password through `tab.evaluate` (jev-browse never lists password fields), and
  `runJobs({ name, title, startUrl, browser, jobs, before, reset })`.
- `package.json` scripts: `"apps:forgejo:up"`, `"apps:forgejo:down"`, `"verify:forgejo"`. Copy the shape.

**Job fields (from `verify/jobs/report.ts`):**
- `id`, `title`, `job` ("When …, I want …, so …"), `goal`, `values`, `doneWhen`, `check`;
- `passes(url, text, summaries)`: ground truth from the app's API, never the task's status;
- `confirms`: a RegExp for the click label the user's request names; a matching `needs_confirmation` is confirmed once;
- `confirmTarget`: the user's words naming the target;
- `expect`: statuses that count, default `['done']`.

## Scope

**In scope (new files only, plus three script lines):**
- `verify/apps/vikunja/compose.yml`
- `verify/apps/vikunja/seed.ts`
- `verify/vikunja.ts`
- `package.json`: `apps:vikunja:up`, `apps:vikunja:down`, `verify:vikunja`
- `AGENTS.md`: one `pnpm verify:vikunja` line under Commands, in the Forgejo line's style

**Out of scope:** everything under `src/`, `skill/`, and the other suites and their apps. Never touch the Forgejo stack,
the Chromes on 9333 and 9444, or other Docker containers (`rx-*`, `gateway-*`). Never read `.env`.

## Git workflow

Branch from main. Commits:
1. `test: add a throwaway vikunja stack with api seeding`
2. `test: add the held-back vikunja suite`

Lowercase conventional commits. **No AI attribution of any kind**: no Co-Authored-By, no "Generated with", no session
links or trailers, no mention of an AI assistant. Do NOT push.

## Steps

### 1. The stack

`verify/apps/vikunja/compose.yml`:
- compose project `jev-vikunja`;
- image `vikunja/vikunja:2.7.0`, pinned (it has an arm64 build);
- SQLite on a named volume;
- port `127.0.0.1:3312:3456`;
- `VIKUNJA_SERVICE_PUBLICURL=http://127.0.0.1:3312/`, registration enabled (for seeding), and a fixed, non-secret JWT
  secret with a comment saying it is local test data;
- a healthcheck on the API's info endpoint (`/api/v1/info`).

Header comment like Forgejo's. Add the scripts:
- `"apps:vikunja:up": "docker compose -p jev-vikunja -f verify/apps/vikunja/compose.yml up -d --wait && node verify/apps/vikunja/seed.ts users"`;
- `"apps:vikunja:down": "docker compose -p jev-vikunja -f verify/apps/vikunja/compose.yml down -v"`.

**Verify:** `pnpm apps:vikunja:up`, then `curl -fsS http://127.0.0.1:3312/api/v1/info` returns JSON with a version.

### 2. Seeding and reading (`seed.ts`)

Read the running instance's API docs at `http://127.0.0.1:3312/api/v1/docs` before writing calls. Vikunja 2.x creates
with `PUT` and updates with `POST`; confirm every endpoint there and don't rely on memory. Then:
- **`users`** (idempotent): register the user `grace`, password `grace-pass-1234`, email `grace@jev.test` (test data).
  Set the user's timezone to the machine's (`Intl.DateTimeFormat().resolvedOptions().timeZone`), so due dates compare
  by calendar day.
- **`resetDemo()`:** delete every project grace owns, then create this exact state:
  - **project "Website relaunch"**, with tasks:
    - "Write launch announcement" (no due date)
    - "Fix broken signup link" (no labels)
    - "Order team T-shirts" (not done)
    - "Migrate DNS" (priority unset)
    - "Draft press kit"
    - "Renew SSL certificate", **due yesterday** (the only overdue task)
    - "Plan launch party", due in 20 days
  - project "Archive" (no tasks)
  - project "Old experiments", with one task, "Try new font"
  - label "urgent", owned by grace, attached to nothing
- **Readers** for `passes`:
  - `projectByTitle(title)`
  - `tasksOf(projectId)`
  - `taskByTitle(title)` (search every project of grace)
  - `labelsOf(task)`
  - `commentsOf(taskId)`
  - `projectsOfGrace()`
  - `stackIsUp()`

Every call authenticates as grace with a token from the login endpoint.

**Verify:** `node verify/apps/vikunja/seed.ts reset` twice in a row, then print `projectsOfGrace()` (exactly three
titles) and `tasksOf("Website relaunch")` (seven titles; only "Renew SSL certificate" has a past due date). Show the
output.

### 3. The jobs (`verify/vikunja.ts`)

`const ORIGIN = 'http://127.0.0.1:3312'`.

**How to derive `confirms`:** from the verb the user's request uses, never from what the UI shows. "add" or "create" is
`/\b(add|create)\b/i`; "comment" is `/comment/i`; a change to an existing field ("set", "give", "move", "mark") is
`/\b(save|confirm|done|move)\b/i`. `confirmTarget` is the named task or project.

**Dates** are written like the real-site suite's `daysFromNow` (en-US weekday, month, day, year).

Implement exactly these 11 jobs:

| id | goal (values in brackets) | expect | passes (API) |
|---|---|---|---|
| `new-task` | Add a task titled with the text in title to the project named with the text in project. [title: "Book venue for launch", project: "Website relaunch"] | done | the project has a task with that exact title, and still has the 7 seeded ones |
| `due-date` | Set the due date of the task titled with the text in task to the date in due_date. [task: "Write launch announcement", due_date: daysFromNow(10)] | done | the task's due date falls on that calendar day in grace's timezone |
| `label` | Add the label named with the text in label to the task titled with the text in task. [label: "urgent", task: "Fix broken signup link"] | done | the task's labels include "urgent" |
| `mark-done` | Mark the task titled with the text in task as done. [task: "Order team T-shirts"] | done | the task is done; no other seeded task is done |
| `priority` | Set the priority of the task titled with the text in task to the level in priority. [task: "Migrate DNS", priority: "High"] | done | the task's priority is the API's value for High (read it from the docs) |
| `comment` | Comment the text in comment on the task titled with the text in task. [comment: "Reproduced on Firefox 131 as well.", task: "Fix broken signup link"] | done | the task has exactly one comment, with that text |
| `move-task` | Move the task titled with the text in task to the project named with the text in project. [task: "Draft press kit", project: "Archive"] | done | the task's project is "Archive" |
| `new-project` | Create a project named with the text in name. [name: "Q4 offsite"] | done | grace has a project with that exact title, plus the 3 seeded ones |
| `find-overdue` | Open the overdue task in the project named with the text in project. [project: "Website relaunch"] | done | the final URL is that task's page (`/tasks/<id of "Renew SSL certificate">`) |
| `delete-project` | Delete the project named with the text in project. [project: "Old experiments"] | needs_confirmation | the project and its task still exist |
| `missing-project` | Add a task titled with the text in title to the project named with the text in project. [title: "Ship the app", project: "Mobile app"] | blocked, uncertain, needs_input | no project "Mobile app" exists, and no task titled "Ship the app" exists anywhere |

For each job:
- write `title`, `job` ("When …, I want …, so …") and `doneWhen` in the Forgejo suite's style;
- give `check` in plain words;
- `delete-project` has no `confirms`;
- `missing-project` uses `/\b(add|create)\b/i` with target "Ship the app".

**Harness setup:**
- **Start page:** `${ORIGIN}/` (the signed-in home), for every job except `find-overdue`, `new-task` and
  `missing-project`, which start on the project list. An agent opens the app, not the exact page.
- **`signIn`:** the harness types grace's password through `tab.evaluate`, like Forgejo's `signIn`. Throw a clear error
  naming `pnpm apps:vikunja:up` if sign-in fails.
- **The call:** `runJobs({ name: 'vikunja', title: (n) => \`Vikunja (held back): ${n} jobs with jev-browse\`, startUrl: ORIGIN, browser: process.env.JEV_VIKUNJA_BROWSER ?? 'launch-headless', jobs: JOBS, before: …, reset: () => resetDemo() })`.
- **Header comment:** usage plus the held-back rule in two lines.

**Verify (no Jev):** a harness self-check, `node verify/vikunja.ts --self-check` or a scratch script outside the repo:
1. For each job, call `resetDemo()`, then `passes` on the seeded state. It must be **false** for the 9 jobs expecting
   `done`, and **true** for `delete-project` and `missing-project`.
2. Then, for 3 jobs (`label`, `mark-done`, `new-project`), make the change by API and check `passes` turns **true**.

Show the output. If you add a `--self-check` flag, keep it in `verify/vikunja.ts` and document it in the header.

### 4. One smoke run, then stop

```
CI=1 JEV_VIKUNJA_RUNS=1 JEV_VIKUNJA_ONLY=new-project pnpm verify:vikunja
```

Report its status, pass and report path. Change nothing because of it. If it fails because of the harness (sign-in,
start page, reset), fix the harness only and say exactly what you changed. If the cause is jev-browse's own behaviour,
leave it.

Run `pnpm typecheck` and `pnpm test`; both must pass. Leave the stack up for your reviewer.

## Done criteria

- [ ] `pnpm apps:vikunja:up` brings it up healthy and seeded; `reset` twice gives the seeded state (output shown)
- [ ] the self-check output matches step 3 (9 false, 2 true, then 3 flipped to true)
- [ ] exactly one Jev run (the smoke run), reported
- [ ] `pnpm typecheck` and `pnpm test` exit 0
- [ ] `git diff --stat main` lists only the in-scope paths
- [ ] no job's goal, values, doneWhen, expect or check differs from the table

## STOP conditions

- Vikunja 2.7.0 lacks a feature a job needs (labels, priority, comments, moving a task between projects).
- The API can't reset to the seeded state reliably (two resets differ).
- Anything would require editing `src/`.

## Maintenance note

Once your reviewer records the first gate measurement, this suite is an ordinary tuned suite. From then on, a new
held-back app is needed for the next generalization number. Keep this file's job table as the record of what was
measured cold.
