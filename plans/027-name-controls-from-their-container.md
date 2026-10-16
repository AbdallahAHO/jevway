# Plan 027: A control with no name, row or icon is named from its small container's text

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat db7e5f8..HEAD -- src/browser/snapshot.js verify/reader.ts verify/fixture/reader/`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (changes labels the model sees, only for controls that today are labelled by their bare role)
- **Depends on**: none (plan 022 added the fallback this extends; DONE)
- **Category**: bug
- **Planned at**: commit `db7e5f8`, 2026-10-16

## Why this matters

jev-browse lists page controls for the model by role and label (vendored reader `src/browser/snapshot.js`). A control
with no accessible name falls back to row context (checkboxes in a table row), then to plan 022's `contextName` (a
hidden input's own name, the control sharing its `aria-controls`, an icon hint), and finally to its bare role. Probed on
eight Langfuse demo pages on 2026-10-16 with the reader:
- **Filter sidebar value toggles** (Traces, Observations): 6 per page listed as `checkbox "checkbox"`. Each is a Radix
  checkbox `<button type="button" role="checkbox" value="on" id="name-chat">` whose value text ("chat 220") sits in a
  sibling `<div>`; the checkbox's parent's text is exactly `chat 220`. The model can't tell the six apart — and
  `trace-to-prompt` has drifted into these facets before.
- **Pagination page box** (every list page): listed as `spinbutton "spinbutton"` and `"Open spinbutton"`. It's an
  `<input>` between `Page` and `<span>of 30</span>`; its parent's text is `Page of 30`.
A person reads the text right around the control. When nothing else names it, the reader should too: `Select: chat 220`,
`Page of 30`.

## Current state

- `src/browser/snapshot.js` (vendored; local edits marked `// jev-browse:`). The label fallback (from plan 022):
  ```js
              : name(e).replace(/\s+/g, ' ').trim()) ||
            contextName(e, hiddenInput) ||
            rname,
  ```
  and before it, for unnamed checkboxes/radios/switches, `unnamedToggle(e, rname) ? rowContext(e) : …` where
  ```js
  const rowContext = (e) => {
    const text = (e.closest('tr,[role="row"],li,label')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return text && 'Select: ' + text;
  };
  const contextName = (e, hiddenInput) => {
    const own = hiddenInput ? name(hiddenInput).trim() : '';
    if (own) return own;
    const controlled = e.getAttribute('aria-controls');
    if (controlled) { … return 'Toggle ' + … }
    const icon = [e, ...e.querySelectorAll('svg,i,span,img')].map(iconHint).find(Boolean);
    return icon ? icon.replace(/-/g, ' ') + ' icon' : '';
  };
  ```
  `name()` and `cache.guard` must not change (the guard feeds the freshness check; named controls keep their labels).
- `verify/reader.ts` model-free checks (`{ name, file, run }`, helpers `listed`, `find`, `controls`, `labelsOf`,
  `fixtureState`); 30 pass today. Plan 022's check `'an icon-only button is named from its icon; named controls keep their
  names'` asserts no listed control's label equals its role on `unnamed-controls.html`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Snapshot syntax | `node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"` | exit 0 |
| Reader suite (keyless) | `env -u TYPESAFE_API_KEY pnpm verify:reader` | `N/N reader checks passed` |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Grafana | `pnpm verify:grafana` | 23–24/24 lately |

## Scope

**In scope**: `src/browser/snapshot.js` (`contextName` and, if needed, `rowContext`), `verify/reader.ts` (new checks),
`verify/fixture/reader/container-names.html` (new).

**Out of scope**: `name()`, `cache.guard`, roles, which controls are listed, `tab.ts`, `src/jev/*`. Do not run
`verify:langfuse` or touch the Chrome on port 9333 (your reviewer measures Langfuse after merging).

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: add fixtures for controls named only by their container`
  2. `fix: name a control from its small container's text when nothing else names it`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Fixture and checks (red first)

`verify/fixture/reader/container-names.html`, `window.__fixture = { facets: [], page: '1' }`:
1. A filter sidebar copied from the Langfuse markup: three rows, each
   `<div class="row"><button type="button" role="checkbox" aria-checked="false" value="on" id="name-chat" style="width:16px;height:16px"></button><div class="label"><span>chat</span> <span>220</span></div></div>`
   (values `chat 220`, `step 220`, `qa-chatbot 65`). A click toggles `aria-checked` and pushes/removes the value in
   `__fixture.facets`.
2. A pager: `<div class="pager"><span>Page</span><input type="number" value="1" style="width:48px"><span>of 30</span></div>`;
   an `input` listener sets `__fixture.page`.
3. A guard case that must **not** take container text: a `<div>` holding a long paragraph (over 80 characters) and an
   unnamed `<button type="button" style="width:16px;height:16px"></button>` → this one stays labelled `button`.
Checks in `verify/reader.ts`:
- `'unnamed filter toggles are named from the text beside them'`: checkboxes labelled exactly `Select: chat 220`,
  `Select: step 220`, `Select: qa-chatbot 65`; `act` on `Select: step 220` → `__fixture.facets` is `['step 220']`.
- `'an unnamed page box is named from the text around it'`: a `spinbutton` labelled `Page of 30` (and its `Open Page of 30`
  click entry); filling it through `act` with text `3` sets `__fixture.page === '3'`.
- `'a long container does not name a control'`: the guard button is labelled `button`.

**Verify**: `env -u TYPESAFE_API_KEY pnpm verify:reader` → the first two new checks fail, the third passes, the 30
existing pass. Commit 1.

### Step 2: Container text as the last fallback

In `contextName`, after the icon hint and before returning `''`, add: the text of the control's parent, or failing that
its grandparent (stop at two levels), whitespace-collapsed, when it is 1–80 characters long. For an unnamed
checkbox/radio/switch (`unnamedToggle(e, rname)` is true), return it as `'Select: ' + text` (the same form as
`rowContext`); for anything else, return the text as is. Pass `rname` into `contextName` if you need it. Add a
`// jev-browse:` one-line comment: with no name, row or icon, a control is named by the short text right around it, as
a person reads it.

Make sure the toggle path reaches `contextName`: today an unnamed toggle's label is `rowContext(e)` and only falls
through to `contextName` when that is empty — keep that order (row context first).

**Verify**: snapshot syntax → exit 0; reader **33/33** keyless; `pnpm test` → all pass. Commit 2.

### Step 3: Measure

1. `pnpm verify` → 8/8; `pnpm verify:grafana` (24 runs, headless) → report (lately 23–24/24).
2. Re-run plan 022's probe on Grafana if you wrote one, or this quick check: on `https://play.grafana.org/dashboards`
   and `https://play.grafana.org/alerting/list`, the reader lists no control whose label equals its role — report the
   count and any new `Select: …`/container labels (save the script in `$TMPDIR`, outside the repo; headless Chrome via
   `connectChrome('launch-headless')`).
Headless Chrome only. The model key is in the gitignored `.env`, loaded by the npm scripts; never read or print it.

## Test plan

Two model-free checks copied from real Langfuse markup (red first), one guard check that long containers don't name
controls, and the existing 30 checks unchanged. Live Grafana and `pnpm verify` as regression guards; your reviewer
re-probes Langfuse after merging.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; reader 33/33 keyless, the two naming checks red at commit 1
- [ ] `pnpm verify` 8/8; Grafana reported; Grafana probe counts reported
- [ ] `git diff --stat db7e5f8..HEAD` lists only the three in-scope paths

## STOP conditions

- Any existing reader check fails after step 2 (a named control's label changed).
- The fix seems to need a change to `name()` or `cache.guard`.
- Grafana drops below 22/24.

## Maintenance notes

- The container fallback is the last resort, after the accessible name, row context, a hidden input's name, an
  `aria-controls` partner and an icon hint. The 80-character cap keeps it to tight wrappers (a label row, a pager),
  never a whole panel.
