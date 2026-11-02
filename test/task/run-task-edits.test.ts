import { describe, expect, it } from 'vitest';
import type { PageAction, PageState } from '../../src/browser/tab.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { STAYLIST, page, clickTargetOf, scriptedJev, fakeTab } from '../fakes.ts';

describe('DONE right after an unsaved edit', () => {
  const NOT_ACCEPTED = 'not accepted: the last step changed a field and nothing was saved or submitted since';
  // A settings form: a description, a search field (Grafana's alert-rules label), a wiki checkbox and Save. Every page differs, so no step looks like a no-op.
  const settingsPages = () =>
    ['a', 'b', 'c', 'd', 'e', 'f'].map((fingerprint) =>
      page({
        fingerprint,
        actions: [
          { id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Description', value: '' },
          { id: 'e2', kind: 'click', node: 2, role: 'button', label: 'Save settings' },
          { id: 'e3', kind: 'fill', node: 3, role: 'textbox', label: 'Search Search help', value: '' },
          { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
        ],
      }),
    );
  // No text fields here, so BLOCKED is not needs_input.
  const wikiPages = () =>
    ['a', 'b', 'c', 'd', 'e', 'f'].map((fingerprint) =>
      page({
        fingerprint,
        actions: [
          { id: 'e1', kind: 'click', node: 1, role: 'checkbox', label: 'Enable repository wiki', checked: 'false' },
          { id: 'e2', kind: 'click', node: 2, role: 'button', label: 'Save settings' },
          { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
        ],
      }),
    );
  const options = { goal: 'Change the description', values: { description: 'A demo app', query: 'zod' }, doneWhen: 'The change is saved', changeWaitMs: 0 };
  const notes = (steps: { not_executed?: string }[]) => steps.filter((step) => step.not_executed?.startsWith(NOT_ACCEPTED));
  const type = (target: string, key: string) => ({ operation: 'TYPE_TEXT', type_text_target: target, [`value_for_${target}`]: key });

  it('sends a DONE back once after a typed field was never saved, and accepts it once Save was clicked', async () => {
    const { ask, requests } = scriptedJev([
      type('1', 'description'),
      { operation: 'DONE', done_check: 0.61 },
      { operation: 'CLICK', click_target: '2', done_check: 0.61 },
      { operation: 'DONE', done_check: 0.61 },
    ]);
    const { asTab, acted } = fakeTab(settingsPages());
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.61 });
    expect(requests).toHaveLength(4);
    expect(acted.map((a) => a.label)).toEqual(['Description', 'Save settings']);
    expect(notes(summary.steps)).toHaveLength(1);
    expect(JSON.stringify(requests[2])).toContain(NOT_ACCEPTED);
  });

  it('sends a BLOCKED-as-done back after a ticked checkbox was never saved', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'CLICK', click_target: '1' },
      { operation: 'BLOCKED', done_check: 0.6 },
      { operation: 'CLICK', click_target: '2', done_check: 0.6 },
      { operation: 'BLOCKED', done_check: 0.6 },
    ]);
    const { asTab, acted } = fakeTab(wikiPages());
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.6 });
    expect(requests).toHaveLength(4);
    expect(acted.map((a) => a.label)).toEqual(['Enable repository wiki', 'Save settings']);
    expect(notes(summary.steps)).toHaveLength(1);
  });

  it('accepts a DONE after an edit when the done check is at the bar', async () => {
    const { ask, requests } = scriptedJev([type('1', 'description'), { operation: 'DONE', done_check: 0.8 }]);
    const { asTab } = fakeTab(settingsPages());
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.8 });
    expect(requests).toHaveLength(2);
    expect(notes(summary.steps)).toHaveLength(0);
  });

  it('takes a picker option that closes on click as applied, not as an unsaved edit', async () => {
    const withOption = page({
      fingerprint: 'open',
      actions: [
        { id: 'e1', kind: 'click', node: 1, role: 'radio', label: 'Last 6 hours', checked: 'false' },
        { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
      ],
    });
    const closed = page({ fingerprint: 'closed', actions: [{ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }] });
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.54 }]);
    const { asTab, acted } = fakeTab([withOption, closed, closed]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.54 });
    expect(requests).toHaveLength(2);
    expect(acted.map((a) => a.label)).toEqual(['Last 6 hours']);
    expect(notes(summary.steps)).toHaveLength(0);
  });

  it('takes typing into a search field as nothing to save', async () => {
    const { ask, requests } = scriptedJev([type('3', 'query'), { operation: 'DONE', done_check: 0.6 }]);
    const { asTab, acted } = fakeTab(settingsPages());
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.6 });
    expect(requests).toHaveLength(2);
    expect(acted.map((a) => a.label)).toEqual(['Search Search help']);
    expect(notes(summary.steps)).toHaveLength(0);
  });

  it('notes an edit only once, so the same DONE with no new action ends the run', async () => {
    const { ask, requests } = scriptedJev([type('1', 'description'), { operation: 'DONE', done_check: 0.61 }]);
    const { asTab, acted } = fakeTab(settingsPages());
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.61 });
    expect(requests).toHaveLength(3);
    expect(acted.map((a) => a.label)).toEqual(['Description']);
    expect(notes(summary.steps)).toHaveLength(1);
  });
});

describe('a risky submit chosen again after the page answered it', () => {
  const FORM_URL = 'http://fixture/repo/create';
  const BEFORE = 'New repository\nRepository name\nCreate repository';
  const BANNER = 'Repository name should contain only alphanumeric, dash ("-"), underscore ("_") and dot (".") characters.';
  const REJECTED = `${BEFORE}\n${BANNER}`;
  const control = (label: string, node: number, kind: 'click' | 'fill' = 'click'): PageAction =>
    kind === 'fill'
      ? { id: `e${node}`, kind, node, role: 'textbox', label, value: '' }
      : { id: `e${node}`, kind, node, role: 'button', label };
  const SCROLL: PageAction = { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 600 };
  // The create form: a name field and the submit; every page differs by fingerprint so no step looks like a no-op.
  const formPage = (fingerprint: string, text: string, overrides: Partial<PageState> = {}) =>
    page({ url: FORM_URL, fingerprint, text, actions: [control('Repository name', 1, 'fill'), control('Create repository', 2), SCROLL], ...overrides });
  const submit = { operation: 'CLICK', click_target: '2', commit_risk: 0.8 };
  const type = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'name' };
  const options = { goal: 'Create a new repository named with the text in name.', values: { name: 'my repo!' }, changeWaitMs: 0, maxSteps: 8 };

  it('hands a rejected submit back blocked, quoting what the page then said', async () => {
    const { ask } = scriptedJev([type, submit, submit]);
    const { asTab, acted } = fakeTab([formPage('a', BEFORE), formPage('b', BEFORE), formPage('c', REJECTED)]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('"Create repository" was already submitted on this page');
    expect(summary.reason).toContain(`the page then said: "${BANNER}"`);
    expect(acted.map((a) => a.label)).toEqual(['Repository name', 'Create repository']);
  });

  it('leaves out new lines with no words, like a footer render time that changes on every load', async () => {
    const { ask } = scriptedJev([type, submit, submit]);
    const { asTab } = fakeTab([
      formPage('a', `${BEFORE}\nPage:\n3ms`),
      formPage('b', `${BEFORE}\nPage:\n3ms`),
      formPage('c', `${REJECTED}\nPage:\n2ms`),
    ]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain(`the page then said: "${BANNER}". Submitting it again`);
  });

  it('still quotes the text the page said right after the submit once a scroll took it off the page', async () => {
    const { ask } = scriptedJev([type, submit, { operation: 'SCROLL_DOWN' }, submit]);
    const { asTab, acted } = fakeTab([formPage('a', BEFORE), formPage('b', BEFORE), formPage('c', REJECTED), formPage('d', BEFORE)]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain(`the page then said: "${BANNER}"`);
    expect(acted.map((a) => a.label)).toEqual(['Repository name', 'Create repository', 'Scroll down']);
  });

  it('asks for confirmation as before when the typed field is gone: the next step of a wizard', async () => {
    const step1 = (fingerprint: string) =>
      page({ url: 'http://fixture/signup', fingerprint, text: 'Step 1\nFull name', actions: [control('Full name', 1, 'fill'), control('Continue', 2)] });
    const step2 = page({ url: 'http://fixture/signup', fingerprint: 'c', text: 'Step 2\nChoose a plan', actions: [control('Continue', 2)] });
    const { ask } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'name' }, submit, submit]);
    const { asTab, acted } = fakeTab([step1('a'), step1('b'), step2]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('needs_confirmation');
    expect(summary.reason).toContain('"Continue" on "Staylist" looks irreversible');
    expect(acted.map((a) => a.label)).toEqual(['Full name', 'Continue']);
  });

  it('asks for confirmation as before when the submit took the page to another path', async () => {
    const created = formPage('c', 'ada/new-repo\nCreate repository', { url: 'http://fixture/ada/new-repo' });
    const { ask } = scriptedJev([type, submit, submit]);
    const { asTab, acted } = fakeTab([formPage('a', BEFORE), formPage('b', BEFORE), created]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('needs_confirmation');
    expect(summary.reason).toContain('"Create repository" on "Staylist" looks irreversible');
    expect(acted.map((a) => a.label)).toEqual(['Repository name', 'Create repository']);
  });

  it('remembers the rejection across calls: confirm in one, rejected in the next', async () => {
    const { ask } = scriptedJev([type, submit, submit, submit]);
    const { asTab, acted } = fakeTab([formPage('a', BEFORE), formPage('b', BEFORE), formPage('b2', BEFORE), formPage('c', REJECTED)]);
    const task = new BrowserTask(asTab, ask, options);
    const first = await task.run();
    expect(first.status).toBe('needs_confirmation');
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const second = await task.run();
    expect(second.status).toBe('blocked');
    expect(second.reason).toContain(`the page then said: "${BANNER}"`);
    expect(acted.map((a) => a.label)).toEqual(['Repository name', 'Create repository']);
  });

  it('ignores a field typed on an earlier page: only the form that was submitted counts', async () => {
    const search = page({ url: 'http://fixture/explore', fingerprint: 'e', text: 'Explore', actions: [control('Search repositories', 3, 'fill')] });
    const { ask } = scriptedJev([type, type, submit, submit]);
    const { asTab } = fakeTab([search, formPage('a', BEFORE), formPage('b', BEFORE), formPage('c', REJECTED)]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain(`the page then said: "${BANNER}"`);
  });

  it('leaves a repeated risky label alone when no field was typed before it (a list of Delete buttons)', async () => {
    const list = (fingerprint: string, text: string) =>
      page({ url: 'http://fixture/items', fingerprint, text, actions: [control('Delete', 1)] });
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', commit_risk: 0.8 }]);
    const { asTab } = fakeTab([list('a', '2 items\nDelete'), list('b', '1 item\nItem deleted\nDelete')]);
    const task = new BrowserTask(asTab, ask, options);
    task.update({ confirmIrreversible: true, confirmTarget: 'items' });
    const summary = await task.run();
    expect(summary.status).toBe('needs_confirmation');
    expect(summary.reason).toContain('"Delete" on "Staylist" looks irreversible');
  });
});

describe('what the page said after a submit stays in front of Jev while the run stays on the page', () => {
  const FORM_URL = 'http://fixture/ada/app/settings';
  const CHROME = 'Issues\nPull requests\nSettings';
  const BEFORE = `${CHROME}\nDescription\nSave settings`;
  const FLASH = 'Your settings have been updated.';
  const control = (label: string, node: number, role = 'button'): PageAction => ({ id: `e${node}`, kind: 'click', node, role, label });
  const SCROLL: PageAction = { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 600 };
  // A settings page; every page differs by fingerprint so no step looks like a no-op.
  const settingsPage = (fingerprint: string, text: string, url = FORM_URL) =>
    page({ url, fingerprint, text, actions: [control('Save settings', 1), control('Billing', 2, 'link'), SCROLL] });
  const save = { operation: 'CLICK', click_target: '1', commit_risk: 0.8 };
  const billing = { operation: 'CLICK', click_target: '2', commit_risk: 0 };
  const scroll = { operation: 'SCROLL_DOWN' };
  const done = { operation: 'DONE', done_check: 0.9 };
  const options = { goal: 'Save the settings', doneWhen: 'The settings are saved', changeWaitMs: 0 };
  const said = (text: string) => `[Page message after "Save settings"] ${text}`;
  const textOf = (request: any): string => request.state.page.text;
  const confirmed = (task: BrowserTask) => task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });

  it('puts the new text the page showed after a risky click on top of the page text of the next request', async () => {
    const { ask, requests } = scriptedJev([save, done]);
    const { asTab } = fakeTab([settingsPage('a', BEFORE), settingsPage('b', `${BEFORE}\n${FLASH}`)]);
    const task = new BrowserTask(asTab, ask, options);
    confirmed(task);
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(textOf(requests[1])).toBe(`${said(FLASH)}\n${BEFORE}\n${FLASH}`);
    // The caller's view is untouched: neither the page text nor the step carries the line.
    expect(summary.page_text).toBe(`${BEFORE}\n${FLASH}`);
    expect(summary.steps[0].element).toBe('Save settings');
  });

  it('keeps it after the run scrolled the new text off the page', async () => {
    const { ask, requests } = scriptedJev([save, scroll, scroll, done]);
    const { asTab } = fakeTab([
      settingsPage('a', BEFORE),
      settingsPage('b', `${BEFORE}\n${FLASH}`),
      settingsPage('c', 'Wiki\nEnable repository wiki'),
      settingsPage('d', 'Danger zone\nDelete repository'),
    ]);
    const task = new BrowserTask(asTab, ask, options);
    confirmed(task);
    await task.run();
    expect(textOf(requests.at(-1))).toBe(`${said(FLASH)}\nDanger zone\nDelete repository`);
  });

  it('quotes only lines the run never saw on that path, so the chrome of a reloaded page drops out', async () => {
    const { ask, requests } = scriptedJev([scroll, save, done]);
    const { asTab } = fakeTab([
      settingsPage('a', BEFORE),
      settingsPage('b', 'Wiki\nEnable repository wiki\nSave settings'),
      settingsPage('c', `${CHROME}\n${FLASH}\nDescription\nSave settings`),
    ]);
    const task = new BrowserTask(asTab, ask, options);
    confirmed(task);
    await task.run();
    expect(textOf(requests.at(-1)).split('\n')[0]).toBe(said(FLASH));
  });

  it('drops it when the run moves to another path', async () => {
    const { ask, requests } = scriptedJev([save, billing, done]);
    const { asTab } = fakeTab([
      settingsPage('a', BEFORE),
      settingsPage('b', `${BEFORE}\n${FLASH}`),
      settingsPage('c', 'Billing\nYour plan', 'http://fixture/ada/app/billing'),
    ]);
    const task = new BrowserTask(asTab, ask, options);
    confirmed(task);
    await task.run();
    expect(textOf(requests[1])).toContain(said(FLASH));
    expect(textOf(requests[2])).toBe('Billing\nYour plan');
  });

  it('adds nothing when the page showed nothing new', async () => {
    const { ask, requests } = scriptedJev([save, done]);
    const { asTab } = fakeTab([settingsPage('a', BEFORE), settingsPage('b', BEFORE)]);
    const task = new BrowserTask(asTab, ask, options);
    confirmed(task);
    await task.run();
    expect(textOf(requests[1])).toBe(BEFORE);
  });

  it('keeps the quote at 300 characters', async () => {
    const { ask, requests } = scriptedJev([save, done]);
    const long = 'The settings were updated. '.repeat(40).trim();
    const { asTab } = fakeTab([settingsPage('a', BEFORE), settingsPage('b', `${BEFORE}\n${long}`)]);
    const task = new BrowserTask(asTab, ask, options);
    confirmed(task);
    await task.run();
    const quote = textOf(requests[1]).split('\n')[0].match(/^\[Page message after "Save settings"\] (.*)$/)?.[1];
    expect(quote).toBeDefined();
    expect(quote!.length).toBeLessThanOrEqual(300);
  });

  describe('a save that was not judged risky', () => {
    const wikiPage = (fingerprint: string, text: string) =>
      page({
        url: FORM_URL,
        fingerprint,
        text,
        actions: [{ ...control('Enable repository wiki', 1, 'checkbox'), checked: 'true' }, control('Save settings', 2), control('Billing', 3, 'link'), SCROLL],
      });
    const tick = { operation: 'CLICK', click_target: '1', commit_risk: 0 };
    const saveQuietly = { operation: 'CLICK', click_target: '2', commit_risk: 0.1 };

    it('is quoted when it saves a pending edit, and the quote survives scrolling', async () => {
      const { ask, requests } = scriptedJev([tick, saveQuietly, scroll, scroll, done]);
      const { asTab } = fakeTab([
        wikiPage('a', BEFORE),
        wikiPage('b', BEFORE),
        wikiPage('c', `${BEFORE}\n${FLASH}`),
        wikiPage('d', 'Wiki\nEnable repository wiki'),
        wikiPage('e', 'Danger zone\nDelete repository'),
      ]);
      await new BrowserTask(asTab, ask, options).run();
      expect(textOf(requests.at(-1))).toBe(`${said(FLASH)}\nDanger zone\nDelete repository`);
    });

    it('quotes a repeated message again after a second save', async () => {
      const { ask, requests } = scriptedJev([tick, saveQuietly, tick, saveQuietly, done]);
      const { asTab } = fakeTab([
        wikiPage('a', BEFORE),
        wikiPage('b', BEFORE),
        wikiPage('c', `${BEFORE}\n${FLASH}`),
        wikiPage('d', `${BEFORE}\n${FLASH}`),
        wikiPage('e', `${BEFORE}\n${FLASH}`),
      ]);
      await new BrowserTask(asTab, ask, options).run();
      expect(textOf(requests[2]).split('\n')[0]).toBe(said(FLASH));
      expect(textOf(requests[4]).split('\n')[0]).toBe(said(FLASH));
    });

    it('drops it at the next save when that one showed nothing new', async () => {
      const { ask, requests } = scriptedJev([tick, saveQuietly, tick, saveQuietly, done]);
      const { asTab } = fakeTab([
        wikiPage('a', BEFORE),
        wikiPage('b', BEFORE),
        wikiPage('c', `${BEFORE}\n${FLASH}`),
        wikiPage('d', BEFORE),
        wikiPage('e', BEFORE),
      ]);
      await new BrowserTask(asTab, ask, options).run();
      expect(textOf(requests[3]).split('\n')[0]).toBe(said(FLASH));
      expect(textOf(requests[4])).toBe(BEFORE);
    });

    it('is not added for the edit itself, even when it changes the text', async () => {
      const { ask, requests } = scriptedJev([tick, done]);
      const { asTab } = fakeTab([wikiPage('a', BEFORE), wikiPage('b', `${BEFORE}\nWiki is on`)]);
      await new BrowserTask(asTab, ask, options).run();
      expect(textOf(requests[1])).toBe(`${BEFORE}\nWiki is on`);
    });

    it('is not added for a navigation link when nothing is unsaved', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '3', commit_risk: 0 }, done]);
      const { asTab } = fakeTab([wikiPage('a', BEFORE), wikiPage('b', `${BEFORE}\nYour plan was updated yesterday.`)]);
      await new BrowserTask(asTab, ask, options).run();
      expect(textOf(requests[1])).toBe(`${BEFORE}\nYour plan was updated yesterday.`);
    });

    it('is not added for a Save with nothing edited before it', async () => {
      const { ask, requests } = scriptedJev([saveQuietly, done]);
      const { asTab } = fakeTab([wikiPage('a', BEFORE), wikiPage('b', `${BEFORE}\n${FLASH}`)]);
      await new BrowserTask(asTab, ask, options).run();
      expect(textOf(requests[1])).toBe(`${BEFORE}\n${FLASH}`);
    });
  });
});

describe('a checkbox or switch the run flipped is not flipped back without a word', () => {
  const WIKI = 'Enable repository wiki';
  const UNITS = 'http://fixture/ada/app/settings/units';
  const WEBHOOKS = 'http://fixture/ada/app/settings/hooks';
  const UNSAVED_NOTE =
    'not accepted: "Enable repository wiki" is now unchecked because this run clicked it, and nothing on this page was clicked after it to save it; clicking it again undoes it. Save it (a Save or Update button), or answer BLOCKED';
  const savedNote = (clicked: string) =>
    `not accepted: "Enable repository wiki" is now unchecked because this run clicked it, and "${clicked}" was clicked after it; clicking it again undoes it. Answer DONE if the goal is met, or BLOCKED`;
  const REJECTED = 'rejected: "The wiki is off and saved" is not visible yet';
  const UNSAVED_REJECTED = `${REJECTED}; "Enable repository wiki" was changed and nothing on this page was clicked after it to save it`;
  const KEEP_WORKING = `${REJECTED}; keep working toward it`;
  const SCROLL: PageAction = { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 600 };
  const BLOCKED =
    'Jev chose "Enable repository wiki" again, which would undo this run\'s own change (it is now unchecked); say which state it should end in.';
  const options = { goal: 'Turn off the wiki for this repository', doneWhen: 'The wiki is off and saved', changeWaitMs: 0 };
  const done = { operation: 'DONE', done_check: 0.9 };
  const control = (node: number, label: string, role: string, checked?: string): PageAction => ({
    id: `e${node}`,
    kind: 'click',
    node,
    role,
    label,
    ...(checked && { checked }),
  });
  // The wiki settings: the box, Save and a link out; every page differs by fingerprint, so no step looks like a no-op.
  const settings = (fingerprint: string, checked: string, { url = UNITS, node = 1, role = 'checkbox', extras = [] as PageAction[] } = {}) =>
    page({ url, fingerprint, actions: [control(node, WIKI, role, checked), control(node + 1, 'Save settings', 'button'), ...extras] });
  const pick = (state: PageState, label: string) => ({ operation: 'CLICK', click_target: clickTargetOf(state, label) });
  const notes = (steps: { not_executed?: string }[]) => steps.filter((step) => step.not_executed).map((step) => step.not_executed);
  // Another path for a scroll to land on, as a client-side redirect would.
  const hooks = (fingerprint: string) => page({ url: WEBHOOKS, fingerprint, actions: [control(1, 'Add webhook', 'button')] });

  it('feeds back a second pick of the box the run just unticked, and goes on with Save', async () => {
    const [on, off, offAgain, saved] = [settings('a', 'true'), settings('b', 'false'), settings('c', 'false'), settings('d', 'false')];
    const { ask, requests } = scriptedJev([pick(on, WIKI), pick(off, WIKI), pick(offAgain, 'Save settings'), done]);
    const { asTab, acted } = fakeTab([on, off, offAgain, saved]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary.status).toBe('done');
    expect(acted.map((a) => a.label)).toEqual([WIKI, 'Save settings']);
    expect(summary.steps.map((step) => [step.operation, step.element, step.not_executed])).toEqual([
      ['CLICK', WIKI, undefined],
      ['CLICK', '', UNSAVED_NOTE],
      ['CLICK', 'Save settings', undefined],
    ]);
    expect(JSON.stringify(requests[2])).toContain('nothing on this page was clicked after it to save it');
  });

  it('still feeds it back after Save reloaded the page with new node ids: the key is path and label', async () => {
    const [on, off] = [settings('a', 'true'), settings('b', 'false')];
    const [reloaded, afterNote] = [settings('c', 'false', { node: 11 }), settings('d', 'false', { node: 11 })];
    const { ask } = scriptedJev([pick(on, WIKI), pick(off, 'Save settings'), pick(reloaded, WIKI), done]);
    const { asTab, acted } = fakeTab([on, off, reloaded, afterNote]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary.status).toBe('done');
    expect(acted.map((a) => a.label)).toEqual([WIKI, 'Save settings']);
    expect(notes(summary.steps)).toEqual([savedNote('Save settings')]);
  });

  it('hands the run back blocked when Jev picks the box again after the note, without clicking it', async () => {
    const [on, off, offAgain, offThrice] = [settings('a', 'true'), settings('b', 'false'), settings('c', 'false'), settings('d', 'false')];
    const { ask, requests } = scriptedJev([pick(on, WIKI), pick(off, WIKI), pick(offAgain, WIKI)]);
    const { asTab, acted } = fakeTab([on, off, offAgain, offThrice]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(summary).toMatchObject({ status: 'blocked', reason: BLOCKED });
    expect(acted.map((a) => a.label)).toEqual([WIKI]);
    expect(notes(summary.steps)).toEqual([UNSAVED_NOTE]);
    expect(requests).toHaveLength(3);
  });

  it('describes a box the run ticked as checked', async () => {
    const [off, on, onAgain] = [settings('a', 'false'), settings('b', 'true'), settings('c', 'true')];
    const { ask } = scriptedJev([pick(off, WIKI), pick(on, WIKI), done]);
    const { asTab } = fakeTab([off, on, onAgain]);
    const summary = await new BrowserTask(asTab, ask, { ...options, goal: 'Turn on the wiki' }).run();
    expect(notes(summary.steps)).toEqual([UNSAVED_NOTE.replace('is now unchecked', 'is now checked')]);
  });

  it('runs a switch the same way as a checkbox', async () => {
    const [on, off, offAgain] = [settings('a', 'true', { role: 'switch' }), settings('b', 'false', { role: 'switch' }), settings('c', 'false', { role: 'switch' })];
    const { ask } = scriptedJev([pick(on, WIKI), pick(off, WIKI), done]);
    const { asTab, acted } = fakeTab([on, off, offAgain]);
    const summary = await new BrowserTask(asTab, ask, options).run();
    expect(acted.map((a) => a.label)).toEqual([WIKI]);
    expect(notes(summary.steps)).toEqual([UNSAVED_NOTE]);
  });

  describe('says whether anything was clicked after the change', () => {
    const tracker = (checked: string) => control(7, 'Enable issue tracker', 'checkbox', checked);
    const withTracker = (fingerprint: string, wiki: string, issues: string) =>
      page({ fingerprint, url: UNITS, actions: [control(1, WIKI, 'checkbox', wiki), tracker(issues), control(2, 'Save settings', 'button')] });

    it('names the click that followed the change, on the same page', async () => {
      const [on, off, saved, afterNote] = [settings('a', 'true'), settings('b', 'false'), settings('c', 'false'), settings('d', 'false')];
      const { ask, requests } = scriptedJev([pick(on, WIKI), pick(off, 'Save settings'), pick(saved, WIKI), done]);
      const { asTab, acted } = fakeTab([on, off, saved, afterNote]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Save settings']);
      expect(notes(summary.steps)).toEqual([savedNote('Save settings')]);
      expect(JSON.stringify(requests[3])).toContain('was clicked after it; clicking it again undoes it. Answer DONE if the goal is met, or BLOCKED');
    });

    it('does not count a scroll in between', async () => {
      const extras = [SCROLL];
      const [on, off, scrolled, offAgain] = ['a', 'b', 'c', 'd'].map((fingerprint, i) => settings(fingerprint, i === 0 ? 'true' : 'false', { extras }));
      const { ask } = scriptedJev([pick(on, WIKI), { operation: 'SCROLL_DOWN' }, pick(scrolled, WIKI), done]);
      const { asTab, acted } = fakeTab([on, off, scrolled, offAgain]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Scroll down']);
      expect(notes(summary.steps)).toEqual([UNSAVED_NOTE]);
    });

    it('does not count flipping another box, which saves nothing', async () => {
      const [start, wikiOff, bothOff, afterNote] = [withTracker('a', 'true', 'true'), withTracker('b', 'false', 'true'), withTracker('c', 'false', 'false'), withTracker('d', 'false', 'false')];
      const { ask } = scriptedJev([pick(start, WIKI), pick(wikiOff, 'Enable issue tracker'), pick(bothOff, WIKI), done]);
      const { asTab, acted } = fakeTab([start, wikiOff, bothOff, afterNote]);
      const summary = await new BrowserTask(asTab, ask, { ...options, goal: 'Turn off the wiki and the issue tracker' }).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Enable issue tracker']);
      expect(notes(summary.steps)).toEqual([UNSAVED_NOTE]);
    });

    it('does not count a click on another path', async () => {
      const [on, off] = [settings('a', 'true', { extras: [SCROLL] }), settings('b', 'false', { extras: [SCROLL] })];
      const [elsewhere, back, afterNote] = [hooks('c'), settings('d', 'false'), settings('e', 'false')];
      const { ask } = scriptedJev([pick(on, WIKI), { operation: 'SCROLL_DOWN' }, pick(elsewhere, 'Add webhook'), pick(back, WIKI), done]);
      const { asTab, acted } = fakeTab([on, off, elsewhere, back, afterNote]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Scroll down', 'Add webhook']);
      expect(notes(summary.steps)).toEqual([UNSAVED_NOTE]);
    });
  });

  describe('a rejected DONE', () => {
    const rejected = { operation: 'DONE', done_check: 0.2 };

    it('names a change nothing was clicked after to save, and goes on with Save', async () => {
      const [on, off, offAgain, saved] = [settings('a', 'true'), settings('b', 'false'), settings('c', 'false'), settings('d', 'false')];
      const { ask, requests } = scriptedJev([pick(on, WIKI), rejected, pick(offAgain, 'Save settings'), done]);
      const { asTab, acted } = fakeTab([on, off, offAgain, saved]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Save settings']);
      expect(notes(summary.steps)).toEqual([UNSAVED_REJECTED]);
      expect(JSON.stringify(requests[2])).toContain('was changed and nothing on this page was clicked after it to save it');
    });

    it('keeps its text once something was clicked after the change', async () => {
      const [on, off, saved, afterNote] = [settings('a', 'true'), settings('b', 'false'), settings('c', 'false'), settings('d', 'false')];
      const { ask } = scriptedJev([pick(on, WIKI), pick(off, 'Save settings'), rejected, done]);
      const { asTab } = fakeTab([on, off, saved, afterNote]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(notes(summary.steps)).toEqual([KEEP_WORKING]);
    });

    it('keeps its text when the page no longer shows the state the run left', async () => {
      const extras = [SCROLL];
      const [on, off, flipped, afterNote] = [settings('a', 'true', { extras }), settings('b', 'false', { extras }), settings('c', 'true', { extras }), settings('d', 'true', { extras })];
      const { ask } = scriptedJev([pick(on, WIKI), { operation: 'SCROLL_DOWN' }, rejected, done]);
      const { asTab } = fakeTab([on, off, flipped, afterNote]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(notes(summary.steps)).toEqual([KEEP_WORKING]);
    });

    it('keeps its text on another path than the change', async () => {
      const [on, off] = [settings('a', 'true', { extras: [SCROLL] }), settings('b', 'false', { extras: [SCROLL] })];
      const [elsewhere, afterNote] = [hooks('c'), hooks('d')];
      const { ask } = scriptedJev([pick(on, WIKI), { operation: 'SCROLL_DOWN' }, rejected, done]);
      const { asTab } = fakeTab([on, off, elsewhere, afterNote]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(notes(summary.steps)).toEqual([KEEP_WORKING]);
    });
  });

  describe('says nothing', () => {
    it('for a box the run never clicked', async () => {
      const [off, on, onAgain] = [settings('a', 'false'), settings('b', 'true'), settings('c', 'true')];
      const { ask } = scriptedJev([pick(off, WIKI), done]);
      const { asTab, acted } = fakeTab([off, on, onAgain]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI]);
      expect(notes(summary.steps)).toEqual([]);
    });

    it('for a different box on the page', async () => {
      const issues = (checked: string) => control(7, 'Enable issue tracker', 'checkbox', checked);
      const withIssues = (fingerprint: string, wiki: string, tracker: string) =>
        page({ fingerprint, url: UNITS, actions: [control(1, WIKI, 'checkbox', wiki), issues(tracker), control(2, 'Save settings', 'button')] });
      const [start, wikiOff, trackerOff] = [withIssues('a', 'true', 'true'), withIssues('b', 'false', 'true'), withIssues('c', 'false', 'false')];
      const { ask } = scriptedJev([pick(start, WIKI), pick(wikiOff, 'Enable issue tracker'), done]);
      const { asTab, acted } = fakeTab([start, wikiOff, trackerOff]);
      const summary = await new BrowserTask(asTab, ask, { ...options, goal: 'Turn off the wiki and the issue tracker' }).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Enable issue tracker']);
      expect(notes(summary.steps)).toEqual([]);
    });

    it('for a radio: picking it again changes nothing, and it is no undo', async () => {
      const [first, second, third] = [settings('a', 'false', { role: 'radio' }), settings('b', 'true', { role: 'radio' }), settings('c', 'true', { role: 'radio' })];
      const { ask } = scriptedJev([pick(first, WIKI), pick(second, WIKI), done]);
      const { asTab, acted } = fakeTab([first, second, third]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, WIKI]);
      expect(notes(summary.steps)).toEqual([]);
    });

    it('for a box with the same label on another path', async () => {
      const link = control(9, 'Webhooks', 'link');
      const [on, off] = [settings('a', 'true', { extras: [link] }), settings('b', 'false', { extras: [link] })];
      const hooks = settings('c', 'false', { url: WEBHOOKS });
      const { ask } = scriptedJev([pick(on, WIKI), pick(off, 'Webhooks'), pick(hooks, WIKI), done]);
      const { asTab, acted } = fakeTab([on, off, hooks, settings('d', 'true', { url: WEBHOOKS })]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Webhooks', WIKI]);
      expect(notes(summary.steps)).toEqual([]);
    });

    it('for a box the page flipped since: its state no longer matches what the run left, so the click is no undo', async () => {
      const reset = control(9, 'Reset form', 'button');
      const [on, off] = [settings('a', 'true', { extras: [reset] }), settings('b', 'false', { extras: [reset] })];
      const flipped = settings('c', 'true', { extras: [reset] });
      const { ask } = scriptedJev([pick(on, WIKI), pick(off, 'Reset form'), pick(flipped, WIKI), done]);
      const { asTab, acted } = fakeTab([on, off, flipped, settings('d', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, 'Reset form', WIKI]);
      expect(notes(summary.steps)).toEqual([]);
    });

    it('for a click that left the box showing the same state (a filter row that selects only itself)', async () => {
      const [all, only, onlyAgain] = [settings('a', 'true'), settings('b', 'true'), settings('c', 'true')];
      const { ask } = scriptedJev([pick(all, WIKI), pick(only, WIKI), done]);
      const { asTab, acted } = fakeTab([all, only, onlyAgain]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted.map((a) => a.label)).toEqual([WIKI, WIKI]);
      expect(notes(summary.steps)).toEqual([]);
    });
  });

  describe('when the caller gives a new goal', () => {
    const pages = () => [settings('a', 'true'), settings('b', 'false'), settings('c', 'false'), settings('d', 'true')];

    it('forgets what the run flipped, so turning it back on is not noted', async () => {
      const [on, , offAgain] = pages();
      const { ask } = scriptedJev([pick(on, WIKI), done, pick(offAgain, WIKI), done]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('done');
      task.update({ goal: 'Turn the wiki back on' });
      const summary = await task.run();
      expect(summary.status).toBe('done');
      expect(acted.map((a) => a.label)).toEqual([WIKI, WIKI]);
      expect(notes(summary.steps)).toEqual([]);
    });

    it('keeps it when the goal is unchanged', async () => {
      const [on, , offAgain] = pages();
      const { ask } = scriptedJev([pick(on, WIKI), done, pick(offAgain, WIKI), done]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      await task.run();
      task.update({ goal: options.goal, maxSteps: 12 });
      const summary = await task.run();
      expect(acted.map((a) => a.label)).toEqual([WIKI]);
      expect(notes(summary.steps)).toEqual([UNSAVED_NOTE]);
    });
  });
});
