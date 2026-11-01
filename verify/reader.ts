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
import { findBotWall } from '../src/browser/bot-wall.ts';
import { connectChrome } from '../src/browser/chrome.ts';
import { DEVICES, type DeviceName } from '../src/browser/devices.ts';
import { StalePage, Tab, TargetUnreachable, type PageAction } from '../src/browser/tab.ts';
import type { Ask } from '../src/jev/decide.ts';
import { BrowserTask } from '../src/task/run-task.ts';

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
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Box = { x: number; y: number; w: number; h: number };
// The first iframe's content box (inside its border and padding) in viewport pixels, read in the page itself.
const frameBox = (tab: Tab): Promise<Box> =>
  tab.evaluate(`(() => {
    const f = document.querySelector('iframe'), r = f.getBoundingClientRect(), s = getComputedStyle(f);
    const left = parseFloat(s.paddingLeft), top = parseFloat(s.paddingTop);
    return { x: r.x + f.clientLeft + left, y: r.y + f.clientTop + top, w: f.clientWidth - left - parseFloat(s.paddingRight), h: f.clientHeight - top - parseFloat(s.paddingBottom) };
  })()`);
const insideBox = (rect: Box, box: Box) =>
  rect.x >= box.x - 0.5 && rect.y >= box.y - 0.5 && rect.x + rect.w <= box.x + box.w + 0.5 && rect.y + rect.h <= box.y + box.h + 0.5;

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
    name: 'a popover a modal library marked aria-hidden is listed when it is on top',
    file: 'portaled-popover.html',
    run: async (tab) => {
      const page = await tab.observe();
      for (const label of [/^Past 1 hour$/, /^Past 7 days$/, /^Past 30 days$/]) {
        assert.ok(page.actions.some((action) => ['option', 'button'].includes(action.role ?? '') && label.test(action.label)), `${label} not listed: ${labelsOf(page.actions)}`);
      }
      assert.ok(!page.actions.some((action) => /Behind the sheet/.test(action.label)), `a covered control is listed: ${labelsOf(page.actions)}`);
      const item = page.actions.find((action) => /^Past 30 days$/.test(action.label))!;
      await tab.act(item, page);
      assert.equal((await fixtureState(tab)).range, 'Past 30 days');
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
    // Touch emulation still applies :hover to a pointer move; a tap on the panel could activate it, so none is used.
    name: 'on a phone, a panel menu that appears only on hover is listed and revealed by a pointer move',
    file: 'hover-menu.html',
    device: 'iphone-15',
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
    name: 'a focusable dropdown trigger with an unknown role is listed as a button and opens',
    file: 'fomantic-dropdown.html',
    run: async (tab) => {
      const page = await tab.observe();
      const trigger = find(page.actions, 'button', /^Profile and settings…$/);
      assert.ok(trigger, `trigger not listed: ${labelsOf(page.actions)}`);
      assert.equal(trigger.expanded, 'false');
      assert.ok(!page.actions.some((action) => /Plain menu/.test(action.label)), `a plain menu container is listed: ${labelsOf(page.actions)}`);
      await tab.act(trigger, page);
      const opened = await tab.observe();
      const settings = find(opened.actions, 'menuitem', /^Settings$/);
      assert.ok(settings, `Settings not listed after opening the menu: ${labelsOf(opened.actions)}`);
      await tab.act(settings, opened);
      assert.equal((await fixtureState(tab)).opened, 'settings');
    },
  },
  {
    name: 'a details summary shows whether its section is open',
    file: 'details-section.html',
    run: async (tab) => {
      const page = await tab.observe();
      const units = find(page.actions, 'button', /^Units$/);
      assert.ok(units, `Units not listed: ${labelsOf(page.actions)}`);
      assert.equal(units.expanded, 'false');
      assert.equal(find(page.actions, 'button', /^Collaborators$/)?.expanded, 'true');
      await tab.act(units, page);
      const opened = await tab.observe();
      assert.equal(find(opened.actions, 'button', /^Units$/)?.expanded, 'true');
      assert.ok(find(opened.actions, 'link', /^Wiki$/), `Wiki not listed after opening Units: ${labelsOf(opened.actions)}`);
    },
  },
  {
    name: 'a control is named without the text of its hidden descendants',
    file: 'dropdown-hidden-menu.html',
    run: async (tab) => {
      const actions = await listed(tab);
      assert.ok(find(actions, 'button', /^Labels$/), `the picker is not named "Labels": ${labelsOf(actions)}`);
      assert.ok(find(actions, 'button', /^Save$/), `the button is not named "Save": ${labelsOf(actions)}`);
      assert.ok(find(actions, 'button', /^Hidden name$/), `the aria-labelledby control lost its name: ${labelsOf(actions)}`);
      assert.ok(find(actions, 'button', /^Close$/), `the icon button lost its svg title as its name: ${labelsOf(actions)}`);
      assert.ok(find(actions, 'button', /^Archive$/), `a label inside a display:contents wrapper lost its text: ${labelsOf(actions)}`);
    },
  },
  {
    name: 'a menu that fades in is listed once it has opened',
    file: 'menu-fades-in.html',
    run: async (tab) => {
      const page = await tab.observe();
      const trigger = find(page.actions, 'button', /^Panel menu$/);
      assert.ok(trigger, `trigger not listed: ${labelsOf(page.actions)}`);
      await tab.act(trigger, page);
      const opened = await tab.observe();
      const view = find(opened.actions, 'menuitem', /^View/);
      assert.ok(view, `View not listed after opening the menu: ${labelsOf(opened.actions)}`);
      assert.ok(!view.hover && !/appears on hover/.test(view.label), `View is listed as hover-only while the menu fades in: ${view.label}`);
      await tab.act(view, opened);
      assert.equal((await fixtureState(tab)).viewed, true);
    },
  },
  {
    name: 'an endless animation does not hold up listing',
    file: 'menu-fades-in.html',
    run: async (tab) => {
      const page = await tab.observe();
      const trigger = find(page.actions, 'button', /^Panel menu$/);
      assert.ok(trigger, `trigger not listed: ${labelsOf(page.actions)}`);
      const started = performance.now();
      await tab.act(trigger, page);
      await tab.observe();
      const took = performance.now() - started;
      assert.ok(took < 700, `the click and the next listing took ${Math.round(took)} ms`);
    },
  },
  {
    name: 'a skeleton is read once its rows arrive',
    file: 'skeleton-table.html',
    run: async (tab) => {
      const page = await tab.observe();
      const load = find(page.actions, 'button', /^Tracing$/);
      assert.ok(load, `Tracing not listed: ${labelsOf(page.actions)}`);
      await tab.act(load, page);
      const loaded = await tab.observe();
      const first = find(loaded.actions, 'link', /^Trace 1$/);
      assert.ok(first, `Trace 1 not listed after the click, the page was read while its rows were placeholders: ${labelsOf(loaded.actions)}`);
      await tab.act(first, loaded);
      assert.equal((await fixtureState(tab)).opened, 'Trace 1');
    },
  },
  {
    name: 'placeholders that never stop end the wait and are named',
    file: 'skeleton-table.html',
    run: async (tab) => {
      const page = await tab.observe();
      const forever = find(page.actions, 'button', /^Forever$/);
      assert.ok(forever, `Forever not listed: ${labelsOf(page.actions)}`);
      await tab.act(forever, page);
      const started = performance.now();
      const stuck = await tab.observe();
      const took = performance.now() - started;
      assert.ok(took < 2500, `the listing took ${Math.round(took)} ms`);
      assert.match(stuck.text, /Loading: 8 placeholder blocks on screen/, `the page text does not say it is loading: ${JSON.stringify(stuck.text.slice(0, 120))}`);
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
    name: 'a combobox whose input is 4px wide opens through its field box and stays open',
    file: 'tiny-combobox.html',
    device: 'iphone-15',
    run: async (tab) => {
      const page = await tab.observe();
      const open = page.actions.find((action) => action.kind === 'click' && action.role === 'combobox' && /Sort/.test(action.label));
      assert.ok(open, `combobox not listed: ${labelsOf(page.actions)}`);
      await tab.act(open, page);
      const after = await tab.observe();
      assert.equal(await tab.evaluate(`document.querySelector('input').getAttribute('aria-expanded')`), 'true', JSON.stringify(await fixtureState(tab)));
      assert.ok(find(after.actions, 'option', /Recently viewed/), `option not listed: ${labelsOf(after.actions)}`);
    },
  },
  {
    name: 'a search input covered by its own prefix and suffix takes typing through its field box',
    file: 'decorated-search.html',
    run: async (tab) => {
      const page = await tab.observe();
      const search = page.actions.find((action) => action.kind === 'fill' && /Search/.test(action.label));
      assert.ok(search, `no fill action: ${labelsOf(page.actions)}`);
      await tab.act(search, page, 'cpu');
      assert.equal((await fixtureState(tab)).value, 'cpu');
    },
  },
  {
    name: 'a search input under a banner that is not part of its field is still refused',
    file: 'foreign-cover.html',
    run: async (tab) => {
      const page = await tab.observe();
      const search = page.actions.find((action) => action.kind === 'fill' && /Search/.test(action.label));
      assert.ok(search, `no fill action: ${labelsOf(page.actions)}`);
      await assert.rejects(tab.act(search, page, 'cpu'), (error) => {
        assert.ok(error instanceof TargetUnreachable, `threw ${error}`);
        return true;
      });
      const state = await fixtureState(tab);
      assert.equal(state.value, null);
      assert.equal(state.focused, 0, 'the field was focused behind the banner');
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
  {
    name: 'repeated action labels carry their card',
    file: 'repeated-actions.html',
    run: async (tab) => {
      const page = await tab.observe();
      const adds = page.actions.filter((action) => action.role === 'button' && action.label.startsWith('Add to cart'));
      assert.deepEqual(
        adds.map((action) => action.label),
        ['Backpack', 'Bike Light', 'Onesie', 'Jacket'].map((title) => `Add to cart — ${title}`),
      );
      await tab.act(adds[1], page);
      assert.deepEqual((await fixtureState(tab)).added, ['Bike Light']);
    },
  },
  {
    name: 'a card read through an SVG link takes its text content',
    file: 'svg-links.html',
    run: async (tab) => {
      const page = await tab.observe();
      const opens = page.actions.filter((action) => action.role === 'button' && action.label.startsWith('Open'));
      assert.deepEqual(
        opens.map((action) => action.label),
        ['Open — Web server', 'Open — Worker'],
      );
      await tab.act(opens[1], page);
      assert.deepEqual((await fixtureState(tab)).opened, ['Worker']);
    },
  },
  {
    name: 'unique labels are unchanged',
    file: 'repeated-actions.html',
    run: async (tab) => {
      const actions = await listed(tab);
      assert.ok(find(actions, 'button', /^Checkout$/), `Checkout renamed: ${labelsOf(actions)}`);
      // Two links to one page from one card have no card of their own to tell them apart: neither gets a context, even
      // though one of their wrappers happens to hold a description.
      const links = actions.filter((action) => action.role === 'link');
      assert.deepEqual(
        links.map((action) => action.label),
        ['View Backpack', 'View Backpack'],
      );
    },
  },
  {
    name: 'password fields are described as filled or empty, never listed or read',
    file: 'password-fields.html',
    run: async (tab) => {
      const page = await tab.observe();
      // The page text is what the model reads: it holds the fact and none of the value, the length or a prefix of it.
      assert.ok(!JSON.stringify(page).includes('secret-9431'), 'the password value reached the page state');
      assert.deepEqual(
        controls(page.actions).map((action) => action.label),
        ['Username', 'Open Username', 'Sign in'],
      );
      assert.ok(page.text.includes('Password field "Password": filled'), `the filled field is not described: ${page.text}`);
      assert.ok(page.text.includes('Password field "Confirm password": empty'), `the empty field is not described: ${page.text}`);
      assert.ok(!page.text.includes('Old password'), `a hidden field is described: ${page.text}`);
      // The same facts as data, which the request carries outside the page text.
      assert.deepEqual(page.passwordFields, [
        { name: 'Password', filled: true },
        { name: 'Confirm password', filled: false },
      ]);
    },
  },
  {
    name: 'a click the browser drops is reported, not counted as done',
    file: 'repeated-actions.html',
    run: async (tab) => {
      const addToCart = (page: { actions: PageAction[] }) =>
        page.actions.find((action) => action.role === 'button' && action.label === 'Add to cart — Backpack')!;
      const page = await tab.observe();
      // The browser accepts the press and release but never delivers them, as in the live SauceDemo failure.
      await tab.send('Input.setIgnoreInputEvents', { ignore: true });
      try {
        await assert.rejects(tab.act(addToCart(page), page), /no input/i);
        assert.deepEqual((await fixtureState(tab)).added, [], 'the dropped click reached the page');
      } finally {
        await tab.send('Input.setIgnoreInputEvents', { ignore: false });
      }
      const again = await tab.observe();
      await tab.act(addToCart(again), again);
      assert.deepEqual((await fixtureState(tab)).added, ['Backpack']);
    },
  },
  {
    name: 'a page dialog is answered with the choice that changes nothing',
    file: 'dialogs.html',
    run: async (tab) => {
      // A dialog freezes the page for every protocol call, so each press must come back within seconds.
      const press = async (label: RegExp) => {
        const page = await tab.observe();
        const button = find(page.actions, 'button', label);
        assert.ok(button, `${label} not listed: ${labelsOf(page.actions)}`);
        const started = Date.now();
        await tab.act(button, page);
        assert.ok(Date.now() - started < 5000, `acting on ${label} took ${Date.now() - started} ms`);
      };
      await press(/^Discard draft$/);
      assert.equal((await fixtureState(tab)).answer, false);
      assert.deepEqual(tab.takeDialogs(), [{ type: 'confirm', message: 'Discard the draft?', accepted: false }]);
      await tab.observe();

      await press(/^Notice$/);
      assert.equal((await fixtureState(tab)).afterAlert, true);
      assert.deepEqual(tab.takeDialogs(), [{ type: 'alert', message: 'Saved', accepted: true }]);
      await tab.observe();

      const page = await tab.observe();
      const draft = page.actions.find((action) => action.kind === 'fill');
      assert.ok(draft, `no draft field: ${labelsOf(page.actions)}`);
      await tab.act(draft, page, 'half-typed comment');
      await press(/^Reload$/);
      assert.equal(await tab.evaluate('document.getElementById("draft").value'), 'half-typed comment', 'the page left');
      assert.deepEqual(tab.takeDialogs(), [{ type: 'beforeunload', message: '', accepted: false }]);
      await tab.observe();
    },
  },
  {
    name: 'a confirmed click answers OK to its own confirm dialog, and nothing else does',
    file: 'dialogs.html',
    run: async (tab) => {
      const press = async (label: RegExp) => {
        const page = await tab.observe();
        const button = find(page.actions, 'button', label);
        assert.ok(button, `${label} not listed: ${labelsOf(page.actions)}`);
        await tab.act(button, page);
      };
      const answered = (message: string, accepted: boolean) => [{ type: 'confirm', message, accepted }];
      const DELETE = 'Delete the draft?';

      // Nothing armed: the answer that changes nothing.
      await press(/^Delete draft$/);
      assert.equal((await fixtureState(tab)).deleted, false);
      assert.deepEqual(tab.takeDialogs(), answered(DELETE, false));

      // Armed with the user's words and the control's label, the click's own dialog names them: OK.
      tab.armConfirm(['the draft', 'Delete draft']);
      await press(/^Delete draft$/);
      assert.equal((await fixtureState(tab)).deleted, true);
      assert.deepEqual(tab.takeDialogs(), answered(DELETE, true));

      // The arm went with that dialog: the same click again is declined.
      await press(/^Delete draft$/);
      assert.equal((await fixtureState(tab)).deleted, false);
      assert.deepEqual(tab.takeDialogs(), answered(DELETE, false));

      // An arm the loop took back at the end of its step answers nothing, even for a dialog that names the words.
      tab.armConfirm(['the draft', 'Delete draft']);
      tab.disarmConfirm();
      await press(/^Discard draft$/);
      assert.equal((await fixtureState(tab)).answer, false);
      assert.deepEqual(tab.takeDialogs(), answered('Discard the draft?', false));

      // A dialog about something else than the confirmed click (the draft comments a reload would discard) stays declined.
      tab.armConfirm(['Labels', 'Labels']);
      await press(/^Labels$/);
      assert.equal((await fixtureState(tab)).discarded, false, 'the draft comments were discarded');
      const [reload] = tab.takeDialogs();
      assert.equal(reload.type, 'confirm');
      assert.equal(reload.accepted, false);

      // A prompt and a leave-the-page guard are never accepted, armed or not.
      tab.armConfirm(['Rename the draft', 'Rename']);
      await press(/^Rename$/);
      assert.equal((await fixtureState(tab)).renamed, null);
      assert.deepEqual(tab.takeDialogs(), [{ type: 'prompt', message: 'Rename the draft?', accepted: false }]);
      tab.disarmConfirm();

      const page = await tab.observe();
      const draft = page.actions.find((action) => action.kind === 'fill');
      assert.ok(draft, `no draft field: ${labelsOf(page.actions)}`);
      await tab.act(draft, page, 'half-typed comment');
      tab.armConfirm(['Reload', 'Reload']);
      await press(/^Reload$/);
      assert.equal(await tab.evaluate('document.getElementById("draft").value'), 'half-typed comment', 'the page left');
      assert.deepEqual(tab.takeDialogs(), [{ type: 'beforeunload', message: '', accepted: false }]);
      tab.disarmConfirm();
    },
  },
  {
    name: 'escape and scroll refused once on a page whose text keeps changing run when forced',
    file: 'busy-page-menu.html',
    run: async (tab) => {
      const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      // The loop adds Escape while a menu is open; the page reader never lists it.
      const escape: PageAction = { id: 'press_escape', kind: 'escape', label: 'Press Escape to close the open menu, popover or suggestion list' };
      let page = await tab.observe();
      await pause(200);
      await assert.rejects(tab.act(escape, page), StalePage, 'a ticking page was not refused the first time');
      await tab.act(escape, page, undefined, { evenIfChanged: true });
      assert.equal((await fixtureState(tab)).closed, true, 'the menu was not closed');
      page = await tab.observe();
      await pause(200);
      const scrollDown = page.actions.find((action) => action.id === 'scroll_down');
      assert.ok(scrollDown, `Scroll down not offered: ${labelsOf(page.actions)}`);
      await assert.rejects(tab.act(scrollDown, page), StalePage, 'a ticking page was not refused the first time');
      await tab.act(scrollDown, page, undefined, { evenIfChanged: true });
      for (let waited = 0; waited < 1000 && !(await tab.evaluate('scrollY')); waited += 50) await pause(50);
      assert.ok((await tab.evaluate('scrollY')) > 0, 'the page did not scroll');
    },
  },
  // Bot walls: the run's own detector on real pages, and a run that meets one. No model: the ask below must never be needed on a wall.
  {
    name: "a Cloudflare challenge is a wall, named with its Turnstile box",
    file: 'bot-wall-cloudflare.html',
    run: async (tab) => {
      const wall = await findBotWall(tab, await tab.observe());
      assert.equal(wall?.name, 'Cloudflare Turnstile', JSON.stringify(wall));
    },
  },
  {
    name: "Google's unusual-traffic page is a wall, named after its reCAPTCHA box",
    file: 'bot-wall-unusual-traffic.html',
    run: async (tab) => {
      const wall = await findBotWall(tab, await tab.observe());
      assert.equal(wall?.name, 'reCAPTCHA', JSON.stringify(wall));
    },
  },
  {
    name: 'an article quoting "verify you are human" and a Ray ID is not a wall',
    file: 'bot-wall-article.html',
    run: async (tab) => assert.equal(await findBotWall(tab, await tab.observe()), undefined),
  },
  {
    name: 'a thread whose top comments discuss captchas and bot checks is not a wall',
    file: 'bot-wall-thread.html',
    run: async (tab) => assert.equal(await findBotWall(tab, await tab.observe()), undefined),
  },
  {
    name: 'a run on a challenge that never clears ends blocked after its wait, without asking the model',
    file: 'bot-wall-cloudflare.html',
    run: async (tab) => {
      let asked = 0;
      const ask: Ask = async () => {
        asked++;
        throw new Error('no model in this check');
      };
      const summary = await new BrowserTask(tab, ask, { goal: 'Open zod', doneWhen: 'The zod page is open' }).run();
      assert.equal(summary.status, 'blocked', summary.reason);
      assert.match(summary.reason, /bot check \(Cloudflare Turnstile;/);
      assert.equal(asked, 0);
      assert.ok(summary.elapsed_ms >= 8000 && summary.elapsed_ms < 12_000, `ended after ${summary.elapsed_ms} ms`);
    },
  },
  {
    name: 'a run on a challenge that clears after 2 s waits it out and goes on to ask the model',
    file: 'bot-wall-clears.html',
    run: async (tab) => {
      let asked = 0;
      const ask: Ask = async () => {
        asked++;
        throw new Error('no model in this check');
      };
      const summary = await new BrowserTask(tab, ask, { goal: 'Read the article', doneWhen: 'The article is open' }).run();
      assert.match(summary.reason, /no model in this check/, summary.reason);
      assert.equal(asked, 1);
      assert.match(summary.title, /Field Notes/);
      assert.ok(summary.elapsed_ms >= 1500 && summary.elapsed_ms < 8000, `ended after ${summary.elapsed_ms} ms`);
    },
  },
  {
    name: 'a pane that scrolls on a page that does not is offered a scroll aimed at it, and scrolling it lists the rows below',
    file: 'nested-pane.html',
    run: async (tab) => {
      const page = await tab.observe();
      const down = page.actions.find((action) => action.id === 'scroll_down');
      assert.ok(down?.at, `no scroll aimed at the pane: ${JSON.stringify(page.actions.filter((a) => a.kind === 'scroll'))}`);
      const pane = await tab.evaluate(`(() => { const r = document.getElementById('pane').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: Math.min(r.bottom, innerHeight) }; })()`);
      assert.ok(down.at.x > pane.left && down.at.x < pane.right && down.at.y > pane.top && down.at.y < pane.bottom, `aimed outside the pane: ${JSON.stringify(down.at)}`);
      assert.ok(!page.actions.some((action) => action.id === 'scroll_up'), 'scroll up offered at the top');
      assert.ok(!find(page.actions, 'link', /^Row 30$/), 'row 30 listed before scrolling');
      const outcome = await tab.act(down, page);
      assert.ok(outcome?.scrolled && outcome.scrolled > 0, `the pane did not move: ${JSON.stringify(outcome)}`);
      const after = await tab.observe();
      assert.ok(find(after.actions, 'link', /^Row 2\d$/), `no lower rows listed after scrolling: ${labelsOf(controls(after.actions))}`);
      assert.ok(after.actions.some((action) => action.id === 'scroll_up' && action.at), 'scroll up not offered after scrolling down');
    },
  },
  {
    name: 'at the end of the list pane, scroll down goes to the smaller pane that still can, and a wheel that moves nothing reports 0',
    file: 'nested-pane.html',
    run: async (tab) => {
      await tab.evaluate(`document.getElementById('pane').scrollTop = 1e6`);
      const page = await tab.observe();
      const inAside = (at?: { x: number; y: number }) => Boolean(at && at.x < 180 && at.y < 56 + 120);
      const down = page.actions.find((action) => action.id === 'scroll_down');
      assert.ok(inAside(down?.at), `scroll down not aimed at the side panel: ${JSON.stringify(down)}`);
      const up = page.actions.find((action) => action.id === 'scroll_up');
      assert.ok(up?.at && !inAside(up.at), `scroll up not aimed at the list pane: ${JSON.stringify(up)}`);
      // The same aim, wheeling down past the end.
      const outcome = await tab.act({ ...up, id: 'scroll_down', delta: 400 }, page);
      assert.equal(outcome?.scrolled, 0, `a wheel past the end moved ${JSON.stringify(outcome)}`);
    },
  },
  {
    name: 'a page whose document scrolls keeps today\'s scroll action, with no aim of its own',
    file: 'below-fold.html',
    run: async (tab) => {
      const page = await tab.observe();
      const down = page.actions.find((action) => action.id === 'scroll_down');
      assert.ok(down, 'scroll down not offered');
      assert.deepEqual(down, { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
    },
  },
  {
    name: 'a link that opens a new tab is noted by its opener and followed with the click counter in place',
    file: 'opens-tab.html',
    run: async (tab) => {
      const page = await tab.observe();
      const link = find(page.actions, 'link', /Open the docs/);
      assert.ok(link, `link not listed: ${labelsOf(page.actions)}`);
      await tab.act(link, page);
      let opened: string[] = [];
      for (let waited = 0; waited < 2000 && !opened.length; waited += 50) {
        opened = tab.takeOpened();
        if (!opened.length) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(opened.length, 1, 'the new tab was not noted');
      const next = await tab.follow(opened[0]);
      try {
        const there = await next.observe();
        assert.match(there.url, /opened-tab\.html$/);
        const button = find(there.actions, 'button', /Mark as read/);
        assert.ok(button, `button not listed in the new tab: ${labelsOf(there.actions)}`);
        // The click goes through the delivery check, so the counter must be in place on this first document.
        await next.act(button, there);
        assert.equal((await fixtureState(next)).read, true);
      } finally {
        await next.close();
      }
      assert.equal(next.closed, true, 'a closed tab does not say so');
      await assert.rejects(next.observe(), StalePage);
    },
  },
  {
    name: 'file inputs are not listed when the caller declared no files',
    file: 'file-upload.html',
    run: async (tab) => {
      const actions = await listed(tab);
      assert.ok(!actions.some((action) => action.kind === 'upload' || action.role === 'file'), `file fields listed: ${labelsOf(actions)}`);
    },
  },
  {
    name: 'with declared files, a hidden file input is listed at its styled button and takes the file',
    file: 'file-upload.html',
    run: async (tab) => {
      tab.want([], { files: true });
      const page = await tab.observe();
      const fields = page.actions.filter((action) => action.kind === 'upload');
      assert.deepEqual(fields.map((field) => field.label), ['Upload a profile picture (file field)', 'CV (file field)'], labelsOf(page.actions));
      const button = await tab.evaluate(`(() => { const r = document.getElementById('choose').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
      assert.deepEqual({ x: fields[0].rect?.x, y: fields[0].rect?.y }, button, 'the hidden field is not marked where its button is');
      await tab.upload(fields[0], page, new URL('./fixture/capabilities/avatar.png', import.meta.url).pathname);
      assert.equal((await fixtureState(tab)).uploaded, 'avatar.png');
      const after = await tab.observe();
      assert.equal(after.actions.find((action) => action.kind === 'upload')?.value, 'avatar.png', 'the chosen file is not shown');
    },
  },
  {
    name: 'with declared files, a click on the styled upload button opens no file picker and the page stays readable',
    file: 'file-upload.html',
    run: async (tab) => {
      tab.want([], { files: true });
      const page = await tab.observe();
      const button = find(page.actions, 'button', /^Upload a profile picture$/);
      assert.ok(button, labelsOf(page.actions));
      await tab.act(button, page);
      assert.ok((await tab.observe()).actions.length > 0);
    },
  },
  {
    name: 'a same-origin iframe is read: its controls sit inside the frame, take typed text and clicks',
    file: 'iframe-same-origin.html',
    run: async (tab) => {
      const page = await tab.observe();
      const field = page.actions.find((action) => action.kind === 'fill' && /Coupon code/.test(action.label));
      const apply = find(page.actions, 'button', /^Apply coupon$/);
      assert.ok(field && apply, `frame controls not listed: ${labelsOf(page.actions)}`);
      assert.ok(find(page.actions, 'button', /^Main action$/), `main control lost: ${labelsOf(page.actions)}`);
      assert.deepEqual(
        controls(page.actions).map((action) => action.id),
        controls(page.actions).map((_, i) => `e${i + 1}`),
        'ids do not continue across the frame',
      );
      assert.ok(apply.frame, 'the frame action does not record its frame');
      assert.ok(insideBox(apply.rect!, await frameBox(tab)), `rect ${JSON.stringify(apply.rect)} is not inside the frame`);
      assert.match(page.text, /\[Frame: Coupon form\]\nCoupon/, `frame text missing: ${page.text}`);
      await tab.act(field, page, 'SPRING10');
      assert.equal(await tab.evaluate(`document.querySelector('iframe').contentDocument.getElementById('code').value`), 'SPRING10');
      const next = await tab.observe();
      await tab.act(find(next.actions, 'button', /^Apply coupon$/)!, next);
      await pause(100);
      assert.equal((await fixtureState(tab)).applied, 'SPRING10');
    },
  },
  {
    name: 'a nested iframe (same-origin inside cross-origin) compounds both offsets and takes clicks',
    file: 'iframe-nested.html',
    run: async (tab) => {
      const page = await tab.observe();
      const apply = find(page.actions, 'button', /^Apply coupon$/);
      assert.ok(apply, `nested frame controls not listed: ${labelsOf(page.actions)}`);
      // The inner form starts inside the outer frame's padding plus the mid page's own margin and frame border.
      const outer = await frameBox(tab);
      assert.ok(insideBox(apply.rect!, outer), `rect ${JSON.stringify(apply.rect)} is not inside the outer frame`);
      assert.ok(apply.rect!.x >= outer.x + 30 + 4 && apply.rect!.y >= outer.y + 12 + 4, `rect ${JSON.stringify(apply.rect)} misses the nested offset`);
      await tab.act(apply, page);
      await pause(100);
      assert.equal((await fixtureState(tab)).applied, '');
    },
  },
  {
    name: 'a cross-origin iframe on a second port is read, clicked, and its confirm is declined and reported',
    file: 'iframe-cross-origin.html',
    run: async (tab) => {
      const page = await tab.observe();
      const field = page.actions.find((action) => action.kind === 'fill' && /Coupon code/.test(action.label));
      const remove = find(page.actions, 'button', /^Remove coupon$/);
      assert.ok(field && remove, `cross-origin frame controls not listed: ${labelsOf(page.actions)}`);
      assert.ok(insideBox(remove.rect!, await frameBox(tab)), `rect ${JSON.stringify(remove.rect)} is not inside the frame`);
      await tab.act(field, page, 'AUTUMN5');
      let next = await tab.observe();
      await tab.act(find(next.actions, 'button', /^Apply coupon$/)!, next);
      await pause(100);
      assert.equal((await fixtureState(tab)).applied, 'AUTUMN5');
      next = await tab.observe();
      await tab.act(find(next.actions, 'button', /^Remove coupon$/)!, next);
      await pause(100);
      assert.equal((await fixtureState(tab)).removed, false, 'the confirm in the frame was accepted');
      assert.deepEqual(tab.takeDialogs(), [{ type: 'confirm', message: 'Remove the coupon?', accepted: false }]);
      // A click the caller confirmed gets OK on its own confirm, from inside the frame too.
      next = await tab.observe();
      tab.armConfirm(['the coupon', 'Remove coupon']);
      await tab.act(find(next.actions, 'button', /^Remove coupon$/)!, next);
      tab.disarmConfirm();
      await pause(100);
      assert.equal((await fixtureState(tab)).removed, true, 'the confirmed confirm in the frame was declined');
      assert.deepEqual(tab.takeDialogs(), [{ type: 'confirm', message: 'Remove the coupon?', accepted: true }]);
    },
  },
  {
    name: 'on a phone, a tap reaches a cross-origin iframe and types into it',
    file: 'iframe-cross-origin.html',
    device: 'iphone-15',
    run: async (tab) => {
      let page = await tab.observe();
      const field = page.actions.find((action) => action.kind === 'fill' && /Coupon code/.test(action.label));
      assert.ok(field, `cross-origin frame controls not listed: ${labelsOf(page.actions)}`);
      await tab.act(field, page, 'PHONE7');
      page = await tab.observe();
      await tab.act(find(page.actions, 'button', /^Apply coupon$/)!, page);
      await pause(100);
      assert.equal((await fixtureState(tab)).applied, 'PHONE7');
    },
  },
  {
    name: 'a scrolled iframe on a scrolled page: rects follow both scrolls, and a wanted row below the frame fold is listed',
    file: 'iframe-scrolled.html',
    run: async (tab) => {
      await tab.evaluate('window.scrollTo(0, 400)');
      await pause(100);
      let page = await tab.observe();
      const links = page.actions.filter((action) => action.role === 'link');
      assert.ok(links.length > 3, `frame rows not listed: ${labelsOf(page.actions)}`);
      assert.ok(!links.some((action) => /^Order 1001$/.test(action.label)), `a row scrolled out of the frame is listed: ${labelsOf(links)}`);
      const box = await frameBox(tab);
      // A row cut by the frame's edge keeps its own rect, as on the page; its centre is what a click aims at.
      const centreInside = (rect: Box) => insideBox({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: 0, h: 0 }, box);
      assert.ok(links.every((action) => centreInside(action.rect!)), `a row centre is outside the frame: ${JSON.stringify(links.map((a) => a.rect))}`);
      const first = links[0];
      await tab.act(first, page);
      await pause(100);
      assert.equal((await fixtureState(tab)).opened, first.label);
      tab.want(['Order 1038']);
      page = await tab.observe();
      const wanted = find(page.actions, 'link', /^Order 1038$/);
      assert.ok(wanted, `the wanted row below the frame fold is not listed: ${labelsOf(page.actions)}`);
      await tab.act(wanted, page);
      await pause(100);
      assert.equal((await fixtureState(tab)).opened, 'Order 1038');
    },
  },
  {
    name: 'a frame cut by the top of the viewport adds only the text that shows',
    file: 'iframe-scrolled.html',
    run: async (tab) => {
      // The page is scrolled until only the bottom 60 px of the orders frame are left on screen.
      await tab.evaluate(`(() => { const f = document.querySelector('iframe'); scrollTo(0, scrollY + f.getBoundingClientRect().bottom - 60); })()`);
      await pause(100);
      const page = await tab.observe();
      const listed = page.actions.filter((action) => action.role === 'link').length;
      const section = page.text.split('[Frame: Orders]')[1] ?? '';
      const rows = section.split('\n').filter((line) => /^Order \d+$/.test(line)).length;
      assert.ok(listed > 0, `no row of the visible strip is listed: ${labelsOf(page.actions)}`);
      // Rows cut at the strip's edge may show text but no centre: at most one more than the listed rows.
      assert.ok(rows <= listed + 1, `the frame adds ${rows} rows of text but only ${listed} rows show: ${section}`);
    },
  },
  {
    name: 'an iframe under a modal is not listed until the modal closes, and a banner over it is a cover',
    file: 'iframe-modal.html',
    run: async (tab) => {
      let page = await tab.observe();
      assert.ok(!page.actions.some((action) => /coupon/i.test(action.label)), `a control under the modal is listed: ${labelsOf(page.actions)}`);
      const gotIt = find(page.actions, 'button', /^Got it$/);
      assert.ok(gotIt, `modal button not listed: ${labelsOf(page.actions)}`);
      await tab.act(gotIt, page);
      page = await tab.observe();
      const apply = find(page.actions, 'button', /^Apply coupon$/);
      assert.ok(apply, `frame controls not listed after the modal closed: ${labelsOf(page.actions)}`);
      // A banner slides over the frame after the page was read: its button is listed, the frame's controls are not.
      await tab.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div class="banner"><button type="button">Dismiss banner</button></div>')`);
      const covered = await tab.observe();
      const dismiss = find(covered.actions, 'button', /^Dismiss banner$/);
      assert.ok(dismiss, `banner button not listed: ${labelsOf(covered.actions)}`);
      assert.ok(!covered.actions.some((action) => /coupon/i.test(action.label)), `a covered frame control is listed: ${labelsOf(covered.actions)}`);
      const error = await tab.act(apply, page).then(() => undefined, (caught) => caught);
      assert.ok(error instanceof TargetUnreachable, `expected TargetUnreachable, got ${error}`);
      assert.deepEqual(error.coverNodes, [dismiss.node], 'the covering banner is not named');
      assert.equal((await fixtureState(tab)).applied, undefined, 'the covered button was clicked');
    },
  },
  {
    name: 'a password field inside an iframe is described as filled, never listed or read',
    file: 'iframe-password.html',
    run: async (tab) => {
      const page = await tab.observe();
      assert.ok(!JSON.stringify(page).includes('secret-5521'), 'the password value reached the page state');
      assert.ok(!page.actions.some((action) => /^Password/.test(action.label)), `the password field is listed: ${labelsOf(page.actions)}`);
      assert.ok(page.actions.some((action) => action.kind === 'fill' && /Username/.test(action.label)), `username not listed: ${labelsOf(page.actions)}`);
      assert.deepEqual(page.passwordFields, [{ name: 'Password', filled: true }]);
      assert.ok(page.text.startsWith('Password field "Password": filled'), `the password line is not first: ${page.text}`);
    },
  },
];

// Serve every page in verify/fixture/reader/ at /<file name> on a random local port, and again on a second port. Frame
// pages reach the second one as {{CROSS_ORIGIN}}, `localhost:<port>`: another origin and another site, so Chrome runs
// those frames in their own process.
const fixtureDir = new URL('./fixture/reader/', import.meta.url);
const pages = Object.fromEntries(readdirSync(fixtureDir).map((file) => [`/${file}`, readFileSync(new URL(file, fixtureDir), 'utf8')]));
const listen = async () => {
  const server = createServer((request, response) => {
    const page = pages[request.url ?? '']?.replaceAll('{{CROSS_ORIGIN}}', crossOrigin);
    response.writeHead(page ? 200 : 404, { 'content-type': 'text/html' }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
};
let crossOrigin = '';
const [main, second] = [await listen(), await listen()];
crossOrigin = `http://localhost:${second.port}`;
const origin = `http://127.0.0.1:${main.port}`;

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
  main.server.close();
  second.server.close();
}

process.stdout.write(`\n${passed}/${checks.length} reader checks passed\n`);
process.exitCode = passed === checks.length ? 0 : 1;
