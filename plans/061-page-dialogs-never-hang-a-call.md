# Plan 061: A page's native dialog (confirm, alert, beforeunload) is answered safely and never hangs a call

> **Executor instructions**: Follow this plan step by step. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 65202a4..HEAD -- src/browser/tab.ts src/browser/cdp.ts` must be empty. Plan 056 or 060
> may have changed `act` or `SETTLE` in `tab.ts`; then check that `#evaluate`, `observe()` and `attach()` are as quoted below. Otherwise STOP.

## Status

- **Priority**: P0 · **Effort**: M · **Risk**: MED (answers page dialogs; changes how browser errors surface) · **Category**: bug, safety (gate R4)
- **Planned at**: commit `65202a4`, 2026-10-16

## Why this matters

In the real-agent suite (gate R4), chore `triage` was 0/2. In both runs the agent's first `browser_task` call never returned, and
the harness killed it after 6 minutes. The tool result reads "Connection closed", but that is only the harness closing
the transport. The 2026-10-16 diagnosis reproduced it on the seeded Forgejo and on a local fixture.

1. **The trigger.** Forgejo's issue sidebar saves the labels and **reloads the page** when the Labels dropdown closes. If
   the comment box already holds typed text, the page first opens a native dialog. It is
   `confirm("Page will be reloaded, but there are draft comments. … Continue?")`, or in other timings the browser's
   `beforeunload` prompt. Jev ticked "bug", clicked into the comment box (which closes the dropdown) and typed within
   about 50–500 ms, so the dialog opened. Native dialogs are common on any site: "Leave site? Changes you made may not
   be saved", `confirm("Delete?")`, `alert("Saved")`.
2. **Nothing answers the dialog.** `src/` has no `Page.javascriptDialogOpening` listener and never calls
   `Page.handleJavaScriptDialog`. An open dialog blocks the renderer:
   - `Runtime.evaluate` and `Page.captureScreenshot` never answer;
   - `Input.dispatchKeyEvent` waits until the 30 s CDP timeout.
3. **A stuck page becomes a 12-minute hang.** `Tab.#evaluate` turns every `CdpError` into `StalePage`, including
   "Runtime.evaluate timed out after 30000 ms". `Tab.observe()` retries `StalePage` 25 times, so one `observe()`
   behind a dialog takes up to 25 × 30 s, although its own error message says "Page did not settle within 1s". On a fixture,
   `observe()` was still running at 75 s. So `browser_task` has no deadline at all while a dialog is open.

Scratch repros from the diagnosis, in `/private/tmp/claude-501/-Users-abdallah-Developer-playground-jev-browse/250e679b-29ea-4317-9eda-728b627ef14c/scratchpad/triage-diagnosis/`:

| Repro | What it does | Needs |
|---|---|---|
| `observe-hang.ts` | Shows `observe()` looping on 30 s timeouts behind a confirm | Local fixture, about 75 s |
| `dialog.ts` | Shows that evaluate and screenshot hang, and that `Page.handleJavaScriptDialog` frees them | Local fixture |
| `labelreload.ts [iterations] [msBeforeTyping] [notype]` | Opens Labels, ticks bug, clicks the comment box and types; typing at once opens a dialog almost every time | The seeded Forgejo |
| `triage-repro.ts` | The instrumented replay of the agent's call through `createRunner`/`BrowserTask` | The seeded Forgejo |

They are scratch files: read them for the technique and don't commit them.

**Safety rule for answering.** Every answer must be the one that changes nothing:
- `alert` → OK, its only button.
- `confirm` and `prompt` → Cancel.
- `beforeunload` → Stay on the page.

Never answer OK to a confirm. It might be "Delete this repository?", or here "discard the draft comments". Whether a
confirmed click (`confirm_irreversible`) may also answer OK to the native confirm it opens is a contract question for
the user. It is out of scope; see the maintenance notes.

## Current state

`src/browser/tab.ts`:

```ts
  static async attach(cdp: CdpConnection, targetId: string): Promise<Tab> {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, targetId, sessionId);
    await tab.#call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await tab.#call('Page.enable');
    await tab.#call('Page.addScriptToEvaluateOnNewDocument', { source: INPUT_COUNTER });
    …
  }

  onEvent(listener: CdpListener) {           // per-tab protocol events (filters on this.sessionId)
    return this.cdp.onEvent((method, params, sessionId) => { if (sessionId === this.sessionId) listener(method, params, sessionId); });
  }

  async observe(): Promise<PageState> {
    await this.#settleAfterInput();
    for (let attempt = 0; attempt < 25; attempt++) {
      try { const state = await this.#evaluate(`…${READ_STATE}`); if (state) return { …state, fingerprint: fingerprint(state) }; }
      catch (error) { if (!(error instanceof StalePage)) throw error; }
      await sleep(40);
    }
    throw new StalePage('Page did not settle within 1s');
  }

  async #evaluate(expression: string): Promise<any> {
    const response = await this.#call('Runtime.evaluate', { expression, returnByValue: true }).catch((error) => {
      throw error instanceof CdpError ? new StalePage(error.message) : error;
    });
    …
  }
```

- `src/browser/cdp.ts`: `send` rejects with `new CdpError(`${method} timed out after ${CALL_TIMEOUT_MS} ms`)`.
  `CdpError` also covers protocol errors such as "Cannot find context with specified id" during a navigation. Those
  really are stale pages and must stay `StalePage`.
- `src/task/run-task.ts`: "Browser and model errors end the run as `blocked`". An error that is not a `StalePage`
  escapes the loop and becomes `blocked` with "Browser error: …". `this.#history` holds `StepRecord`s
  (`{ operation, element, page_changed?, … }`). Read how the automatic `dismissPopup` pushes its own history entry:
  a fixed action reported to Jev.
- `verify/agent.ts` starts `claude` with `'-p', prompt, '--mcp-config', config, …, '--output-format', 'stream-json'`. The
  per-run `claude-stderr.log` is empty because `claude -p` logs nothing without a debug flag.

## Scope

**In scope:**
- `src/browser/tab.ts`: dialog answering, the timeout mapping and `observe()`'s deadline.
- `src/task/run-task.ts`: reporting dialogs to Jev and the repeat hand-back.
- `test/jev-browse.test.ts`.
- `verify/reader.ts` and `verify/fixture/reader/dialogs.html` (new).
- `verify/agent.ts`: the debug-log flag only.
- `AGENTS.md`: one invariant line.

**Out of scope:**
- The `confirm_irreversible` contract and `src/mcp.ts`.
- `cdp.ts` timeouts (`CALL_TIMEOUT_MS`).
- Forgejo's suite.

Never run `apps:forgejo:down`, and use the Forgejo stack only when your reviewer says it's free. Never touch the Chromes on 9333 and 9444.
Never read the gitignored `.env`.

## Git workflow

Commits:
1. `test: a page dialog is answered and a stuck page fails fast`
2. `fix: answer page dialogs with the choice that changes nothing`
3. `fix: a browser call that times out is not a stale page`
4. `test: keep the calling agent's debug log per run`

No AI attribution. Do NOT push.

## Steps

1. **Tests first.**
   - **Reader fixture `dialogs.html`:**
     - a button "Discard draft" whose click runs `window.__fixture.answer = confirm('Discard the draft?')`;
     - a button "Notice" that runs `alert('Saved'); window.__fixture.afterAlert = true`;
     - a textarea plus a `beforeunload` handler that calls `preventDefault()` while the textarea is non-empty, and a
       button "Reload" that calls `location.reload()`.
   - **Reader check `'a page dialog is answered with the choice that changes nothing'`:**
     - acting on "Discard draft" resolves within 5 s, `answer === false`, and the tab's dialog record holds
       `{ type: 'confirm', message: 'Discard the draft?', accepted: false }`;
     - "Notice" sets `afterAlert`, and its record says `accepted: true`;
     - type into the textarea (fill with a value), act on "Reload": the textarea still holds the text (the page stayed),
       and the record says `beforeunload`, `accepted: false`;
     - `tab.observe()` works after each step.
   - **Unit tests:**
     - With a fake CDP connection whose `send('Runtime.evaluate')` rejects with
       `new CdpError('Runtime.evaluate timed out after 30000 ms')`, `observe()` rejects **once**, with an error that is
       **not** a `StalePage`. A protocol `CdpError` such as "Cannot find context with specified id" is still retried as
       stale. If `Tab`'s private constructor makes this awkward, add a minimal test-only path, or test `#evaluate`'s
       mapping through `Tab.attach` with a fake `CdpConnection`. Report which you chose.
     - In `run-task` with the `scriptedJev`/`fakeTab` pattern: after a CLICK, the fake tab reports one answered confirm.
       Jev's next request carries it in history: the clicked step's `element` gains
       ` (the page then asked "<message>" in a confirm dialog; answered Cancel)`.
     - The same confirm message a second time in one run ends `blocked` with the reason
       `The page keeps asking "<message>" (confirm dialog). jev-browse only answers Cancel to these; ask the user how to proceed.`

   Run them red. Commit 1.

2. **Answer dialogs.**
   - In `attach`, after `Page.enable`, subscribe through `onEvent` to `Page.javascriptDialogOpening`. Answer at once:
     `Page.handleJavaScriptDialog({ accept: type === 'alert' })`. Don't await it inside the event handler in a way that
     can throw unhandled; catch and ignore errors.
   - Push `{ type, message, accepted }` onto a list the run drains with a `takeDialogs()` method.
   - One comment marked `// jev-browse:`: an open dialog freezes the page for every protocol call, so it is answered at
     once, always with the choice that changes nothing (OK only for an alert, its only button).
   - In `run-task.ts`, after each executed action, drain `takeDialogs()`. Append the note to that step's history `element`,
     and keep a per-run count by message. The second occurrence of the same message ends `blocked` with the reason
     above. Also drain at the start of the run and before stops, so nothing is lost; a dialog seen while the run
     observes counts like one after a step.
   - Reader and unit tests from step 1 → pass. Commit 2.

3. **A timeout is not a stale page.**
   - In `#evaluate`, a `CdpError` whose message matches `/timed out after/` is rethrown as is (not `StalePage`). Other
     `CdpError`s stay `StalePage`.
   - Give `observe()`'s retry loop a wall-clock deadline of 2 s on top of the 25 attempts, and make its message say the
     time it really waited.
   - Check `navigate()`'s loop too: its `.catch(() => null)` swallows timeouts. Make it stop at its 15 s deadline even
     when one evaluate takes 30 s, by checking the deadline after each await, and report what you changed.
   - One comment: a page that stops answering (a frozen renderer) must end the call as a browser error, not spin as
     "changed".
   - `pnpm test` and `pnpm typecheck` → pass. Commit 3.

4. **Harness.** In `verify/agent.ts`, add claude's debug log per run. Run `claude --help | rg -i debug` first.
   - If a `--debug-file <path>` flag exists, pass `<runDir>/claude-debug.log`.
   - Otherwise add `--debug` and let the existing stderr capture take it.

   `pnpm typecheck` → pass. Commit 4.

5. **AGENTS.md**, one invariant line, folded into commit 2: `A page's native dialog is answered at once with the choice
   that changes nothing (OK for an alert, Cancel for confirm/prompt, Stay for beforeunload) and reported to Jev; the
   same dialog twice in a run is handed back (blocked). A protocol call that times out ends the run as a browser error.`

6. **Measure**, headless:
   - `pnpm verify:reader` → all pass; `pnpm verify` → 8/8; `pnpm verify:gotchas` strict; `pnpm verify:redteam` →
     `violations: 0`.
   - The local `observe-hang` scenario on the new code: the call ends within 35 s, against 75 s or more before.
   - When your reviewer says Forgejo is free:
     - `labelreload.ts 5 0` against the new code. Each iteration's dialog is answered, and no CDP call is outstanding
       for more than 5 s.
     - The triage chore: `JEV_AGENT_RUNS=3 JEV_AGENT_ONLY=triage pnpm verify:agent`. Report each run's outcome and
       duration, every dialog in the trace, and whether `claude-debug.log` has content.

## Done criteria

- [ ] `pnpm typecheck` and `pnpm test` exit 0, with the new tests red first; reader all pass; `pnpm verify` 8/8; red-team 0 violations
- [ ] gotchas strict; triage ×3 reported, with no call longer than 3 minutes
- [ ] `git diff --stat` lists only in-scope paths

## STOP conditions

- Any path where jev-browse would answer OK to a `confirm`, `prompt` or `beforeunload`.
- The Forgejo repro still shows a CDP call outstanding for 30 s with the dialog answered: report the call and the page state.
- gotchas strict drops on any profile.

## Maintenance notes

- **Open question for the user:** may a click the caller confirmed (`confirm_irreversible`) also answer OK to the native confirm
  it opens, for example a delete button guarded by `confirm()`? Today such a job hands back after the second ask. That
  is safe, but it can't finish those flows.
- If a site relies on `prompt()` for input, it hands back too. jev-browse never types into a dialog.
- A wall-clock cap per `browser_task` call is the remaining defence in depth if another unbounded wait appears.
