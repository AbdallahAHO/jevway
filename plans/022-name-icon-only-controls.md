# Plan 022: Icon-only controls get a name from their icon or the control they toggle

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the
> expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. Your reviewer maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 5822f71..HEAD -- src/browser/snapshot.js verify/reader.ts verify/fixture/reader/`
> On any output, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (changes labels the model sees, but only for controls that today have no name at all)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5822f71`, 2026-10-16

## Why this matters

jev-browse lists the page's controls for the model by role and label (from the vendored reader
`src/browser/snapshot.js`). A control with no accessible name is labelled with its bare role — `button`, `radio` —
so the model cannot tell it apart from its neighbours or know what it does. Probed on 2026-10-16 with the reader on
five Grafana Play pages (243 controls), three such controls appeared, all icon-only:
- Dashboards list, view switch: two hidden radio inputs whose visible labels hold only an icon — listed as
  `radio "radio"` twice. Markup:
  ```html
  <input data-testid="data-testid radio-button-option folders" id="_r_5_" type="radio" checked name="_r_4_">
  <label for="_r_5_"><svg data-testid="icon-folder" aria-hidden="true" …></svg></label>
  <input data-testid="data-testid radio-button-option list" id="_r_8_" type="radio" name="_r_4_">
  <label for="_r_8_"><svg data-testid="icon-list-ul" aria-hidden="true" …></svg></label>
  ```
- Alert rules, label filter: the dropdown arrow of a combobox — listed as `button "button"`. Markup:
  ```html
  <input role="combobox" aria-controls="downshift-_r_a_-menu" placeholder="Select labels" …>
  <svg data-testid="icon-angle-down" role="button" tabindex="-1" aria-controls="downshift-_r_a_-menu" aria-expanded="false" …></svg>
  ```
A person sees a folder icon, a list icon and a dropdown arrow next to "Select labels". The reader should say that much:
`folder icon`, `list ul icon`, `Toggle Select labels`. Icon naming conventions are widespread: `data-testid="icon-…"`
(Grafana), `class="lucide lucide-…"` (lucide / shadcn, used by Langfuse), `fa-…` (Font Awesome), `bi-…`, `mdi-…`.

## Current state

- `src/browser/snapshot.js` (vendored; every local edit is marked `// jev-browse:`). The label of each listed action
  (inside the main loop over `candidates`):
  ```js
      label:
        cap(
          (rname === 'row' || hiddenInput
            ? e.innerText.replace(/\s+/g, ' ').trim()
            : unnamedToggle(e, rname)
              ? rowContext(e)
              : name(e).replace(/\s+/g, ' ').trim()) || rname,
          200 - suffix.length,
        ) + suffix,
  ```
  `hiddenInput` is the hidden checkbox/radio a visible `<label>` stands in for (`labelOf.get(e)`), else undefined.
  `name(e)` computes the accessible name (aria-labelledby, aria-label, labels, button value, alt, child text, title,
  placeholder). **`name()` must not change**: it also feeds the freshness guard (`cache.guard`), and the model's labels
  for every named control must stay exactly as they are.
  Nearby helpers to mirror in style: `unnamedToggle(e, rname)` and `rowContext(e)` (small arrow functions defined just
  before the loop, each with a one-line `// jev-browse:` comment where they were added).
- Model-free conformance suite: `verify/reader.ts`, pages in `verify/fixture/reader/`. A check is
  `{ name, file, run: async (tab) => { … } }` with helpers `listed(tab)`, `find(actions, role, labelRegex)`,
  `controls(actions)`, `labelsOf(actions)`, `fixtureState(tab)`. Example of an act-and-assert check:
  ```ts
  {
    name: 'a sortable header scrolled sideways out of its table is listed and sorts on click',
    file: 'sideways-header.html',
    run: async (tab) => {
      const page = await tab.observe();
      const header = find(page.actions, 'columnheader', /Latency/);
      assert.ok(header, `Latency header not listed: ${labelsOf(page.actions)}`);
      await tab.act(header, page);
      assert.equal((await fixtureState(tab)).sorted, 'latency');
    },
  },
  ```
  27 checks pass today, keyless.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Snapshot syntax | `node -e "new Function(require('fs').readFileSync('src/browser/snapshot.js','utf8'))"` | exit 0 |
| Reader suite (keyless) | `env -u TYPESAFE_API_KEY pnpm verify:reader` | `N/N reader checks passed` |
| Live fixtures | `pnpm verify` | `8/8 scenarios passed` |
| Grafana | `pnpm verify:grafana` | `24/24` last time |

## Scope

**In scope**: `src/browser/snapshot.js` (the label fallback only), `verify/reader.ts` (new checks),
`verify/fixture/reader/unnamed-controls.html` (new).

**Out of scope**: `name()`, `cache.guard`, roles, which elements are listed, `src/browser/tab.ts`, `src/jev/*`. Unnamed
column headers (in the original follow-up) were not observed in the probe; leave them.

## Git workflow

- Commit on the branch your reviewer gave you, in order:
  1. `test: add icon-only control fixtures`
  2. `fix: name icon-only controls from their icon or the control they toggle`
  Lowercase conventional commits, no AI attribution. Do NOT push.

## Steps

### Step 1: Fixture and checks (red first)

Create `verify/fixture/reader/unnamed-controls.html` with `window.__fixture = { view: 'folders', toggled: false, settings: false }`:
1. The Grafana view switch, copied from the markup above (two hidden radios: give the inputs
   `style="position:absolute;opacity:0;width:0;height:0"`, labels `style="cursor:pointer;display:inline-block;padding:6px"`,
   each label holding a 16×16 inline `<svg data-testid="icon-folder" aria-hidden="true">` / `icon-list-ul` with a
   simple `<path>`). A `change` listener on the inputs sets `__fixture.view` to `folders` / `list`.
2. A text input `role="combobox" aria-controls="menu-1" placeholder="Select labels"` followed by
   `<svg role="button" tabindex="-1" aria-controls="menu-1" aria-expanded="false" data-testid="icon-angle-down" width="16" height="16">…</svg>`;
   a click on the svg sets `__fixture.toggled = true` and flips `aria-expanded`. Include `<ul id="menu-1" hidden></ul>`.
3. An icon-only button `<button type="button"><svg class="lucide lucide-settings" width="16" height="16" aria-hidden="true">…</svg></button>`;
   a click sets `__fixture.settings = true`.
4. Controls that must keep their labels: `<button type="button" aria-label="Close panel"><svg class="lucide lucide-x" aria-hidden="true">…</svg></button>`
   and `<button type="button">Save</button>`.

Add checks to `verify/reader.ts`:
- `'icon-only radios are named from their icon, and clicking one selects it'`: radio actions labelled exactly
  `folder icon` and `list ul icon` are listed; `act` on `list ul icon` → `__fixture.view === 'list'`.
- `'a dropdown arrow is named from the combobox it toggles'`: a `button` labelled exactly `Toggle Select labels`;
  `act` on it → `__fixture.toggled === true`.
- `'an icon-only button is named from its icon; named controls keep their names'`: `settings icon` (button) is listed
  and clicks (`__fixture.settings === true`); `Close panel` and `Save` are listed with exactly those labels; and **no**
  listed control's label equals its role (`controls(actions).every((a) => a.label !== a.role)`).

**Verify**: `env -u TYPESAFE_API_KEY pnpm verify:reader` → the three new checks fail; the 27 existing pass. Commit 1.

### Step 2: The fallback

In `snapshot.js`, add a `contextName(e, hiddenInput)` arrow function next to `rowContext`, with a `// jev-browse:` one-line
comment (an icon-only control is named the way a person would describe it: by the control it toggles, or by its icon).
Use it **only** where the label would otherwise be the bare role: change `… || rname` to `… || contextName(e, hiddenInput) || rname`.
It returns the first non-empty of:
1. `hiddenInput ? name(hiddenInput).trim() : ''` (a hidden input's own aria-label or title).
2. **Toggled control**: if `e` has `aria-controls`, the first *other* element with the same `aria-controls` value whose
   `name()` is non-empty → `'Toggle ' + thatName`; else the controlled element's (`document.getElementById(id)`)
   `aria-label` → `'Toggle ' + it`. Use `CSS.escape` in the selector.
3. **Icon name**: look at `e` and then its first descendant matching `svg,i,span,img` that carries an icon hint:
   `data-testid` matching `/^icon-(.+)$/`, or a class token matching `/^(?:lucide|fa|bi|mdi|icon)-(.+)$/` that is not a
   style modifier (skip `fa-solid`, `fa-regular`, `fa-light`, `fa-brands`, `fa-lg`, `fa-xs`, `fa-sm`, `fa-fw`, and
   `fa-<n>x`). Read the class from `getAttribute('class')` (SVG `className` is an object). Return
   `` `${hint.replace(/-/g, ' ')} icon` `` (e.g. `icon-list-ul` → `list ul icon`).
4. Otherwise `''`.
Keep it short and readable; no new globals outside the reader's closure.

**Verify**: snapshot syntax command → exit 0; reader suite → **30/30**; `pnpm test` → all pass. Commit 2.

### Step 3: Measure on real pages

1. Re-run the probe that found the problem. Save this outside the repo (e.g. `$TMPDIR/unnamed-probe.ts`, replace
   `<repo>` with your worktree path) and run `node $TMPDIR/unnamed-probe.ts` (Node ≥ 24 runs TypeScript directly):
   ```ts
   import { connectChrome } from '<repo>/src/browser/chrome.ts';
   import { Tab } from '<repo>/src/browser/tab.ts';
   const urls = ['https://play.grafana.org/dashboards', 'https://play.grafana.org/alerting/list',
     'https://play.grafana.org/explore', 'https://play.grafana.org/d/3138fa155d5915769fbded898ac09fd9/kubernetes-kubelet'];
   const chrome = await connectChrome('launch-headless');
   try {
     for (const url of urls) {
       const tab = await Tab.open(chrome.cdp, url);
       await new Promise((r) => setTimeout(r, 5000));
       const { actions } = await tab.observe();
       const bare = actions.filter((a) => a.role && (a.label === a.role || a.label === `Open ${a.role}`));
       console.log(`${url}: ${actions.length} controls, ${bare.length} unnamed`, actions.filter((a) => / icon$|^Toggle /.test(a.label)).map((a) => `${a.role}: ${a.label}`));
       await tab.close();
     }
   } finally { await chrome.close(); }
   ```
   Expected: 0 unnamed on every page; the dashboards page shows `radio: folder icon` and `radio: list ul icon`, alert
   rules shows `button: Toggle Select labels`. Report the output.
2. `pnpm verify` → 8/8; `pnpm verify:grafana` (24 runs, headless) → report (last 24/24).

Headless Chrome only (the suites launch their own). Never touch the Chrome on port 9333. The model key is in the
gitignored `.env`, loaded by the npm scripts; never read or print it.

## Test plan

Three model-free reader checks on a fixture copied from real Grafana markup (red before step 2), the live probe on
Grafana before/after, and Grafana's 24-run suite plus `pnpm verify` as regression guards.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm test` exit 0; reader 30/30 keyless, with the new checks red at commit 1
- [ ] Probe output reported: 0 unnamed on the four pages
- [ ] `pnpm verify` 8/8; Grafana reported (last 24/24)
- [ ] `git diff --stat 5822f71..HEAD` lists only the three in-scope paths

## STOP conditions

- Any existing reader check fails after step 2 (a named control's label changed).
- The fix seems to need a change to `name()` or `cache.guard`.
- Grafana drops below 22/24.

## Maintenance notes

- The fallback runs only for controls with no accessible name; a control that gains a real name later wins
  automatically. Icon hints are a description for the model, never a selector.
