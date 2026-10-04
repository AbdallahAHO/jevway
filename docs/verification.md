# Verification (2026-09-17)

Setup: headless Chrome 152 on macOS (arm64), model `jev-latest` (answered by jev-1.13.0), and `pnpm verify` run three times in a row after the fixes below. Every pass is checked against independent ground truth: the fixture's `window.__fixture` state, read over a separate CDP session, or the page's real URL. Jev's own DONE never counts as proof.

| Scenario | Checked against | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- | --- |
| Fixture: autocomplete → select → checkbox → search → open result (7 actions, 8 Jev requests) | city, guests, filters, and unrequested breakfast filter left off; Casa Flora opened | ✔ 3.22 s | ✔ 3.06 s | ✔ 3.32 s |
| Same session: booking with the email missing → `needs_input` naming "Email address" | booking not confirmed | ✔ 0.90–1.12 s | ✔ | ✔ |
| Same session: email supplied → `needs_confirmation` on "Confirm booking and pay €412" (risk 0.88) | booking **not** confirmed | ✔ 0.61 s | ✔ 0.65 s | ✔ 0.87 s |
| Same session: `confirm_irreversible` → booking done | name, email, `confirmed: true` | ✔ 0.68 s | ✔ 0.60 s | ✔ 0.61 s |
| Live web: Wikipedia search → Gödel's incompleteness theorems | exact `/wiki/…` path | ✔ 2.19 s | ✔ 2.56 s | ✔ 2.42 s |
| MCP stdio: list tools → `browser_task` → `browser_task_end` | status `done`, session ended | ✔ 2.78 s | ✔ 2.77 s | ✔ 3.10 s |

Result: **18/18 passed.** Median Jev latency per request was 256–564 ms (typically about 300 ms). The Wikipedia task used about 40k input tokens, and the full fixture flow about 24k.

Extra check: the built CLI (`dist/cli.js`) on an unseen goal, Wikipedia → Rosetta Stone, finished `done` in 3.3 s (7 requests, done check 0.97).

## Found by the first live run and fixed

1. **Missing value surfaced as `blocked`.** Jev typed the name, then chose BLOCKED for the email. The speculative value heads already showed that no supplied value fit "Email address", so BLOCKED with such fields now returns `needs_input` naming them.
2. **Premature DONE while results were loading.** Jev chose DONE on "Searching…", and the `done_when` check correctly scored it 0.08. A rejected DONE now waits 300 ms and re-decides, up to 3 times, instead of returning `uncertain`.
3. Optional MCP/CLI arguments passed as `undefined` erased defaults, so `max_steps` became undefined.

## Not covered yet

- The `auto` browser mode against a real, logged-in Chrome. It needs the user to approve remote debugging.
- Only one real public site (Wikipedia). There are no heavy SPA sites like Google Flights, and no captcha or consent walls.
- Thresholds are based on this small sample, not on a benchmark.
