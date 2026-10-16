/**
 * Model-free page-reader conformance: loads small local pages in headless Chrome, calls the snapshot reader
 * directly and asserts what it lists and that clicks land. No model, no API key, no credits.
 *
 *   pnpm verify:reader
 *
 * Add a fixture here first (red), then fix the reader (green). Pages live in verify/fixture/reader/ and record
 * their outcomes in window.__fixture.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connectChrome } from '../src/browser/chrome.ts';
import { DEVICES, type DeviceName } from '../src/browser/devices.ts';
import { StalePage, Tab, TargetUnreachable, type PageAction } from '../src/browser/tab.ts';

interface Check {
  name: string;
  file: string;
  // Emulated device for the check's tab; the desktop viewport when omitted.
  device?: DeviceName;
  run: (tab: Tab) => Promise<void>;
}

const listed = async (tab: Tab) => (await tab.observe()).actions;
const find = (actions: PageAction[], role: string, label: RegExp) =>
  actions.find((action) => action.role === role && label.test(action.label));
// What the model could pick, without the scroll and wait helpers every page gets.
const controls = (actions: PageAction[]) => actions.filter((action) => ['click', 'fill', 'select'].includes(action.kind));
const labelsOf = (actions: PageAction[]) => JSON.stringify(actions.map((action) => `${action.role}: ${action.label}`));
const fixtureState = (tab: Tab) => tab.evaluate('window.__fixture');

const checks: Check[] = [
  {
    name: 'rows wider than their scroll box are listed and open on click',
    file: 'wide-rows.html',
    run: async (tab) => {
      const page = await tab.observe();
      const rows = page.actions.filter((action) => action.role === 'row');
      assert.equal(rows.length, 3, `expected 3 rows, listed ${labelsOf(page.actions)}`);
      await tab.act(rows[0], page);
      assert.equal((await fixtureState(tab)).opened, 'alpha');
    },
  },
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
  {
    name: 'a link in a visible row scrolled sideways is listed with its row and opens on click',
    file: 'sideways-row-links.html',
    run: async (tab) => {
      const page = await tab.observe();
      const trace = find(page.actions, 'link', /^t-1abc/);
      assert.ok(trace, `trace link not listed: ${labelsOf(page.actions)}`);
      assert.match(trace.label, /scorer-1\b/, 'the label does not say which row the link belongs to');
      await tab.act(trace, page);
      const state = await fixtureState(tab);
      assert.equal(state.opened, 't-1');
      assert.equal(state.sorted, null, 'a header was clicked on the way');
    },
  },
  {
    name: 'sideways row links are capped',
    file: 'sideways-row-links.html',
    run: async (tab) => {
      // Scrolled to the bottom, the rows above the viewport come first in document order, so a rule that ignored where the
      // row is would list them first. Thirteen rows are left on screen with three link columns each: two per row, twenty in all.
      await tab.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      const onScreen: number[] = await tab.evaluate(`[...document.querySelectorAll('tbody tr')]
        .filter((row) => { const box = row.getBoundingClientRect(), y = box.y + box.height / 2; return y >= 0 && y < innerHeight; })
        .map((row) => row.rowIndex)`);
      const links = (await listed(tab)).filter((action) => action.role === 'link');
      const rowOf = (action: PageAction) => Number(action.label.match(/^[tdr]-(\d+)/)?.[1]);
      assert.equal(links.length, 20, `listed ${links.length} sideways links: ${labelsOf(links)}`);
      assert.ok(links.every((action) => onScreen.includes(rowOf(action))), `a link of an off-screen row is listed: ${labelsOf(links)}`);
      for (const row of new Set(links.map(rowOf)))
        assert.ok(links.filter((action) => rowOf(action) === row).length <= 2, `row ${row} lists more than 2 links`);
    },
  },
  {
    name: 'a sortable header holding a drag button is still a column header',
    file: 'header-with-button.html',
    run: async (tab) => {
      const actions = await listed(tab);
      assert.ok(find(actions, 'columnheader', /Start time/), `header not listed: ${labelsOf(actions)}`);
    },
  },
  {
    name: 'a select-all checkbox header is the checkbox, not a column header',
    file: 'select-all-header.html',
    run: async (tab) => {
      const actions = await listed(tab);
      assert.equal(actions.filter((action) => action.role === 'columnheader').length, 0, labelsOf(actions));
      assert.ok(find(actions, 'checkbox', /Select all/), `checkbox not listed: ${labelsOf(actions)}`);
    },
  },
  {
    name: 'a contenteditable combobox is a search bar that takes typed text',
    file: 'contenteditable-search.html',
    run: async (tab) => {
      const page = await tab.observe();
      const search = page.actions.find((action) => action.kind === 'fill' && /Search/.test(action.label));
      assert.ok(search, `no fill action: ${labelsOf(page.actions)}`);
      await tab.act(search, page, 'level:ERROR');
      assert.equal(await tab.evaluate(`document.getElementById('search').innerText`), 'level:ERROR');
    },
  },
  {
    name: 'plain pointer divs inside an open popup are options',
    file: 'popup-items.html',
    run: async (tab) => {
      const page = await tab.observe();
      assert.equal(page.actions.filter((action) => action.role === 'option').length, 3, labelsOf(page.actions));
      const item = find(page.actions, 'option', /Past 7 days/);
      assert.ok(item, `item not listed: ${labelsOf(page.actions)}`);
      await tab.act(item, page);
      assert.equal((await fixtureState(tab)).range, 'Past 7 days');
    },
  },
  {
    name: 'a list that ignores Escape covers the target until dismissPopup closes it',
    file: 'escape-ignored.html',
    run: async (tab) => {
      const page = await tab.observe();
      const save = find(page.actions, 'button', /^Save$/);
      assert.ok(save, `Save not listed: ${labelsOf(page.actions)}`);
      await assert.rejects(tab.act(save, page), (error) => {
        assert.ok(error instanceof TargetUnreachable, `threw ${error}`);
        assert.equal(error.byPopup, true);
        return true;
      });
      assert.equal((await fixtureState(tab)).saved, 0);
      await tab.dismissPopup();
      assert.equal((await fixtureState(tab)).menuOpen, false, 'the outside press did not close the list');
      // Closing the list changes the page, so the decision is made again on a fresh observation.
      const next = await tab.observe();
      const again = find(next.actions, 'button', /^Save$/);
      assert.ok(again, `Save not listed after dismissing: ${labelsOf(next.actions)}`);
      await tab.act(again, next);
      assert.equal((await fixtureState(tab)).saved, 1);
    },
  },
  {
    name: 'a link below the fold is listed only once its text is wanted, and a click scrolls it in',
    file: 'below-fold.html',
    run: async (tab) => {
      const before = await listed(tab);
      assert.ok(find(before, 'link', /u-0001/), `first link not listed: ${labelsOf(before)}`);
      assert.ok(!find(before, 'link', /u-0050/), 'u-0050 is below the fold and was not wanted');
      tab.want(['u-0050']);
      const page = await tab.observe();
      const target = find(page.actions, 'link', /u-0050/);
      assert.ok(target, `wanted link not listed: ${labelsOf(page.actions)}`);
      await tab.act(target, page);
      assert.equal((await fixtureState(tab)).opened, 'u-0050');
    },
  },
  {
    name: 'a wanted value held by hundreds of off-screen rows lists at most 5, first ones first',
    file: 'want-flood.html',
    run: async (tab) => {
      tab.want(['error']);
      const rows = (await listed(tab)).filter((action) => action.role === 'row');
      assert.ok(rows.length >= 1 && rows.length <= 5, `listed ${rows.length} off-screen rows`);
      assert.match(rows[0].label, /timeout 001/);
    },
  },
  {
    name: 'a wanted value already held on screen lists no off-screen rows',
    file: 'want-onscreen.html',
    run: async (tab) => {
      tab.want(['error']);
      const actions = await listed(tab);
      assert.ok(find(actions, 'link', /ERROR log/), `on-screen link not listed: ${labelsOf(actions)}`);
      const rows = actions.filter((action) => action.role === 'row');
      assert.equal(rows.length, 0, `listed ${rows.length} off-screen rows`);
    },
  },
  {
    name: 'an unnamed checkbox is named by its row, not by its value "on"',
    file: 'unnamed-checkbox.html',
    run: async (tab) => {
      const actions = await listed(tab);
      const checkbox = actions.find((action) => action.role === 'checkbox');
      assert.ok(checkbox, `checkbox not listed: ${labelsOf(actions)}`);
      assert.notEqual(checkbox.label, 'on');
      assert.match(checkbox.label, /Casa Flora/);
    },
  },
  {
    name: 'a row holding a 5 000-character JSON payload keeps every label within 200 characters',
    file: 'json-row.html',
    run: async (tab) => {
      const actions = await listed(tab);
      assert.ok(actions.some((action) => action.role === 'row'), `row not listed: ${labelsOf(actions)}`);
      const longest = Math.max(...actions.map((action) => action.label.length));
      assert.ok(longest <= 200, `a label is ${longest} characters long`);
    },
  },
  {
    name: 'a row is labelled by what it shows, not by its nested checkbox',
    file: 'row-label.html',
    run: async (tab) => {
      const actions = await listed(tab);
      const row = actions.find((action) => action.role === 'row');
      assert.ok(row, `row not listed: ${labelsOf(actions)}`);
      assert.ok(row.label.startsWith('Trace 42'), row.label);
      assert.ok(!row.label.includes('Select row'), row.label);
      assert.ok(find(actions, 'checkbox', /Select row/), `checkbox not listed: ${labelsOf(actions)}`);
    },
  },
  {
    name: 'a link clipped by a scrolling sidebar is scrolled into view and clicked',
    file: 'clipped-sidebar.html',
    run: async (tab) => {
      const page = await tab.observe();
      const last = find(page.actions, 'link', /^Item 30$/);
      assert.ok(last, `last link not listed: ${labelsOf(page.actions)}`);
      await tab.act(last, page);
      assert.equal((await fixtureState(tab)).nav, 'Item 30');
    },
  },
  {
    name: 'an open modal hides the page behind it',
    file: 'modal.html',
    run: async (tab) => {
      const labels = controls(await listed(tab)).map((action) => action.label);
      assert.ok(labels.includes('OK'), `modal button not listed: ${labels}`);
      assert.ok(!labels.some((label) => /Background action/.test(label)), `page button listed: ${labels}`);
    },
  },
  {
    name: 'a button inside an open shadow root is listed and clickable',
    file: 'shadow.html',
    run: async (tab) => {
      const page = await tab.observe();
      const search = find(page.actions, 'button', /^Search$/);
      assert.ok(search, `shadow button not listed: ${labelsOf(page.actions)}`);
      await tab.act(search, page);
      assert.equal((await fixtureState(tab)).clicked, true);
    },
  },
  {
    name: 'aria-hidden, inert and disabled controls are not listed',
    file: 'hidden-and-disabled.html',
    run: async (tab) => {
      const labels = controls(await listed(tab)).map((action) => action.label);
      assert.deepEqual(labels, ['Normal']);
    },
  },
  {
    name: 'an input is named by the element its aria-labelledby points at',
    file: 'labelled-by.html',
    run: async (tab) => {
      const actions = await listed(tab);
      const field = actions.find((action) => action.kind === 'fill');
      assert.ok(field, `no fill action: ${labelsOf(actions)}`);
      assert.equal(field.label, 'Email address');
    },
  },
  {
    name: 'a native select lists each unselected option as "field → option"',
    file: 'native-select.html',
    run: async (tab) => {
      const options = (await listed(tab)).filter((action) => action.kind === 'select');
      assert.deepEqual(
        options.map((action) => action.label),
        ['Country → France', 'Country → Germany'],
      );
    },
  },
  {
    name: 'a button under a fixed header is unreachable, and not because of a popup',
    file: 'sticky-cover.html',
    run: async (tab) => {
      await tab.evaluate('window.scrollTo(0, 980)');
      assert.equal(await tab.evaluate('scrollY'), 980);
      const page = await tab.observe();
      const target = find(page.actions, 'button', /Add to basket/);
      assert.ok(target, `button not listed: ${labelsOf(page.actions)}`);
      await assert.rejects(tab.act(target, page), (error) => {
        assert.ok(error instanceof TargetUnreachable, `threw ${error}`);
        assert.equal(error.byPopup, false);
        return true;
      });
      assert.equal((await fixtureState(tab)).added, 0);
    },
  },
  {
    name: 'a visually hidden checkbox is listed by its visible label and toggled by clicking it',
    file: 'hidden-checkbox-label.html',
    run: async (tab) => {
      const page = await tab.observe();
      const range = page.actions.find((action) => action.role === 'checkbox' && action.label === 'Last 24 hours');
      assert.ok(range, `label not listed: ${labelsOf(page.actions)}`);
      assert.equal(range.checked, 'false');
      await tab.act(range, page);
      assert.equal((await fixtureState(tab)).range, 'Last 24 hours');
      assert.equal(await tab.evaluate(`document.getElementById('r1').checked`), true);
    },
  },
  {
    name: 'a hidden radio inside its label is listed by that label and checked by clicking it',
    file: 'hidden-radio-wrapped.html',
    run: async (tab) => {
      const page = await tab.observe();
      const plan = find(page.actions, 'radio', /^Pro plan$/);
      assert.ok(plan, `label not listed: ${labelsOf(page.actions)}`);
      await tab.act(plan, page);
      assert.equal(await tab.evaluate(`document.querySelector('input:checked')?.value`), 'pro');
    },
  },
  {
    name: 'a visible checkbox with a label is listed once, as the input',
    file: 'visible-checkbox.html',
    run: async (tab) => {
      const actions = controls(await listed(tab));
      assert.equal(actions.length, 1, labelsOf(actions));
      assert.equal(actions[0].role, 'checkbox');
      assert.match(actions[0].label, /newsletter/);
    },
  },
  {
    name: 'a panel menu that appears only on hover is listed as such, and clicking it hovers first',
    file: 'hover-menu.html',
    run: async (tab) => {
      const page = await tab.observe();
      const menu = find(page.actions, 'button', /Menu for panel CPU/);
      assert.ok(menu, `menu not listed: ${labelsOf(page.actions)}`);
      assert.equal(menu.hover, true);
      assert.match(menu.label, /\(appears on hover\)$/);
      await tab.act(menu, page);
      const opened = await tab.observe();
      const view = find(opened.actions, 'menuitem', /^View$/);
      assert.ok(view, `View not listed after opening the menu: ${labelsOf(opened.actions)}`);
      await tab.act(view, opened);
      assert.equal((await fixtureState(tab)).viewed, 'CPU');
    },
  },
  {
    name: 'a row action with opacity 0 until its row is hovered is listed as appearing on hover',
    file: 'hover-row-actions.html',
    run: async (tab) => {
      const actions = await listed(tab);
      const deletes = actions.filter((action) => /Delete invoice/.test(action.label));
      assert.equal(deletes.length, 3, `expected 3 row actions, listed ${labelsOf(actions)}`);
      assert.ok(deletes.every((action) => action.hover === true), labelsOf(deletes));
      assert.equal((await fixtureState(tab)).deleted, null);
    },
  },
  {
    name: 'a hover-revealed row action re-labelled after observation is refused as stale, not clicked',
    file: 'hover-row-actions.html',
    run: async (tab) => {
      const page = await tab.observe();
      const target = find(page.actions, 'button', /Delete invoice 001/);
      assert.ok(target, `Delete invoice 001 not listed: ${labelsOf(page.actions)}`);
      assert.equal(target.hover, true);
      // An unkeyed re-render: the same <button> elements stay, their labels and row text swap.
      await tab.evaluate(`(() => {
        const [first, second] = document.querySelectorAll('tr');
        const [firstButton, secondButton] = [first, second].map((row) => row.querySelector('button'));
        const [firstLabel, secondLabel] = [firstButton, secondButton].map((button) => button.getAttribute('aria-label'));
        const [firstName, secondName] = [first, second].map((row) => row.firstElementChild.textContent);
        firstButton.setAttribute('aria-label', secondLabel);
        secondButton.setAttribute('aria-label', firstLabel);
        first.firstElementChild.textContent = secondName;
        second.firstElementChild.textContent = firstName;
      })()`);
      await assert.rejects(
        tab.act(target, page),
        (error) => error instanceof StalePage && !(error instanceof TargetUnreachable),
      );
      assert.equal((await fixtureState(tab)).deleted, null);
    },
  },
  {
    name: 'a button with display none inside a hoverable card is not a hover reveal and is not listed',
    file: 'display-none.html',
    run: async (tab) => {
      const actions = await listed(tab);
      assert.deepEqual(
        controls(actions).map((action) => action.label),
        ['Open card'],
      );
      assert.ok(actions.every((action) => !action.hover), labelsOf(actions));
    },
  },
  {
    name: 'a tap on a touch device lasts like a finger and has a contact area',
    file: 'tap-duration.html',
    device: 'iphone-15',
    run: async (tab) => {
      const page = await tab.observe();
      const sort = find(page.actions, 'button', /^Sort$/);
      assert.ok(sort, `button not listed: ${labelsOf(page.actions)}`);
      await tab.act(sort, page);
      const { tapMs, radius } = await fixtureState(tab);
      assert.ok(tapMs >= 40, `the tap lasted ${tapMs} ms`);
      assert.ok(radius > 0, `the touch had radius ${radius}`);
    },
  },
  {
    name: 'a field whose centre is covered by its own prefix still takes typing at another point',
    file: 'partly-covered.html',
    run: async (tab) => {
      const page = await tab.observe();
      const search = page.actions.find((action) => action.kind === 'fill' && /Search/.test(action.label));
      assert.ok(search, `no fill action: ${labelsOf(page.actions)}`);
      await tab.act(search, page, 'cpu');
      assert.equal((await fixtureState(tab)).value, 'cpu');
    },
  },
  {
    name: 'a button covered by an overlay at every point is still refused',
    file: 'fully-covered.html',
    run: async (tab) => {
      const page = await tab.observe();
      const pay = find(page.actions, 'button', /Pay now/);
      assert.ok(pay, `button not listed: ${labelsOf(page.actions)}`);
      await assert.rejects(tab.act(pay, page), (error) => {
        assert.ok(error instanceof TargetUnreachable, `threw ${error}`);
        assert.equal(error.byPopup, false);
        return true;
      });
      assert.equal((await fixtureState(tab)).paid, 0);
    },
  },
  {
    name: 'icon-only radios are named from their icon, and clicking one selects it',
    file: 'unnamed-controls.html',
    run: async (tab) => {
      const page = await tab.observe();
      const folder = find(page.actions, 'radio', /^folder icon$/);
      const list = find(page.actions, 'radio', /^list ul icon$/);
      assert.ok(folder && list, `icon radios not named: ${labelsOf(page.actions)}`);
      await tab.act(list, page);
      assert.equal((await fixtureState(tab)).view, 'list');
    },
  },
  {
    name: 'a dropdown arrow is named from the combobox it toggles',
    file: 'unnamed-controls.html',
    run: async (tab) => {
      const page = await tab.observe();
      const arrow = find(page.actions, 'button', /^Toggle Select labels$/);
      assert.ok(arrow, `dropdown arrow not named: ${labelsOf(page.actions)}`);
      await tab.act(arrow, page);
      assert.equal((await fixtureState(tab)).toggled, true);
    },
  },
  {
    name: 'an icon-only button is named from its icon; named controls keep their names',
    file: 'unnamed-controls.html',
    run: async (tab) => {
      const page = await tab.observe();
      const settings = find(page.actions, 'button', /^settings icon$/);
      assert.ok(settings, `icon button not named: ${labelsOf(page.actions)}`);
      assert.ok(find(page.actions, 'button', /^Close panel$/), `Close panel renamed: ${labelsOf(page.actions)}`);
      assert.ok(find(page.actions, 'button', /^Save$/), `Save renamed: ${labelsOf(page.actions)}`);
      assert.ok(
        controls(page.actions).every((action) => action.label !== action.role),
        `a control is named by its bare role: ${labelsOf(page.actions)}`,
      );
      await tab.act(settings, page);
      assert.equal((await fixtureState(tab)).settings, true);
    },
  },
  {
    name: 'unnamed filter toggles are named from the text beside them',
    file: 'container-names.html',
    run: async (tab) => {
      const page = await tab.observe();
      const labels = page.actions.filter((action) => action.role === 'checkbox').map((action) => action.label);
      assert.deepEqual(labels, ['Select: chat 220', 'Select: step 220', 'Select: qa-chatbot 65']);
      const step = find(page.actions, 'checkbox', /^Select: step 220$/);
      assert.ok(step, `step toggle not listed: ${labelsOf(page.actions)}`);
      await tab.act(step, page);
      assert.deepEqual((await fixtureState(tab)).facets, ['step 220']);
    },
  },
  {
    name: 'an unnamed page box is named from the text around it',
    file: 'container-names.html',
    run: async (tab) => {
      const page = await tab.observe();
      const box = page.actions.find((action) => action.kind === 'fill' && action.label === 'Page of 30');
      assert.ok(box, `page box not named: ${labelsOf(page.actions)}`);
      assert.equal(box.role, 'spinbutton');
      assert.ok(find(page.actions, 'spinbutton', /^Open Page of 30$/), `click entry not named: ${labelsOf(page.actions)}`);
      await tab.act(box, page, '3');
      assert.equal((await fixtureState(tab)).page, '3');
    },
  },
  {
    name: 'a long container does not name a control',
    file: 'container-names.html',
    run: async (tab) => {
      // The first button on the page sits under the long paragraph.
      const [guard] = (await listed(tab)).filter((action) => action.role === 'button');
      assert.equal(guard?.label, 'button');
    },
  },
  {
    name: 'a control is never named from a neighbouring control',
    file: 'container-names.html',
    run: async (tab) => {
      const buttons = (await listed(tab)).filter((action) => action.role === 'button');
      // Long-paragraph button, Save, then the unnamed button beside Save.
      assert.deepEqual(
        buttons.map((action) => action.label),
        ['button', 'Save', 'button'],
      );
    },
  },
];

// Serve every page in verify/fixture/reader/ at /<file name> on a random local port.
const fixtureDir = new URL('./fixture/reader/', import.meta.url);
const pages = Object.fromEntries(readdirSync(fixtureDir).map((file) => [`/${file}`, readFileSync(new URL(file, fixtureDir))]));
const server = createServer((request, response) => {
  const page = pages[request.url ?? ''];
  response.writeHead(page ? 200 : 404, { 'content-type': 'text/html' }).end(page);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let passed = 0;
try {
  const chrome = await connectChrome('launch-headless');
  try {
    for (const check of checks) {
      try {
        const tab = await Tab.open(chrome.cdp, `${origin}/${check.file}`, { device: DEVICES[check.device ?? 'desktop'] });
        try {
          await check.run(tab);
        } finally {
          await tab.close();
        }
        passed++;
        process.stdout.write(`✔ ${check.name}\n`);
      } catch (error) {
        process.stdout.write(`✘ ${check.name} — ${(error as Error).message.replace(/\s+/g, ' ').slice(0, 600)}\n`);
      }
    }
  } finally {
    await chrome.close();
  }
} finally {
  server.close();
}

process.stdout.write(`\n${passed}/${checks.length} reader checks passed\n`);
process.exitCode = passed === checks.length ? 0 : 1;
