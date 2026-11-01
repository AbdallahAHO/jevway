import { z } from 'zod';
import type { PageAction, PageState } from '../browser/tab.ts';

// The caller's checks: facts code reads off the final page, so a `done` the page doesn't show is not reported as done.
// They read only what the run observed (url, title, the reader's text and listed controls), never a selector or a script.

const needle = z.string().describe('Compared ignoring case and spacing; an empty one fails.');

const CHECK = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_contains'), text: needle }),
  z.object({ type: z.literal('url_matches'), pattern: z.string().describe('Glob over the whole URL: * is any run of characters.') }),
  z.object({ type: z.literal('title_contains'), text: needle }),
  z.object({ type: z.literal('text_contains'), text: needle }),
  z.object({ type: z.literal('text_absent'), text: needle }),
  z.object({ type: z.literal('element_exists'), name: needle, role: z.string().optional() }),
  z.object({ type: z.literal('value_equals'), label: needle, value: z.string() }),
  z.object({ type: z.literal('checked'), label: needle, state: z.boolean() }),
  z.object({
    type: z.literal('count_at_least'),
    min: z.number().int().positive(),
    name: z.string().optional(),
    role: z.string().optional(),
  }),
]);

/** The `checks` input of `browser_task` and `--checks`: one schema for MCP, CLI and the task. */
export const CHECKS = z.array(CHECK);

export type Check = z.infer<typeof CHECK>;
export type CheckResult = Check & { pass: boolean; detail: string };

/** One listed control, counted once however many actions it has (a select's options, a field's "Open" click). */
export interface ListedElement {
  label: string;
  role?: string;
  /** A field's text, or a select's chosen option. */
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
}

const HOVER_SUFFIX = / \(appears on hover\)$/;
const SELECT_OPTION = / → (?!.* → )/;
// The reader's own lines about the page, not text the page shows.
const READER_LINE = /^(Password field "|Loading: \d+ placeholder)/;

const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const labelOf = (action: PageAction) => {
  const label = action.hover ? action.label.replace(HOVER_SUFFIX, '') : action.label;
  return action.kind === 'select' ? label.split(SELECT_OPTION)[0] : label;
};

/**
 * The page's listed controls, one per node, labelled as a person reads them: no hover suffix, a select by its field
 * name with its chosen option as the value, a text field once (not again as its "Open …" click).
 *
 * @example
 * listedElements(page) // [{ label: 'Guests', role: 'combobox', value: '1 guest' }, { label: 'Free cancellation', role: 'checkbox', checked: 'true' }]
 */
export const listedElements = (page: PageState): ListedElement[] => {
  const byNode = new Map<number, ListedElement>();
  // The reader lists a field's fill before its "Open …" click, and a select's options together: the first action names the control.
  for (const action of page.actions) {
    if (action.node === undefined || byNode.has(action.node) || !['click', 'fill', 'select'].includes(action.kind)) continue;
    const value = action.kind === 'select' ? action.current_value : action.kind === 'fill' ? action.value : undefined;
    byNode.set(action.node, {
      label: labelOf(action),
      ...(action.role && { role: action.role }),
      ...(value !== undefined && { value }),
      ...(action.checked !== undefined && { checked: action.checked }),
      ...(action.selected !== undefined && { selected: action.selected }),
      ...(action.expanded !== undefined && { expanded: action.expanded }),
    });
  }
  return [...byNode.values()];
};

const visibleText = (page: PageState) =>
  normalized(
    page.text
      .split('\n')
      .filter((line) => !READER_LINE.test(line.trim()))
      .join('\n'),
  );

const globMatches = (pattern: string, url: string) =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is').test(url);

const quoted = (text: string) => `"${text.slice(0, 80)}"`;

// Controls a name and role pick out: the name inside the label, the role exactly.
const named = (elements: ListedElement[], name?: string, role?: string) =>
  elements.filter(
    (element) =>
      (!role?.trim() || element.role === role.trim().toLowerCase()) && (!name?.trim() || normalized(element.label).includes(normalized(name))),
  );

// Exact label matches when there are any, otherwise every label containing it.
const labelled = (elements: ListedElement[], label: string) => {
  const exact = elements.filter((element) => normalized(element.label) === normalized(label));
  return exact.length ? exact : named(elements, label);
};

const judge = (check: Check, page: PageState, elements: ListedElement[]): [boolean, string] => {
  const blank = (field: string) => [false, `needs a non-empty "${field}"`] as [boolean, string];
  switch (check.type) {
    case 'url_contains': {
      if (!check.text.trim()) return blank('text');
      const found = normalized(page.url).includes(normalized(check.text));
      return [found, `${found ? 'in' : 'not in'} the URL ${page.url}`];
    }
    case 'url_matches': {
      if (!check.pattern.trim()) return blank('pattern');
      const found = globMatches(check.pattern.trim(), page.url);
      return [found, `the URL ${page.url} ${found ? 'matches' : 'does not match'}`];
    }
    case 'title_contains': {
      if (!check.text.trim()) return blank('text');
      const found = normalized(page.title).includes(normalized(check.text));
      return [found, `${found ? 'in' : 'not in'} the title ${quoted(page.title)}`];
    }
    case 'text_contains':
    case 'text_absent': {
      if (!check.text.trim()) return blank('text');
      const found = visibleText(page).includes(normalized(check.text));
      return [found === (check.type === 'text_contains'), found ? 'found in the page text' : 'not found in the page text'];
    }
    case 'element_exists': {
      if (!check.name.trim()) return blank('name');
      const matches = named(elements, check.name, check.role);
      return [matches.length > 0, matches.length ? `listed: ${quoted(matches[0].label)}` : 'no listed control matches'];
    }
    case 'value_equals': {
      if (!check.label.trim()) return blank('label');
      const fields = labelled(elements, check.label).filter((element) => element.value !== undefined);
      if (!fields.length) return [false, 'no listed field has that label'];
      const holds = fields.every((field) => field.value!.trim() === check.value.trim());
      return [holds, fields.map((field) => `${quoted(field.label)} holds ${quoted(field.value!)}`).join('; ')];
    }
    case 'checked': {
      if (!check.label.trim()) return blank('label');
      const toggles = labelled(elements, check.label).filter((element) => element.checked !== undefined);
      if (!toggles.length) return [false, 'no listed checkbox, radio or switch has that label'];
      const holds = toggles.every((toggle) => (toggle.checked === 'true') === check.state);
      return [holds, toggles.map((toggle) => `${quoted(toggle.label)} is ${toggle.checked === 'true' ? 'checked' : 'unchecked'}`).join('; ')];
    }
    case 'count_at_least': {
      if (!check.name?.trim() && !check.role?.trim()) return blank('name" or "role');
      const count = named(elements, check.name, check.role).length;
      return [count >= check.min, `${count} listed`];
    }
    default:
      return [false, `unknown check type "${(check as { type?: string }).type}"`];
  }
};

/**
 * Evaluates the caller's checks on a page, by code: the facts that confirm or overturn a `done`. Text is compared
 * ignoring case, accents and spacing; an empty needle fails, since an empty string is in every text. Elements are the
 * listed controls (role and name), never a selector; `value_equals` and `checked` need every control with that label
 * to agree, so "name" matching both "Full name" and "Username" can't pass on the wrong one.
 *
 * @example
 * runChecks([{ type: 'url_contains', text: '/issues/' }, { type: 'text_contains', text: 'Footer links overlap' }], page)
 * // [{ type: 'url_contains', text: '/issues/', pass: true, detail: 'in the URL …' }, …]
 */
export const runChecks = (checks: Check[], page: PageState): CheckResult[] => {
  const elements = listedElements(page);
  return checks.map((check) => {
    const [pass, detail] = judge(check, page, elements);
    return { ...check, pass, detail };
  });
};

/** One failed check as a reason quotes it: its type, what it looked for, and what the page had. */
export const describeFailure = (result: CheckResult) => {
  const { type, pass: _pass, detail, ...looked } = result;
  const what = Object.values(looked).filter((value) => typeof value === 'string' && value).map((value) => quoted(String(value)));
  return `${type} ${what.join(' ')} (${detail})`;
};
