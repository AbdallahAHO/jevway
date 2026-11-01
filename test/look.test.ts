import { afterEach, describe, expect, it, vi } from 'vitest';
import * as chrome from '../src/browser/chrome.ts';
import { Tab, type PageAction, type PageState } from '../src/browser/tab.ts';
import * as model from '../src/jev/model.ts';
import { lookAt } from '../src/task/look.ts';
import { createRunner } from '../src/task/start-task.ts';

const actions: PageAction[] = [
  { id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Destination', value: 'Lisbon', rect: { x: 1, y: 2, w: 3, h: 4 } },
  { id: 'e2', kind: 'click', node: 1, role: 'textbox', label: 'Open Destination', value: 'Lisbon' },
  { id: 'e3', kind: 'select', node: 2, role: 'combobox', label: 'Guests → 2 guests', value: '2', current_value: '1 guest' },
  { id: 'e4', kind: 'click', node: 3, role: 'checkbox', label: 'Free cancellation', checked: 'true' },
  { id: 'e5', kind: 'click', node: 4, role: 'button', label: 'Sort by', expanded: 'false' },
  { id: 'e6', kind: 'click', node: 5, role: 'button', label: 'Sign in' },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
];

const page = (overrides: Partial<PageState> = {}): PageState => ({
  url: 'http://fixture/stays',
  title: 'Staylist',
  text: 'Password field "Password" is filled\nStays in Lisbon\nCasa Flora',
  w: 1280,
  h: 800,
  actions,
  marker: 1,
  page_key: 1,
  guards: { 1: ['secret-ish guard'] },
  omitted_actions: 0,
  fingerprint: 'f',
  passwordFields: [{ name: 'Password', filled: true }],
  ...overrides,
});

describe('a look at the page', () => {
  it('returns the url, title, page text and each listed control once, with its state', () => {
    expect(lookAt(page())).toEqual({
      url: 'http://fixture/stays',
      title: 'Staylist',
      page_text: 'Password field "Password" is filled\nStays in Lisbon\nCasa Flora',
      elements: [
        { label: 'Destination', role: 'textbox', value: 'Lisbon' },
        { label: 'Guests', role: 'combobox', value: '1 guest' },
        { label: 'Free cancellation', role: 'checkbox', checked: 'true' },
        { label: 'Sort by', role: 'button', expanded: 'false' },
        { label: 'Sign in', role: 'button' },
      ],
      password_fields: [{ name: 'Password', filled: true }],
    });
  });

  it('gives the caller nothing to act on: no node, id, rect or guard', () => {
    const look = JSON.stringify(lookAt(page()));
    for (const key of ['"node"', '"id"', '"rect"', '"guards"', 'secret-ish guard', '"marker"', '"fingerprint"']) expect(look).not.toContain(key);
  });

  it('cuts the page text as a jevway_task summary does', () => {
    const text = 'line of page text\n'.repeat(200).slice(0, 3000);
    expect(lookAt(page({ text })).page_text).toBe(`${text.slice(0, 2500)}\n…[500 more characters not shown]`);
  });

  it('says how many controls the reader left unlisted, only when it left some', () => {
    expect(lookAt(page({ omitted_actions: 12 })).elements_not_listed).toBe(12);
    expect(lookAt(page())).not.toHaveProperty('elements_not_listed');
    expect(lookAt(page({ passwordFields: [] }))).not.toHaveProperty('password_fields');
  });
});

describe('a look through the runner', () => {
  afterEach(() => vi.restoreAllMocks());

  const fakeTab = () => {
    const tab = { observed: 0, closed: 0, observe: async () => (tab.observed++, page()), close: async () => void tab.closed++ };
    return tab;
  };

  it('opens a url in a new tab, reads it, closes it, and asks Jev nothing', async () => {
    const ask = vi.fn();
    vi.spyOn(model, 'createAsk').mockReturnValue(ask);
    vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp: {} } as chrome.ChromeHandle);
    const tab = fakeTab();
    const open = vi.spyOn(Tab, 'open').mockResolvedValue(tab as unknown as Tab);
    const state = await createRunner('launch-headless').look({ url: 'http://fixture/stays' });
    expect(open).toHaveBeenCalledWith({}, 'http://fixture/stays');
    expect(state.title).toBe('Staylist');
    expect(tab).toMatchObject({ observed: 1, closed: 1 });
    expect(ask).not.toHaveBeenCalled();
  });

  it('reads an open tab and leaves it open', async () => {
    vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp: {} } as chrome.ChromeHandle);
    const tab = fakeTab();
    vi.spyOn(Tab, 'find').mockResolvedValue(tab as unknown as Tab);
    await createRunner('launch-headless').look({ tab: 'fixture/stays' });
    expect(tab).toMatchObject({ observed: 1, closed: 0 });
  });
});
