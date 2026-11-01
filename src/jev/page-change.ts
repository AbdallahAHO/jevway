import type { PageAction, PageState } from '../browser/tab.ts';

/** What one executed action changed on the page, as Jev reads it in `last_change`. Untrusted page data. */
export interface LastChange {
  /** The action that ran: operation and element label. */
  after: string;
  url?: string;
  added?: string[];
  removed?: string[];
  changed?: string[];
  reordered?: string;
  new_text?: string;
}

// Caps that keep the key small next to the page (a JSON-heavy request once hit max_tokens_exceeded).
const MAX_ENTRIES = 8;
const LABEL_CHARS = 60;
const VALUE_CHARS = 40;
const NEW_TEXT_CHARS = 200;
// Words compared per side: the diff is quadratic in them.
const MAX_WORDS = 600;
const STATES = ['value', 'checked', 'selected', 'expanded'] as const;
// Lines the reader adds itself say nothing the page did.
const READER_LINE = /^(Password field "|Loading: )/;

interface ElementView {
  key: string;
  name: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
}

/**
 * What an executed action changed: elements added, removed or changed (value, checked, selected, expanded), a reorder,
 * the URL, and new words. A new path is a new page, so only its URL is named; `withText: false` leaves the new words to
 * a page message that already shows them. Undefined when nothing Jev can see changed.
 *
 * Elements pair by node id and label: ids restart in a new document, so a reused id with another label is one element
 * removed and another added, never a change.
 *
 * @example
 * lastChange(before, after, { operation: 'CLICK', element: 'Walk the dog' });
 * // { after: 'CLICK Walk the dog', changed: ['checkbox "Walk the dog": checked false -> true'] }
 */
export const lastChange = (
  before: PageState,
  after: PageState,
  action: { operation: string; element: string },
  { withText = true } = {},
): LastChange | undefined => {
  const url = before.url !== after.url ? `${before.url} -> ${after.url}` : undefined;
  const change: LastChange = { after: cut(`${action.operation} ${action.element}`, LABEL_CHARS), ...(url && { url }) };
  if (pathOf(before.url) === pathOf(after.url)) {
    Object.assign(change, elementChanges(viewsOf(before.actions), viewsOf(after.actions), action.operation));
    const words = withText ? insertedWords(textOf(before.text), textOf(after.text)) : '';
    if (words) change.new_text = words.slice(0, NEW_TEXT_CHARS);
  }
  return Object.keys(change).length > 1 ? change : undefined;
};

const elementChanges = (before: ElementView[], after: ElementView[], operation: string) => {
  const old = new Map(before.map((view) => [view.key, view]));
  const now = new Map(after.map((view) => [view.key, view]));
  const added = after.filter((view) => !old.has(view.key)).map((view) => view.name);
  const removed = before.filter((view) => !now.has(view.key)).map((view) => view.name);
  const changed = after.flatMap((view) => {
    const was = old.get(view.key);
    return was ? STATES.filter((state) => was[state] !== view[state]).map((state) => `${view.name}: ${state} ${shown(was[state], state)} -> ${shown(view[state], state)}`) : [];
  });
  const lists = { added, removed, changed };
  const result: Pick<LastChange, 'added' | 'removed' | 'changed' | 'reordered'> = {};
  for (const [name, list] of Object.entries(lists)) if (list.length) result[name as keyof typeof lists] = list.slice(0, MAX_ENTRIES);
  // A drag or a sort moves elements without changing them; after a scroll every position moves, which says nothing.
  if (!added.length && !removed.length && !changed.length && !operation.startsWith('SCROLL')) {
    const moved = after.filter((view, i) => before[i]?.key !== view.key).length;
    if (moved) result.reordered = `${moved} listed elements changed order`;
  }
  return result;
};

// One view per node, as Jev's `elements` shows it; actions without a node (keys, scroll, wait) are not elements.
const viewsOf = (actions: PageAction[]): ElementView[] => {
  const views = new Map<number, ElementView>();
  for (const action of actions) {
    if (action.node === undefined || views.has(action.node)) continue;
    const label = action.label.split(' → ')[0];
    views.set(action.node, {
      key: `${action.node}\n${label}`,
      name: `${action.role ?? 'element'} "${cut(label, LABEL_CHARS)}"`,
      value: action.kind === 'select' ? action.current_value : action.value,
      checked: action.checked,
      selected: action.selected,
      expanded: action.expanded,
    });
  }
  return [...views.values()];
};

const shown = (value: string | undefined, state: (typeof STATES)[number]) =>
  state === 'value' ? `"${cut(value ?? '', VALUE_CHARS)}"` : (value ?? '(none)');

const textOf = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !READER_LINE.test(line))
    .join(' ');

// Runs of words in `after` that are not in `before`, by longest common subsequence, joined with " | ".
const insertedWords = (before: string, after: string) => {
  const a = before.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const b = after.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const common = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  const runs: string[] = [];
  let run: string[] = [];
  for (let i = 0, j = 0; j < b.length; ) {
    if (i < a.length && a[i] === b[j]) {
      if (run.length) runs.push(run.join(' '));
      run = [];
      i++;
      j++;
    } else if (i < a.length && common[i + 1][j] >= common[i][j + 1]) i++;
    else run.push(b[j++]);
  }
  if (run.length) runs.push(run.join(' '));
  return runs.join(' | ');
};

const pathOf = (url: string) => {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
};

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
