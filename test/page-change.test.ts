import { describe, expect, it } from 'vitest';
import type { PageAction, PageState } from '../src/browser/tab.ts';
import { lastChange } from '../src/jev/page-change.ts';

const pageOf = (actions: PageAction[], overrides: Partial<PageState> = {}): PageState => ({
  url: 'http://app/list',
  title: 'List',
  text: 'Your list',
  w: 1280,
  h: 800,
  actions,
  marker: 1,
  page_key: 1,
  guards: {},
  omitted_actions: 0,
  fingerprint: 'x',
  ...overrides,
});

const checkbox = (node: number, label: string, checked: string): PageAction => ({ id: `c${node}`, kind: 'click', node, role: 'checkbox', label, checked });
const button = (node: number, label: string): PageAction => ({ id: `b${node}`, kind: 'click', node, role: 'button', label });
const field = (node: number, label: string, value: string): PageAction => ({ id: `f${node}`, kind: 'fill', node, role: 'textbox', label, value });
const CLICK = { operation: 'CLICK', element: 'Walk the dog' };

describe('what the last action changed', () => {
  it('names a ticked checkbox and nothing else', () => {
    const before = pageOf([checkbox(1, 'Walk the dog', 'false'), button(2, 'Save')]);
    const after = pageOf([checkbox(1, 'Walk the dog', 'true'), button(2, 'Save')]);
    expect(lastChange(before, after, CLICK)).toEqual({
      after: 'CLICK Walk the dog',
      changed: ['checkbox "Walk the dog": checked false -> true'],
    });
  });

  it("names a typed field's new value and a select's shown value", () => {
    const select = (current: string): PageAction => ({ id: 's', kind: 'select', node: 3, role: 'combobox', label: 'Guests → 2 guests', value: '2', current_value: current });
    const before = pageOf([field(1, 'Title', ''), select('1 guest')]);
    const after = pageOf([field(1, 'Title', 'Buy milk'), select('2 guests')]);
    expect(lastChange(before, after, { operation: 'TYPE_TEXT', element: 'Title' })?.changed).toEqual([
      'textbox "Title": value "" -> "Buy milk"',
      'combobox "Guests": value "1 guest" -> "2 guests"',
    ]);
  });

  it('names elements added and removed by role and label', () => {
    const before = pageOf([button(1, 'Add item'), button(2, 'Cancel')]);
    const after = pageOf([checkbox(5, 'Buy milk', 'false'), button(2, 'Cancel')]);
    expect(lastChange(before, after, { operation: 'CLICK', element: 'Add item' })).toMatchObject({
      added: ['checkbox "Buy milk"'],
      removed: ['button "Add item"'],
    });
  });

  it('counts a node id reused with another label (a new document) as removed and added, never changed', () => {
    const before = pageOf([button(1, 'Sign in')], { url: 'http://app/list?tab=1' });
    const after = pageOf([field(1, 'Repository name', '')], { url: 'http://app/list?tab=2' });
    const change = lastChange(before, after, { operation: 'CLICK', element: 'Sign in' })!;
    expect(change.changed).toBeUndefined();
    expect(change).toMatchObject({ added: ['textbox "Repository name"'], removed: ['button "Sign in"'] });
  });

  it('says how many elements changed order when nothing else changed, but never after a scroll', () => {
    const rows = [button(1, 'Row A'), button(2, 'Row B'), button(3, 'Row C')];
    const before = pageOf(rows);
    const after = pageOf([rows[2], rows[0], rows[1]]);
    expect(lastChange(before, after, { operation: 'CLICK', element: 'Sort by name' })).toEqual({
      after: 'CLICK Sort by name',
      reordered: '3 listed elements changed order',
    });
    expect(lastChange(before, after, { operation: 'SCROLL_DOWN', element: 'Scroll down' })).toBeUndefined();
  });

  it('keeps the element lists when only the query changed, and gives only the URL when the path changed', () => {
    const before = pageOf([button(1, 'Open'), button(2, 'Closed')], { text: 'Issues\n3 open' });
    const filtered = pageOf([button(1, 'Open')], { url: 'http://app/list?state=open', text: 'Issues\n3 open\nFiltered' });
    expect(lastChange(before, filtered, { operation: 'CLICK', element: 'Open' })).toEqual({
      after: 'CLICK Open',
      url: 'http://app/list -> http://app/list?state=open',
      removed: ['button "Closed"'],
      new_text: 'Filtered',
    });
    const moved = pageOf([button(9, 'New issue')], { url: 'http://app/issues/new', text: 'New issue\nTitle' });
    expect(lastChange(before, moved, { operation: 'CLICK', element: 'New issue' })).toEqual({
      after: 'CLICK New issue',
      url: 'http://app/list -> http://app/issues/new',
    });
  });

  it('gives new words as runs, leaving out the lines the reader adds itself', () => {
    const before = pageOf([], { text: 'Your list\nWalk the dog\n1 item' });
    const after = pageOf([], {
      text: 'Your list\nWalk the dog\nBuy milk\n2 items\nPassword field "Password": filled\nLoading: 3 placeholder blocks on screen',
    });
    expect(lastChange(before, after, { operation: 'CLICK', element: 'Add' })?.new_text).toBe('Buy milk 2 items');
    const middle = pageOf([], { text: 'Your list\nWalk the dog\nsaved\n1 item\nundo' });
    expect(lastChange(before, middle, { operation: 'CLICK', element: 'Add' })?.new_text).toBe('saved | undo');
  });

  it('leaves the new words out when told to (a page message already shows them)', () => {
    const before = pageOf([], { text: 'Your list' });
    const after = pageOf([], { text: 'Your list\nSaved' });
    expect(lastChange(before, after, { operation: 'CLICK', element: 'Save' }, { withText: false })).toBeUndefined();
  });

  it('caps every list at 8 entries, labels at 60 characters and new text at 200', () => {
    const before = pageOf([]);
    const many = Array.from({ length: 12 }, (_, i) => button(i + 1, `Row ${i + 1}`));
    const long = button(40, 'x'.repeat(300));
    const after = pageOf([long, ...many], { text: `Your list\n${'word '.repeat(100)}` });
    const change = lastChange(before, after, { operation: 'CLICK', element: 'Load more' })!;
    expect(change.added).toHaveLength(8);
    expect(change.added![0]).toBe(`button "${'x'.repeat(59)}…"`);
    expect(change.new_text!.length).toBeLessThanOrEqual(200);
  });

  it('is undefined when nothing changed', () => {
    const before = pageOf([checkbox(1, 'Walk the dog', 'false')]);
    expect(lastChange(before, pageOf([checkbox(1, 'Walk the dog', 'false')]), CLICK)).toBeUndefined();
  });
});
