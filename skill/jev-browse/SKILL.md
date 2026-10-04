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

1. Write `goal` as the full outcome, including every filter and choice.
2. Put every text value the goal needs into `values` with descriptive keys (`{"destination":"Lisbon","email":"ada@example.com"}`). Jev only types supplied values.
3. Always pass `done_when`: visible evidence of success ("Search results for Lisbon are listed"). DONE is accepted only after this check passes.
4. Start with `url` (new background tab) or `tab` (part of an open tab's URL).

## Read the status

| Status | Do this |
| --- | --- |
| `done` | Trust `url`/`title`; inspect with chrome-devtools if the user needs details. |
| `needs_input` | The reason names the field. Get the value (ask the user if unknown) and call again with the same `session` and the new `values`. |
| `needs_confirmation` | The next click looks irreversible (pay, send, delete, submit). Continue with `confirm_irreversible: true` only if the user asked for that action. It covers one click. |
| `uncertain` / `blocked` | Read `stuck.candidates` and `stuck.page_text`. Rephrase `goal` for the same `session`, or do the step with chrome-devtools and then continue. |
| `step_budget` | Split the goal into smaller calls on the same `session`. |

End with `browser_task_end` when finished (it closes the tab it opened unless `keep_tab: true`).
