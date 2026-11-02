import { describe, expect, it } from 'vitest';
import type { PageAction, PageState } from '../../src/browser/tab.ts';
import { CHECKS, runChecks, type Check } from '../../src/task/checks.ts';

const actions: PageAction[] = [
  { id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Full name', value: 'Ada Lovelace' },
  { id: 'e2', kind: 'click', node: 1, role: 'textbox', label: 'Open Full name', value: 'Ada Lovelace' },
  { id: 'e3', kind: 'fill', node: 2, role: 'textbox', label: 'Username', value: 'ada' },
  { id: 'e4', kind: 'select', node: 3, role: 'combobox', label: 'Guests → 2 guests', value: '2', current_value: '1 guest' },
  { id: 'e5', kind: 'select', node: 3, role: 'combobox', label: 'Guests → 3 guests', value: '3', current_value: '1 guest' },
  { id: 'e6', kind: 'click', node: 4, role: 'checkbox', label: 'Free cancellation', checked: 'true' },
  { id: 'e7', kind: 'click', node: 5, role: 'checkbox', label: 'Breakfast included', checked: 'false' },
  { id: 'e8', kind: 'click', node: 6, role: 'link', label: 'View Casa Flora' },
  { id: 'e9', kind: 'click', node: 7, role: 'link', label: 'View Casa Azul' },
  { id: 'e10', kind: 'click', node: 8, role: 'button', label: 'Edit (appears on hover)', hover: true },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
];

const page = (overrides: Partial<PageState> = {}): PageState => ({
  url: 'https://stays.example/lisbon/results?guests=1#top',
  title: 'Stays in Lisbon · Staylist',
  text: 'Password field "Password" is filled\nStays in\nLisbon\n2 results  found\nCasa Flora',
  w: 1280,
  h: 800,
  actions,
  marker: 1,
  page_key: 1,
  guards: {},
  omitted_actions: 0,
  fingerprint: 'f',
  ...overrides,
});

const passes = (check: Check, state = page()) => runChecks([check], state)[0].pass;

describe('caller checks on the final page', () => {
  it.each<[Check, boolean]>([
    [{ type: 'url_contains', text: '/LISBON/results' }, true],
    [{ type: 'url_contains', text: '/porto/' }, false],
    [{ type: 'url_matches', pattern: 'https://stays.example/*/results*' }, true],
    [{ type: 'url_matches', pattern: 'stays.example/*' }, false],
    [{ type: 'title_contains', text: 'stays in lisbon' }, true],
    [{ type: 'title_contains', text: 'Porto' }, false],
    [{ type: 'text_contains', text: 'stays in lisbon 2 results found' }, true],
    [{ type: 'text_contains', text: 'Booking confirmed' }, false],
    [{ type: 'text_absent', text: 'Booking confirmed' }, true],
    [{ type: 'text_absent', text: 'casa flora' }, false],
    [{ type: 'element_exists', name: 'casa flora' }, true],
    [{ type: 'element_exists', name: 'Casa Flora', role: 'button' }, false],
    [{ type: 'element_exists', name: 'Edit', role: 'button' }, true],
    [{ type: 'value_equals', label: 'full name', value: 'Ada Lovelace' }, true],
    [{ type: 'value_equals', label: 'Full name', value: 'Ada' }, false],
    [{ type: 'value_equals', label: 'Guests', value: '1 guest' }, true],
    [{ type: 'value_equals', label: 'Email', value: '' }, false],
    [{ type: 'checked', label: 'Free cancellation', state: true }, true],
    [{ type: 'checked', label: 'Breakfast', state: false }, true],
    [{ type: 'checked', label: 'Breakfast', state: true }, false],
    [{ type: 'count_at_least', role: 'link', min: 2 }, true],
    [{ type: 'count_at_least', name: 'View Casa', min: 3 }, false],
  ])('%o passes: %s', (check, expected) => {
    expect(passes(check)).toBe(expected);
  });

  it('fails an empty needle instead of passing on everything', () => {
    const results = runChecks(
      [
        { type: 'text_contains', text: '' },
        { type: 'text_absent', text: '  ' },
        { type: 'url_contains', text: '' },
        { type: 'url_matches', pattern: '' },
        { type: 'title_contains', text: '' },
        { type: 'element_exists', name: ' ' },
        { type: 'value_equals', label: '', value: '' },
        { type: 'checked', label: '', state: false },
        { type: 'count_at_least', min: 1 },
      ],
      page(),
    );
    expect(results.map((result) => result.pass)).toEqual(Array(9).fill(false));
    expect(results[0].detail).toMatch(/non-empty/);
  });

  it("never matches the reader's own password and loading lines", () => {
    const loading = page({ text: 'Loading: 4 placeholder blocks on screen\nPassword field "Password" is filled' });
    expect(passes({ type: 'text_contains', text: 'password' }, loading)).toBe(false);
    expect(passes({ type: 'text_contains', text: 'loading' }, loading)).toBe(false);
  });

  it('counts a control once, however many actions it has', () => {
    // The guests select has two option actions and the name field a fill and an "Open" click.
    expect(passes({ type: 'count_at_least', role: 'combobox', min: 2 })).toBe(false);
    expect(passes({ type: 'count_at_least', role: 'textbox', min: 2 })).toBe(true);
    expect(passes({ type: 'count_at_least', role: 'textbox', min: 3 })).toBe(false);
  });

  it('prefers an exact label, and needs every matched field to hold the value', () => {
    // "name" is in both "Full name" and "Username": they hold different values.
    expect(passes({ type: 'value_equals', label: 'name', value: 'ada' })).toBe(false);
    expect(passes({ type: 'value_equals', label: 'Username', value: 'ada' })).toBe(true);
  });

  it('reads a glob literally apart from its stars', () => {
    expect(passes({ type: 'url_matches', pattern: 'https://stays?example/*' })).toBe(false);
    expect(passes({ type: 'url_matches', pattern: 'https://stays.example/lisbon/results?guests=1#top' })).toBe(true);
  });

  it('says what it found in each result', () => {
    const [found, missing] = runChecks(
      [
        { type: 'url_contains', text: '/results' },
        { type: 'checked', label: 'Newsletter', state: true },
      ],
      page(),
    );
    expect(found).toMatchObject({ type: 'url_contains', text: '/results', pass: true });
    expect(missing).toMatchObject({ type: 'checked', pass: false, detail: expect.stringMatching(/no listed checkbox/i) });
  });

  it('rejects a malformed check at the boundary', () => {
    expect(CHECKS.safeParse([{ type: 'checked', label: 'Wiki' }]).success).toBe(false);
    expect(CHECKS.safeParse([{ type: 'js', expr: '1' }]).success).toBe(false);
    expect(CHECKS.safeParse([{ type: 'count_at_least', role: 'row', min: 0 }]).success).toBe(false);
    expect(CHECKS.safeParse([{ type: 'text_contains', text: 'Saved' }]).success).toBe(true);
  });
});
