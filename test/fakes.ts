import { PAGE_LEVEL_KINDS, StalePage, TargetUnreachable, Tab, type PageAction, type PageState } from '../src/browser/tab.ts';
import { buildActionSpace } from '../src/jev/action-space.ts';
import type { Ask } from '../src/jev/decide.ts';

export const NAME_RECT = { x: 20, y: 100, w: 350, h: 40 };
export const PAY_RECT = { x: 20, y: 700, w: 350, h: 48 };
// The user's words naming what a confirmed click acts on, here the page it is on: the control's own words never count.
export const STAYLIST = 'Staylist';
// A booking form as the snapshot reports it: two text fields, a native select, a pay button.
export const bookingActions: PageAction[] = [
  { id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Full name', value: '', rect: NAME_RECT },
  { id: 'e2', kind: 'click', node: 1, role: 'textbox', label: 'Open Full name', value: '', rect: NAME_RECT },
  { id: 'e3', kind: 'fill', node: 2, role: 'textbox', label: 'Email address', value: '' },
  {
    id: 'e4',
    kind: 'select',
    node: 3,
    role: 'combobox',
    label: 'Guests → 2 guests',
    value: '2',
    current_value: '1 guest',
  },
  {
    id: 'e5',
    kind: 'click',
    node: 4,
    role: 'button',
    label: 'Confirm booking and pay €412',
    value: '',
    rect: PAY_RECT,
  },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
];

export const page = (overrides: Partial<PageState> = {}): PageState => ({
  url: 'http://fixture/stays',
  title: 'Staylist',
  text: 'Your details',
  w: 393,
  h: 852,
  actions: bookingActions,
  marker: 1,
  page_key: 1,
  guards: {},
  omitted_actions: 0,
  fingerprint: 'initial',
  ...overrides,
});

// A phone layout folds details away behind a disclosure. No text fields, so BLOCKED is not needs_input.
const showMore = (expanded?: string): PageAction => ({
  id: 'more',
  kind: 'click',
  node: 20,
  role: 'button',
  label: 'Show more details',
  ...(expanded && { expanded }),
});
export const foldedPage = (fingerprint: string, expanded?: string) =>
  page({ actions: [...bookingActions.filter((action) => action.kind !== 'fill'), showMore(expanded)], fingerprint });
export const clickTargetOf = (state: PageState, label: string) =>
  Object.entries(buildActionSpace(state.actions).targets.CLICK!).find(([, action]) => action.label === label)![0];

// A phone header folds a detail behind an overflow chip, while the generic menus beside it look more likely to the click head.
export const overflowChip = (node: number, label: string, expanded = 'false'): PageAction => ({
  id: `chip${node}`,
  kind: 'click',
  node,
  role: 'button',
  label,
  expanded,
});
export const overflowPage = (fingerprint: string, extras: PageAction[]) =>
  page({
    actions: [
      { id: 'menu', kind: 'click', node: 30, role: 'button', label: 'Open menu' },
      { id: 'account', kind: 'click', node: 31, role: 'button', label: 'Account menu' },
      ...extras,
    ],
    fingerprint,
  });
export const answer = (choice: string, ids: string[], confidence = 0.95) => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
});

/** Answers every question in a request with the scripted choice for that step, or its first option.
 * `confidence` sets the operation answer's confidence (default 0.95). */
const NOWHERE = { top: 0, bottom: 0.01, left: 0, right: 0.01 };
/** A Box answer covering a viewport rect of the 393×852 fixture page. */
export const boxAt = (rect: { x: number; y: number; w: number; h: number }, confidence = 0.9) => ({
  type: 'box',
  box: { left: rect.x / 393, right: (rect.x + rect.w) / 393, top: rect.y / 852, bottom: (rect.y + rect.h) / 852 },
  confidence,
});

export const scriptedJev = (steps: Record<string, any>[]) => {
  const requests: any[] = [];
  // The quote a done carries is asked after the run's decisions: kept apart, it answers from the last decision's step.
  const evidenceRequests: any[] = [];
  const ask: Ask = async (request) => {
    (request.questions.evidence ? evidenceRequests : requests).push(request);
    const script = steps[Math.min(Math.max(requests.length, 1) - 1, steps.length - 1)];
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]: [string, any]) => {
        if (question.type === 'noul') return [id, { type: 'noul', noul: script[id] ?? 0 }];
        if (question.type === 'box') return [id, script[id] ?? { type: 'box', box: NOWHERE, confidence: 0 }];
        const ids = Object.keys(question.criteria);
        const confidence = id === 'operation' ? Number(script.confidence ?? 0.95) : 0.95;
        return [id, answer(String(script[id] ?? ids[0]), ids, confidence)];
      }),
    );
    return { answers, usage: { input_tokens: 100 } };
  };
  return { ask, requests, evidenceRequests };
};

export const fakeTab = (pages: PageState[] = [page()]) => {
  const acted: { label: string; text?: string }[] = [];
  let observed = 0;
  const tab = {
    staleOnce: false,
    /** Refusals left: the page changed under every click until this runs out (a page that re-renders faster than a decision takes). */
    stale: 0,
    /** A page whose text never stops changing: wait, Escape, scroll and Enter are refused as stale unless forced. */
    busy: false,
    /** Every call to act, refused or not, with whether the loop forced it. */
    calls: [] as { kind: string; forced: boolean }[],
    /** Misses left before the target can be reached (covered by a popover). */
    unreachable: 0,
    /** The nodes of the layer covering the target, as the tab names them with each miss. */
    coverNodes: [] as number[],
    /** How far each scroll moved the page, as the tab measures it; undefined when it can't tell. */
    scrolled: undefined as number | undefined,
    /** Tabs this tab opened that the run has not taken yet, the label whose click opens one, and the tab it opens. */
    opened: [] as string[],
    opensTabOn: undefined as string | undefined,
    next: undefined as unknown,
    takeOpened: () => tab.opened.splice(0),
    /** Files the run set on file fields, with the path it passed. */
    uploads: [] as { label: string; path: string }[],
    upload: async (action: PageAction, _page: PageState, path: string) => {
      tab.uploads.push({ label: action.label, path });
    },
    wantedFiles: false,
    follow: async () => tab.next,
    closed: false,
    closes: 0,
    close: async () => {
      tab.closes++;
    },
    screenshots: 0,
    recorded: 0,
    clicksAt: [] as { x: number; y: number }[],
    clickAt: async (point: { x: number; y: number }) => {
      tab.clicksAt.push(point);
      return 'canvas';
    },
    markedScreenshot: async (_marks: unknown, _viewport: unknown, options?: { sharp?: boolean }) => {
      if (options?.sharp) tab.recorded++;
      else tab.screenshots++;
      return 'SCREENSHOT';
    },
    observe: async () => pages[Math.min(observed++, pages.length - 1)],
    fresh: async () => true,
    wanted: [] as string[],
    want: (texts: string[], options?: { files?: boolean }) => {
      tab.wanted = texts;
      tab.wantedFiles = Boolean(options?.files);
    },
    dismissPopup: async () => {
      acted.push({ label: 'dismissPopup' });
    },
    send: async () => ({}),
    onEvent: () => () => true,
    /** Dialogs the page opened and the tab answered, until the run takes them. */
    dialogs: [] as { type: string; message: string; accepted: boolean }[],
    takeDialogs: () => tab.dialogs.splice(0),
    /** What the run armed for the next confirm dialog, and what was armed each time it acted. */
    armed: undefined as string[] | undefined,
    armedAtAct: [] as (string[] | undefined)[],
    armConfirm: (phrases: string[]) => {
      tab.armed = phrases;
    },
    disarmConfirm: () => {
      tab.armed = undefined;
    },
    /** A dialog every click opens, as the tab would have answered it. */
    dialogOnAct: undefined as { type: string; message: string; accepted: boolean } | undefined,
    act: async (action: PageAction, _page: PageState, text?: string, options?: { evenIfChanged?: boolean }) => {
      tab.calls.push({ kind: action.kind, forced: Boolean(options?.evenIfChanged) });
      tab.armedAtAct.push(tab.armed);
      if (tab.busy && PAGE_LEVEL_KINDS.includes(action.kind) && !options?.evenIfChanged) {
        throw new StalePage('Page changed since this decision');
      }
      if (tab.staleOnce) {
        tab.staleOnce = false;
        throw new StalePage('moved');
      }
      if (tab.stale > 0) {
        tab.stale--;
        throw new StalePage('Page changed since this decision');
      }
      if (tab.unreachable > 0) {
        tab.unreachable--;
        throw new TargetUnreachable('covered', false, tab.coverNodes);
      }
      acted.push({ label: action.label, ...(text && { text }) });
      if (tab.dialogOnAct) tab.dialogs.push(tab.dialogOnAct);
      if (tab.opensTabOn === action.label) tab.opened.push('T2');
      if (action.kind === 'scroll' && tab.scrolled !== undefined) return { scrolled: tab.scrolled };
    },
  };
  return { tab, acted, asTab: tab as unknown as Tab };
};
