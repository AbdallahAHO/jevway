---
name: jev-browse
description: Hand whole browser goals (navigate, search, fill forms, set filters, open a result, book) to TypeSafe Jev through the jev-browse MCP tool `browser_task`, then inspect the result with chrome-devtools. Use when a browser task would otherwise take many click/type/snapshot round trips, or when the user asks to "go to X and do Y" in the browser.
---

# jev-browse: Jev drives, you decide

`browser_task` runs the whole click/type/select loop with Jev (~300ms per step) and returns one JSON summary.
You stay in charge of intent, missing values, irreversible actions, and inspection.

## Split the work

| Need | Tool |
| --- | --- |
| Get to a page state: search, forms, filters, pagination, open a result | `browser_task` |
| Look at it: console, network, performance, Lighthouse, screenshots, DOM details | chrome-devtools (same Chrome; `list_pages` → `select_page` by the summary's `url`) |
| Iframes, shadow DOM, canvas, uploads, popup tabs, drag | chrome-devtools directly |

## Call it well

1. Start with `url` (new background tab) or `tab` (part of an open tab's URL).
2. Write `goal` as the full outcome, including every filter and choice.
3. Put every text value the goal needs into `values` with descriptive keys (`{"destination":"Lisbon","email":"ada@example.com"}`). Jev only types supplied values.
4. Always pass `done_when`: visible evidence of success ("Search results for Lisbon are listed"). DONE is accepted only after this check passes. Describe only what the final page itself shows: "the user from the costliest session is open" can't be judged on a user page, "a user's detail page is open" can.
5. Jev picks elements; it doesn't compare numbers. For "the most expensive", "the one with errors" and the like, call once to reach the list, read it yourself (chrome-devtools or the summary's `page_text`), then continue the same `session` with the chosen value in `values`.
6. Text Jev needs to type, even a filter word like `ERROR`, must be in `values`.
7. Passwords: jev-browse never sees or types password fields. Type them yourself (chrome-devtools `fill`), then say so in the goal: "I typed the password; sign in." A typed field jev-browse can't see only counts once you mention it.

## Read the status

| Status | Do this |
| --- | --- |
| `done` | Trust `url`/`title`. Read `page_text` for what the page shows (the visible part, up to 2500 chars; a cut is marked with how much was left out); scroll with another call or inspect with chrome-devtools for more. |
| `needs_input` | The reason names the field. Get the value (ask the user if unknown) and call again with the same `session` and the new `values`. |
| `needs_confirmation` | The next click looks irreversible (pay, send, delete, submit). Continue with `confirm_irreversible: true` only when the user's own request names this action and its target; for anything else, stop and ask the user. "Delete the repository X" covers every click that deletes X: on Forgejo, the danger-zone button and then the dialog's button, each needing its own confirmation. "Tidy up unused repos", a different repository, or a step the user never asked for (paying while reviewing an order) is not covered: ask first. A kind of thing ("anything unused", "old branches") names no target: list the candidates and ask. Each confirmation covers one click. It counts only on the call that answers a needs_confirmation (or a new session's first call); anywhere else it is ignored. Pass `confirm_target` with the user's words that name the target; jev-browse checks the page shows them (the control's own words, like "delete", do not count) and refuses otherwise. |
| `uncertain` / `blocked` | Read `stuck.candidates` and `page_text`. Rephrase `goal` for the same `session`, or do the step with chrome-devtools and then continue. A `reason` saying the browser dropped a click means nothing was clicked and rephrasing cannot help: call again or check the browser. |
| `step_budget` | Split the goal into smaller calls on the same `session`. |

End with `browser_task_end` when finished (it closes the tab it opened unless `keep_tab: true`).

## Show what happened

Pass `record_dir` on a new session to keep a record for people: a screencast video (`run.mp4`, needs ffmpeg), a sharp 2× screenshot before every action with its target outlined, the final page, `summary.json` and an `index.html` viewer (`open <dir>/index.html`). These shots never reach the model.

## Run without permission prompts

`JEV_BROWSER=auto` attaches to the user's Chrome, which asks them to allow remote debugging. For unattended runs, start a separate Chrome with its own profile instead:

```bash
PROFILE="$SCRATCH/chrome-profile"   # a session scratch folder, never the user's profile
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check about:blank &
until curl -s http://127.0.0.1:9333/json/version >/dev/null; do sleep 0.5; done
```

- jev-browse: `JEV_BROWSER=http://127.0.0.1:9333` (MCP env) or `--browser http://127.0.0.1:9333` (CLI).
- agent-browser shares the same Chrome with `--cdp 9333`; use it for sign-up and login steps, then hand the goal to `browser_task`.
- Logins stay in that profile across runs. Stop only that Chrome: `pkill -f "user-data-dir=$PROFILE"`.
- Keep the window visible (no `--headless`) when a site shows a Cloudflare or captcha check: a real window often clears it on its own. Never try to solve or bypass a challenge; if it still asks, hand the click to the user.
- A sign-up needing an email: use the `disposable-inbox` skill for a throwaway address and its verification code. Only for test or demo accounts the user asked for.
