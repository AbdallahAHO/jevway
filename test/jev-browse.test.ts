import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpError, type CdpConnection } from '../src/browser/cdp.ts';
import * as chrome from '../src/browser/chrome.ts';
import { jpegSize, PAGE_LEVEL_KINDS, StalePage, TargetUnreachable, Tab, type PageAction, type PageState } from '../src/browser/tab.ts';
import { messageNames, showsTarget } from '../src/browser/words.ts';
import { buildActionSpace } from '../src/jev/action-space.ts';
import { buildRequest, decide, foldedFavourite, NO_SUPPLIED_FILE, NO_SUPPLIED_VALUE, overflowFolds, readDecision, validChoice, type Ask } from '../src/jev/decide.ts';
import { matchTarget, overlap, readBox, toViewportRect } from '../src/jev/box.ts';
import * as model from '../src/jev/model.ts';
import { resolveModel } from '../src/jev/model.ts';
import { describeStep, frameDurations, videoOffset } from '../src/task/recording.ts';
import { BrowserTask } from '../src/task/run-task.ts';
import { createRunner } from '../src/task/start-task.ts';

const NAME_RECT = { x: 20, y: 100, w: 350, h: 40 };
const PAY_RECT = { x: 20, y: 700, w: 350, h: 48 };
// The user's words naming what a confirmed click acts on, here the page it is on: the control's own words never count.
const STAYLIST = 'Staylist';
// A booking form as the snapshot reports it: two text fields, a native select, a pay button.
const bookingActions: PageAction[] = [
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

const page = (overrides: Partial<PageState> = {}): PageState => ({
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
const foldedPage = (fingerprint: string, expanded?: string) =>
  page({ actions: [...bookingActions.filter((action) => action.kind !== 'fill'), showMore(expanded)], fingerprint });
const clickTargetOf = (state: PageState, label: string) =>
  Object.entries(buildActionSpace(state.actions).targets.CLICK!).find(([, action]) => action.label === label)![0];

// A phone header folds a detail behind an overflow chip, while the generic menus beside it look more likely to the click head.
const overflowChip = (node: number, label: string, expanded = 'false'): PageAction => ({
  id: `chip${node}`,
  kind: 'click',
  node,
  role: 'button',
  label,
  expanded,
});
const overflowPage = (fingerprint: string, extras: PageAction[]) =>
  page({
    actions: [
      { id: 'menu', kind: 'click', node: 30, role: 'button', label: 'Open menu' },
      { id: 'account', kind: 'click', node: 31, role: 'button', label: 'Account menu' },
      ...extras,
    ],
    fingerprint,
  });
const SOURCE_LINK: PageAction = { id: 'source', kind: 'click', node: 40, role: 'link', label: 'View source observation' };

const answer = (choice: string, ids: string[], confidence = 0.95) => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
});

/** Answers every question in a request with the scripted choice for that step, or its first option.
 * `confidence` sets the operation answer's confidence (default 0.95). */
const NOWHERE = { top: 0, bottom: 0.01, left: 0, right: 0.01 };
/** A Box answer covering a viewport rect of the 393×852 fixture page. */
const boxAt = (rect: { x: number; y: number; w: number; h: number }, confidence = 0.9) => ({
  type: 'box',
  box: { left: rect.x / 393, right: (rect.x + rect.w) / 393, top: rect.y / 852, bottom: (rect.y + rect.h) / 852 },
  confidence,
});

const scriptedJev = (steps: Record<string, any>[]) => {
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

/** Gives the click head a spread of probabilities instead of one sure pick, as the real one does when nothing fits; leaves a request over other targets alone. */
const withClickHead =
  (ask: Ask, probabilities: Record<string, number>): Ask =>
  async (request) => {
    const response = await ask(request);
    const head = response.answers.click_target;
    if (!head || Object.keys(head.probabilities).length !== Object.keys(probabilities).length) return response;
    const [choice] = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0];
    const click_target = { ...head, choice, confidence: probabilities[choice], probabilities };
    return { ...response, answers: { ...response.answers, click_target } };
  };

const fakeTab = (pages: PageState[] = [page()]) => {
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

describe('the words a confirmation quotes', () => {
  it.each([
    ['app', 'The app settings'],
    ['scratch', 'ada/scratch - Settings'],
    ['v1.2', 'Milestone v1.2, due soon'],
    ['v1.2', 'Milestone v1.2.'],
  ])('finds "%s" in "%s"', (target, shown) => {
    expect(showsTarget(target, 'Delete', [shown])).toBe(true);
  });

  it.each([
    ['app', 'Apply now'],
    ['ada/app', 'ada/app2 - Settings'],
    ['ada/scratch', 'ada/scratch-2 - Settings'],
    ['v1.2', 'Release v1.20'],
    ['v1.2', 'Release v1.2.3'],
  ])('does not find "%s" inside a longer word in "%s"', (target, shown) => {
    expect(showsTarget(target, 'Delete', [shown])).toBe(false);
  });
});

describe('a dialog that names the click the caller confirmed', () => {
  const DRAFT_COMMENTS =
    'Page will be reloaded, but there are draft comments. Continuing to reload will discard the comments. Continue?';

  it.each([
    ['Delete the draft?', ['the draft', 'Delete draft']],
    ['Delete ada/scratch? This cannot be undone.', ['ada/scratch', 'Delete this repository']],
    ['Really delete this repository?', ['ada/app', 'Delete this repository']],
  ])('names it: "%s"', (message, phrases) => {
    expect(messageNames(message, phrases)).toBe(true);
  });

  it.each([
    [DRAFT_COMMENTS, ['Labels', 'Labels']],
    [DRAFT_COMMENTS, ['Safari', 'Comment']],
    ['Delete your account and all its data?', ['profile', 'Save profile']],
    ['Delete the draft?', ['', '']],
    ['Delete the draft?', ['the', 'qq']],
  ])('does not name it: "%s" for %j', (message, phrases) => {
    expect(messageNames(message, phrases)).toBe(false);
  });
});

describe('action space', () => {
  it('gives each DOM node one index and each operation only its valid targets', () => {
    const space = buildActionSpace(bookingActions);
    expect(space.elements.map((e) => [e.index, e.label, e.operations])).toEqual([
      ['1', 'Full name', ['TYPE_TEXT', 'CLICK']],
      ['2', 'Email address', ['TYPE_TEXT']],
      ['3', 'Guests', ['SELECT']],
      ['4', 'Confirm booking and pay €412', ['CLICK']],
    ]);
    expect(Object.keys(space.targets.TYPE_TEXT!)).toEqual(['1', '2']);
    expect(Object.keys(space.targets.SELECT!)).toEqual(['3:1']);
    expect(Object.keys(space.controls)).toEqual(['WAIT']);
  });
});

describe('Jev request', () => {
  const input = { page: page(), goal: 'Book it', history: [], checkCommitRisk: true };

  it('asks value heads only when the agent supplied values', () => {
    const space = buildActionSpace(bookingActions);
    expect(Object.keys(buildRequest({ ...input, values: {} }, space).questions)).toEqual([
      'operation',
      'type_text_target',
      'click_target',
      'commit_risk',
    ]);
    const withValues = buildRequest({ ...input, values: { email: 'a@b.co' }, doneWhen: 'Confirmed' }, space);
    expect(withValues.questions).toHaveProperty('value_for_1');
    expect(withValues.questions).toHaveProperty('done_check');
    expect(Object.keys((withValues.questions.value_for_2 as any).criteria)).toEqual(['email', NO_SUPPLIED_VALUE]);
  });

  it('picks a lone candidate outright instead of asking a one-option question', () => {
    // Clef rejects choices with fewer than two options; the guests select here has exactly one.
    const space = buildActionSpace(bookingActions);
    const decisionInput = { ...input, values: {} };
    const operation = answer('SELECT', ['CLICK', 'TYPE_TEXT', 'SELECT', 'WAIT', 'DONE', 'BLOCKED']);
    const decision = readDecision(decisionInput, space, { operation });
    expect(decision).toMatchObject({ operation: 'SELECT', targetConfidence: 1 });
    expect(decision.action?.label).toBe('Guests → 2 guests');
  });

  it('puts a marked screenshot ahead of the JSON state as an image part', () => {
    const space = buildActionSpace(bookingActions);
    const { state } = buildRequest({ ...input, values: {}, screenshot: 'AAAA' }, space) as any;
    expect(state[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(state[1]).toMatchObject({ elements: space.elements, screenshot: expect.stringContaining('numbered box') });
    expect(Array.isArray(buildRequest({ ...input, values: {} }, space).state)).toBe(false);
  });

  it('carries password field state as data, and no key when the page has none', () => {
    const space = buildActionSpace(bookingActions);
    const withFields = page({ passwordFields: [{ name: 'Password', filled: true }] });
    expect((buildRequest({ ...input, page: withFields, values: {} }, space).state as any).password_fields).toEqual([
      { name: 'Password', filled: true },
    ]);
    expect(buildRequest({ ...input, values: {} }, space).state).not.toHaveProperty('password_fields');
    expect(buildRequest({ ...input, page: page({ passwordFields: [] }), values: {} }, space).state).not.toHaveProperty('password_fields');
  });

  it('counts generic overflow labels as folds, and no other collapsed label', () => {
    // One chip per page, so the cap on how many folds are returned does not hide a match.
    const foldsOn = (chip: PageAction) => {
      const clicks = buildActionSpace(overflowPage('a', [chip]).actions).targets.CLICK!;
      const ids = Object.keys(clicks);
      return overflowFolds({ click_target: answer(ids[0], ids) }, clicks).length;
    };
    const labels = ['+1', 'Show 2 more tags', 'More', 'more options', '…', '⋯', '⋮', '...', 'ellipsis icon', 'Filters', 'Show more details', 'More details', 'Moreover'];
    expect(labels.filter((label) => foldsOn(overflowChip(32, label)))).toEqual(labels.slice(0, 9));
    expect(foldsOn(overflowChip(32, 'More', 'true'))).toBe(0);
  });

  it('ranks count chips ahead of the other overflow controls, the click head breaking ties, and keeps three', () => {
    const chips = [overflowChip(32, 'More actions'), overflowChip(33, '⋯'), overflowChip(34, '+2'), overflowChip(35, 'Show 3 more tags')];
    const clicks = buildActionSpace(overflowPage('a', chips).actions).targets.CLICK!;
    // Elements 1 and 2 are the header menus; 3 to 6 are the chips in the order above.
    const probabilities = { '1': 0.3, '2': 0.3, '3': 0.2, '4': 0.15, '5': 0.01, '6': 0.04 };
    const head = { type: 'choice', choice: '1', confidence: 0.3, probabilities };
    expect(overflowFolds({ click_target: head }, clicks).map((fold) => fold.action.label)).toEqual(['Show 3 more tags', '+2', 'More actions']);
  });

  it('counts a hover-only overflow control, whose label carries the hover suffix', () => {
    const hoverChip = { ...overflowChip(32, 'More actions (appears on hover)'), hover: true };
    const clicks = buildActionSpace(overflowPage('a', [hoverChip]).actions).targets.CLICK!;
    const ids = Object.keys(clicks);
    expect(overflowFolds({ click_target: answer(ids[0], ids) }, clicks)).toHaveLength(1);
    // The suffix is only stripped where the snapshot added it.
    const plain = buildActionSpace(overflowPage('a', [overflowChip(32, 'More actions (appears on hover)')]).actions).targets.CLICK!;
    expect(overflowFolds({ click_target: answer(Object.keys(plain)[0], Object.keys(plain)) }, plain)).toHaveLength(0);
  });

  describe('the signed-in user\'s account menu is no fold to open', () => {
    // The click head puts all its weight on the last control on the page, collapsed.
    const clicksWith = (label: string) => {
      const clicks = buildActionSpace(overflowPage('a', [overflowChip(32, label)]).actions).targets.CLICK!;
      return { clicks, ids: Object.keys(clicks) };
    };
    const favouriteOn = (label: string) => {
      const { clicks, ids } = clicksWith(label);
      return foldedFavourite({ click_target: answer(ids[ids.length - 1], ids) }, clicks) !== undefined;
    };

    it('does not favour a menu named for the account, user or profile', () => {
      const accountMenus = ['Account menu', 'User menu', 'Open user navigation menu', 'Profile menu'];
      expect(accountMenus.filter(favouriteOn)).toEqual([]);
    });

    it('still favours a collapsed control that only mentions a user, a session or an action', () => {
      const folds = ['Show 1 more session details', 'User details', 'More actions', 'Filters 1'];
      expect(folds.filter((label) => !favouriteOn(label))).toEqual([]);
    });

    it('is no overflow pick either, even one drawn as an ellipsis icon', () => {
      const { clicks, ids } = clicksWith('User menu ellipsis');
      expect(overflowFolds({ click_target: answer(ids[ids.length - 1], ids) }, clicks)).toHaveLength(0);
    });
  });

  it('rejects malformed answers so nothing executes', () => {
    expect(() => validChoice({ choice: 'X', confidence: 1, probabilities: { A: 1 } }, ['A'])).toThrow(/no action/);
    expect(() => validChoice({ choice: 'A', confidence: 1, probabilities: { A: 0.5, B: 0.1 } }, ['A', 'B'])).toThrow();
    expect(validChoice(answer('A', ['A', 'B']), ['A', 'B']).choice).toBe('A');
  });
});

describe('BrowserTask', () => {
  it('types only the supplied value Jev selects for the chosen field', async () => {
    const { ask } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'DONE', done_check: 0.9 },
    ]);
    const { asTab, acted } = fakeTab();
    const task = new BrowserTask(asTab, ask, {
      goal: 'Enter email',
      values: { email: 'ada@example.com' },
      doneWhen: 'x',
      changeWaitMs: 0,
    });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(acted).toEqual([{ label: 'Email address', text: 'ada@example.com' }]);
  });

  it('hands back needs_input instead of inventing a value, after one retry', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE }]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('needs_input');
    expect(summary.reason).toBe('No supplied value fits the field "Email address"');
    expect(requests).toHaveLength(2);
    expect(acted).toEqual([]);
  });

  it('lets the model pick another step once when no supplied value fits the field it chose', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE },
      { operation: 'CLICK', click_target: '1' },
      { operation: 'DONE', done_check: 0.9 },
    ]);
    const pages = ['a', 'b', 'c', 'd'].map((fingerprint) => page({ fingerprint }));
    const { asTab, acted } = fakeTab(pages);
    const summary = await new BrowserTask(asTab, ask, {
      goal: 'Open the booking',
      doneWhen: 'x',
      values: { name: 'Ada' },
      changeWaitMs: 0,
    }).run();
    expect(summary.status).toBe('done');
    expect(acted).toEqual([{ label: 'Open Full name' }]);
    expect(summary.steps[0]).toMatchObject({
      operation: 'TYPE_TEXT',
      element: 'Email address',
      not_executed: expect.stringContaining('no supplied value fits this field'),
    });
    expect(JSON.stringify(requests[1])).toContain('no supplied value fits this field');
  });

  it('gives each distinct field its own retry before asking the caller', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE },
      { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: NO_SUPPLIED_VALUE },
    ]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({ status: 'needs_input', reason: 'No supplied value fits the field "Full name"' });
    expect(requests).toHaveLength(3);
    expect(acted).toEqual([]);
  });

  it('turns BLOCKED on empty fields without values into needs_input naming them, with no retry', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', value_for_1: 'name', value_for_2: NO_SUPPLIED_VALUE }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({ status: 'needs_input', reason: 'Blocked: no supplied value for "Email address"' });
    expect(requests).toHaveLength(1);
  });

  it('gates an irreversible click until the agent confirms, then allows exactly one', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
    const { asTab, acted } = fakeTab([
      page({ fingerprint: 'a' }),
      page({ fingerprint: 'b' }),
      page({ fingerprint: 'c' }),
    ]);
    const task = new BrowserTask(asTab, ask, { goal: 'Pay', maxSteps: 2 });

    const held = await task.run();
    expect(held.status).toBe('needs_confirmation');
    expect(held.reason).toContain('"Confirm booking and pay €412" on "Staylist" looks irreversible');
    expect(held.reason).toContain("Confirm only if the user's request named this action and this target;");
    expect(held.reason).toContain('a category ("anything unused", "old ones") names no target: list the candidates and ask the user.');
    expect(held.reason).toContain("To continue, call again with confirm_irreversible and confirm_target (the user's words naming the target).");
    expect(acted).toEqual([]);

    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    expect(summary.status).toBe('needs_confirmation');
  });

  it('names the page a risky click is on, cut to 80 characters, and leaves it out when the page has no title', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
    const long = 'Repository - ada/scratch - ' + 'x'.repeat(200);
    const titled = await new BrowserTask(fakeTab([page({ title: long })]).asTab, ask, { goal: 'Pay' }).run();
    expect(titled.reason).toContain(`on "${long.slice(0, 80)}" looks irreversible`);
    expect(titled.reason).not.toContain(long.slice(0, 81));
    const untitled = await new BrowserTask(fakeTab([page({ title: '' })]).asTab, ask, { goal: 'Pay' }).run();
    expect(untitled.reason).toContain('"Confirm booking and pay €412" looks irreversible');
  });

  describe('a new session started through the runner', () => {
    afterEach(() => vi.restoreAllMocks());

    const startWith = async (confirmIrreversible?: boolean, confirmTarget?: string) => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
      const { asTab, acted } = fakeTab();
      vi.spyOn(model, 'createAsk').mockReturnValue(ask);
      vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp: {} } as chrome.ChromeHandle);
      vi.spyOn(Tab, 'open').mockResolvedValue(asTab);
      const task = await createRunner('launch-headless').start({
        goal: 'Pay',
        url: 'http://fixture/pay',
        maxSteps: 1,
        confirmIrreversible,
        confirmTarget,
        changeWaitMs: 0,
      });
      return { summary: await task.run(), acted };
    };

    it('clicks the irreversible target once when the first call already carries the confirmation', async () => {
      const { summary, acted } = await startWith(true, STAYLIST);
      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.status).not.toBe('needs_confirmation');
    });

    it('still hands the irreversible click back without the confirmation', async () => {
      const { summary, acted } = await startWith();
      expect(summary.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });
  });

  describe('a confirmation counts only when it answers a needs_confirmation', () => {
    const pay = { operation: 'CLICK', click_target: '4', commit_risk: 0.9 };
    const unsure = { operation: 'CLICK', click_target: '1', confidence: 0.1 };
    const noValueForEmail = { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE };
    const pages = () => Array.from({ length: 12 }, (_, i) => page({ fingerprint: String(i) }));
    const options = { goal: 'Pay', values: { name: 'Ada' }, maxSteps: 1, changeWaitMs: 0 };

    it('clicks the risky target when the call right after a needs_confirmation carries the flag', async () => {
      const { ask } = scriptedJev([pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      expect((await task.run()).status).toBe('needs_confirmation');
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.confirm_ignored).toBeUndefined();
    });

    it('clicks the risky target when a new session\'s first call carries the flag', async () => {
      const { ask } = scriptedJev([pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.confirm_ignored).toBeUndefined();
    });

    it('ignores the flag on a call that follows an uncertain hand-back, and says so once', async () => {
      const { ask } = scriptedJev([unsure, pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      expect((await task.run()).status).toBe('uncertain');
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const ignored = await task.run();

      expect(ignored.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
      expect(ignored.confirm_ignored).toBe('the previous call ended uncertain, not needs_confirmation');

      const next = await task.run();
      expect(next.confirm_ignored).toBeUndefined();
    });

    it('ignores the flag on a call that follows a done, after an earlier confirmation was used', async () => {
      const { ask } = scriptedJev([pay, pay, { operation: 'DONE' }, pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, { ...options, maxSteps: 5 });

      expect((await task.run()).status).toBe('needs_confirmation');
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const finished = await task.run();
      expect(finished.status).toBe('done');
      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);

      task.update({ goal: 'Pay again', confirmIrreversible: true, confirmTarget: STAYLIST });
      const again = await task.run();

      expect(again.status).toBe('needs_confirmation');
      expect(acted).toHaveLength(1);
      expect(again.confirm_ignored).toBe('the previous call ended done, not needs_confirmation');
    });

    it('keeps a confirmation the first call gave through a needs_input, until a risky click uses it', async () => {
      const { ask } = scriptedJev([noValueForEmail, noValueForEmail, pay]);
      const { asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);

      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const asked = await task.run();
      expect(asked).toMatchObject({ status: 'needs_input', reason: 'No supplied value fits the field "Email address"' });
      expect(acted).toEqual([]);

      task.update({ values: { email: 'ada@example.com' }, confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
      expect(summary.confirm_ignored).toBeUndefined();
    });
  });

  describe('a confirmation allows only the control it answered', () => {
    const PAY = 'Confirm booking and pay €412';
    const CANCEL = 'Cancel my reservation';
    const cancelButton: PageAction = { id: 'e6', kind: 'click', node: 5, role: 'button', label: CANCEL };
    const twoRisky = (fingerprint: string, url = 'http://fixture/stays') =>
      page({ url, actions: [...bookingActions, cancelButton], fingerprint });
    // The first call's page, then every later observation on `laterUrl`.
    const pagesOn = (firstUrl: string, laterUrl = firstUrl) =>
      Array.from({ length: 12 }, (_, i) => twoRisky(String(i), i === 0 ? firstUrl : laterUrl));
    const pay = { operation: 'CLICK', click_target: '4', commit_risk: 0.9 };
    const cancel = { operation: 'CLICK', click_target: '5', commit_risk: 0.9 };
    const options = { goal: 'Pay for the Staylist booking', maxSteps: 1, changeWaitMs: 0 };
    const flaggedThen = async (steps: Record<string, any>[], pages = pagesOn('http://fixture/stays')) => {
      const { ask } = scriptedJev(steps);
      const { asTab, acted } = fakeTab(pages);
      const task = new BrowserTask(asTab, ask, options);
      const flagged = await task.run();
      expect(flagged.reason).toMatch(new RegExp(`^Clicking "${PAY}"`));
      return { task, acted };
    };

    it('clicks the control that was flagged', async () => {
      const { task, acted } = await flaggedThen([pay, pay]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
    });

    it('hands back a different risky control, naming it and the one confirmed, and clicks nothing', async () => {
      const { task, acted } = await flaggedThen([pay, cancel]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toMatch(new RegExp(`^Clicking "${CANCEL}" on "Staylist" looks irreversible`));
      expect(summary.reason).toContain(`The confirmation given was for "${PAY}" on /stays, a different control, so it was not used.`);
      expect(summary.reason).toContain('To continue, call again with confirm_irreversible and confirm_target');
      expect(acted).toEqual([]);
    });

    it('lets the agent confirm the new control in turn, and then clicks only that one', async () => {
      const { task, acted } = await flaggedThen([pay, cancel, cancel]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: CANCEL }]);
    });

    it('spends the old confirmation when it hands back the different control', async () => {
      const { task, acted } = await flaggedThen([pay, cancel, pay]);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      const after = await task.run();
      expect(after.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });

    it('treats the same label on another page path as another control', async () => {
      const { task, acted } = await flaggedThen([pay, pay], pagesOn('http://fixture/stays/41', 'http://fixture/stays/42'));
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toContain(`The confirmation given was for "${PAY}" on /stays/41, a different control`);
      expect(acted).toEqual([]);
    });

    it('treats a changed query string as the same page, as a single-page app rewrites it', async () => {
      const { task, acted } = await flaggedThen([pay, pay], pagesOn('http://fixture/stays?tab=1', 'http://fixture/stays?tab=2#top'));
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
    });

    it('lets a new session\'s first-call confirmation, which answers no flagged control, click either one', async () => {
      const { ask } = scriptedJev([cancel]);
      const { asTab, acted } = fakeTab(pagesOn('http://fixture/stays'));
      const task = new BrowserTask(asTab, ask, options);
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: CANCEL }]);
    });
  });

  describe('a confirmation must name its target in the user\'s words', () => {
    const DELETE = 'Delete this repository';
    const scratchPage = (fingerprint: string, overrides: Partial<PageState> = {}) =>
      page({
        url: 'http://fixture/ada/scratch/settings',
        title: 'ada/scratch - Settings',
        text: `Danger zone\n${DELETE}`,
        actions: [{ id: 'e1', kind: 'click', node: 1, role: 'button', label: DELETE }],
        fingerprint,
        ...overrides,
      });
    const manyPages = (make: (fingerprint: string) => PageState) => Array.from({ length: 12 }, (_, i) => make(String(i)));
    const deleteIt = { operation: 'CLICK', click_target: '1', commit_risk: 0.9 };
    const options = { goal: 'Delete the repository ada/scratch', maxSteps: 1, changeWaitMs: 0 };
    // The run has asked whether to delete, and waits for the calling agent's answer.
    const askedToDelete = async (make = scratchPage) => {
      const { ask } = scriptedJev([deleteIt]);
      const { asTab, acted } = fakeTab(manyPages(make));
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');
      return { task, acted };
    };
    const refusalFor = (target: string, title = 'ada/scratch - Settings') =>
      `confirm_target "${target}" names nothing "${DELETE}" acts on here (page "${title}", its address, the visible text or the values typed on this page); ask the user which one they mean.`;

    it.each(['ada/scratch', 'the repository ada/scratch', 'the repository named "ada/scratch"', '"Ada/Scratch".'])(
      'clicks when the target is shown by the page title: %s',
      async (confirmTarget) => {
        const { task, acted } = await askedToDelete();
        task.update({ confirmIrreversible: true, confirmTarget });
        await task.run();
        expect(acted).toEqual([{ label: DELETE }]);
      },
    );

    it('refuses a confirmation that carries no target, and clicks nothing', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toBe(`confirm_irreversible needs confirm_target: the words from the user's request that name what "${DELETE}" acts on.`);
      expect(acted).toEqual([]);
    });

    it('refuses a first call whose confirmation carries no target', async () => {
      const { ask } = scriptedJev([deleteIt]);
      const { asTab, acted } = fakeTab(manyPages(scratchPage));
      const task = new BrowserTask(asTab, ask, options);
      task.update({ confirmIrreversible: true });
      const summary = await task.run();
      expect(summary.reason).toContain('confirm_irreversible needs confirm_target');
      expect(acted).toEqual([]);
    });

    it.each(['anything unused', 'anything that looks unused'])('refuses a category: %s names nothing on the page', async (confirmTarget) => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget });
      const summary = await task.run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toBe(refusalFor(confirmTarget));
      expect(acted).toEqual([]);
    });

    // The page's own text shows "Delete this repository" too, and still the action's words are not a target.
    it.each(['delete', 'this repository', 'Delete this repository'])('refuses the action\'s own words: %s', async (confirmTarget) => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget });
      expect((await task.run()).reason).toBe(refusalFor(confirmTarget));
      expect(acted).toEqual([]);
    });

    it('refuses the wrong target: another repository than the page is on', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'ada/app' });
      const summary = await task.run();
      expect(summary.reason).toBe(refusalFor('ada/app'));
      expect(acted).toEqual([]);
    });

    it('refuses a target when only some of its words are on the page', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'ada/scratch and ada/app' });
      expect((await task.run()).reason).toBe(refusalFor('ada/scratch and ada/app'));
      expect(acted).toEqual([]);
    });

    it('refuses a target made only of words too short to name anything', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'qq' });
      expect((await task.run()).reason).toBe(refusalFor('qq'));
      expect(acted).toEqual([]);
    });

    it('cuts the page title in the refusal to 80 characters, and leaves it out when the page has none', async () => {
      const long = 'ada/scratch - Settings - ' + 'x'.repeat(200);
      const titled = await askedToDelete((fingerprint) => scratchPage(fingerprint, { title: long }));
      titled.task.update({ confirmIrreversible: true, confirmTarget: 'ada/app' });
      expect((await titled.task.run()).reason).toBe(refusalFor('ada/app', long.slice(0, 80)));

      const untitled = await askedToDelete((fingerprint) => scratchPage(fingerprint, { title: '' }));
      untitled.task.update({ confirmIrreversible: true, confirmTarget: 'ada/app' });
      expect((await untitled.task.run()).reason).toContain('here (its address, the visible text or the values typed on this page)');
    });

    it('matches the address when the title does not name the target', async () => {
      const { task, acted } = await askedToDelete((fingerprint) => scratchPage(fingerprint, { title: '' }));
      task.update({ confirmIrreversible: true, confirmTarget: 'ada/scratch' });
      await task.run();
      expect(acted).toEqual([{ label: DELETE }]);
    });

    it('matches the visible text when neither the title nor the address names the target', async () => {
      const bare = (fingerprint: string) =>
        scratchPage(fingerprint, { title: '', url: 'http://fixture/settings', text: 'Danger zone\nRemove ada/scratch for good' });
      const { task, acted } = await askedToDelete(bare);
      task.update({ confirmIrreversible: true, confirmTarget: 'remove ada/scratch' });
      await task.run();
      expect(acted).toEqual([{ label: DELETE }]);
    });

    it('matches an issue title for the Comment button, whose label says nothing of the issue', async () => {
      const issuePage = (fingerprint: string) =>
        page({
          url: 'http://fixture/ada/app/issues/1',
          title: 'Login fails on Safari · Issue #1',
          text: 'Login fails on Safari\nWrite\nComment',
          actions: [{ id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Comment' }],
          fingerprint,
        });
      const { ask } = scriptedJev([deleteIt]);
      const { asTab, acted } = fakeTab(manyPages(issuePage));
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');

      task.update({ confirmIrreversible: true, confirmTarget: 'Login fails on Safari' });
      await task.run();

      expect(acted).toEqual([{ label: 'Comment' }]);
    });

    describe('on a page that does not show the target outside what was typed', () => {
      const field = (label: string, node: number): PageAction => ({ id: `e${node}`, kind: 'fill', node, role: 'textbox', label, value: '' });
      const formPage = (fingerprint: string, url: string, title: string, fieldLabel: string, button: string) =>
        page({
          url,
          title,
          text: title,
          actions: [field(fieldLabel, 1), { id: 'e2', kind: 'click', node: 2, role: 'button', label: button }],
          fingerprint,
        });
      const typeInto = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'value' };
      const submit = { operation: 'CLICK', click_target: '2', commit_risk: 0.9 };
      const callWith = (value: string) => ({ goal: 'Fill the form with the value', values: { value }, maxSteps: 5, changeWaitMs: 0 });

      describe('a sign-up page', () => {
        const signUpPage = (fingerprint: string) =>
          formPage(fingerprint, 'http://fixture/user/sign_up', 'Create account', 'Username', 'Register');
        const withUsername = { goal: 'Create an account with the username in values', values: { username: 'signup-3-x7k2qa' }, maxSteps: 5, changeWaitMs: 0 };

        it('matches the username value this task typed on the page', async () => {
          const { ask } = scriptedJev([{ ...typeInto, value_for_1: 'username' }, submit]);
          const { asTab, acted } = fakeTab(manyPages(signUpPage));
          const task = new BrowserTask(asTab, ask, withUsername);
          expect((await task.run()).status).toBe('needs_confirmation');

          task.update({ confirmIrreversible: true, confirmTarget: 'signup-3-x7k2qa' });
          await task.run();

          expect(acted).toEqual([{ label: 'Username', text: 'signup-3-x7k2qa' }, { label: 'Register' }]);
        });

        it('does not count a supplied value that was never typed there', async () => {
          const { ask } = scriptedJev([submit]);
          const { asTab, acted } = fakeTab(manyPages(signUpPage));
          const task = new BrowserTask(asTab, ask, withUsername);
          expect((await task.run()).status).toBe('needs_confirmation');

          task.update({ confirmIrreversible: true, confirmTarget: 'signup-3-x7k2qa' });
          const summary = await task.run();

          expect(summary.reason).toBe(
            `confirm_target "signup-3-x7k2qa" names nothing "Register" acts on here (page "Create account", its address, the visible text or the values typed on this page); ask the user which one they mean.`,
          );
          expect(acted).toEqual([]);
        });
      });

      it('matches the name typed into a new milestone', async () => {
        const milestonePage = (fingerprint: string) =>
          formPage(fingerprint, 'http://fixture/ada/app/milestones/new', 'New Milestone', 'Title', 'Create milestone');
        const { ask } = scriptedJev([typeInto, submit]);
        const { asTab, acted } = fakeTab(manyPages(milestonePage));
        const task = new BrowserTask(asTab, ask, callWith('v1.2'));
        expect((await task.run()).status).toBe('needs_confirmation');

        task.update({ confirmIrreversible: true, confirmTarget: 'v1.2' });
        await task.run();

        expect(acted).toEqual([{ label: 'Title', text: 'v1.2' }, { label: 'Create milestone' }]);
      });
    });

    it('clears a refused confirmation: the next risky click is handed back until the agent answers again', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'anything that looks unused' });
      expect((await task.run()).reason).toBe(refusalFor('anything that looks unused'));

      const handedBack = await task.run();
      expect(handedBack.status).toBe('needs_confirmation');
      expect(handedBack.reason).toContain(`Clicking "${DELETE}" on "ada/scratch - Settings" looks irreversible`);
      expect(acted).toEqual([]);
    });

    it('lets the agent answer a refusal with the words that do name the target', async () => {
      const { task, acted } = await askedToDelete();
      task.update({ confirmIrreversible: true, confirmTarget: 'anything that looks unused' });
      expect((await task.run()).status).toBe('needs_confirmation');

      task.update({ confirmIrreversible: true, confirmTarget: 'ada/scratch' });
      await task.run();

      expect(acted).toEqual([{ label: DELETE }]);
    });

    it('keeps the target a first call gave through a needs_input, and takes no new one from a call that is not answering', async () => {
      const noValueForEmail = { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE };
      const { ask } = scriptedJev([noValueForEmail, noValueForEmail, { operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
      const { asTab, acted } = fakeTab(manyPages((fingerprint) => page({ fingerprint })));
      const task = new BrowserTask(asTab, ask, { goal: 'Pay', values: { name: 'Ada' }, maxSteps: 1, changeWaitMs: 0 });

      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      expect((await task.run()).status).toBe('needs_input');
      task.update({ values: { email: 'ada@example.com' }, confirmIrreversible: true, confirmTarget: 'anything unused' });
      await task.run();

      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    });
  });

  describe('the confirm dialog a confirmed click opens', () => {
    const PAY = 'Confirm booking and pay €412';
    const pay = { operation: 'CLICK', click_target: '4', commit_risk: 0.9 };
    const safe = { operation: 'CLICK', click_target: '4', commit_risk: 0.1 };
    const pages = () => Array.from({ length: 12 }, (_, i) => page({ fingerprint: String(i) }));
    const options = { goal: 'Pay', maxSteps: 1, changeWaitMs: 0 };
    // What the tab records when it answered OK to the dialog the click opened.
    const answeredOk = { type: 'confirm', message: 'Pay €412 now?', accepted: true };
    const confirmed = { confirmIrreversible: true, confirmTarget: STAYLIST };

    it('arms the next confirm with the user\'s words and the control\'s label, and notes the OK on the step', async () => {
      const { ask } = scriptedJev([pay]);
      const { tab, asTab } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');
      expect(tab.armedAtAct).toEqual([]);

      tab.dialogOnAct = answeredOk;
      task.update(confirmed);
      const summary = await task.run();

      expect(tab.armedAtAct).toEqual([[STAYLIST, PAY]]);
      expect(summary.steps[0].element).toContain('asked "Pay €412 now?" in a confirm dialog; answered OK (the click the caller confirmed)');
    });

    it('never arms a click the caller did not confirm', async () => {
      const { ask } = scriptedJev([pay]);
      const { tab, asTab, acted } = fakeTab(pages());
      expect((await new BrowserTask(asTab, ask, options).run()).status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
      expect(tab.armedAtAct).toEqual([]);
      expect(tab.armed).toBeUndefined();
    });

    it('never arms a click that is not risky, even with a confirmation waiting', async () => {
      const { ask } = scriptedJev([safe]);
      const { tab, asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      task.update(confirmed);
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(tab.armedAtAct).toEqual([undefined]);
    });

    it('takes the arm back after the step, also when no dialog opened', async () => {
      const { ask } = scriptedJev([pay]);
      const { tab, asTab, acted } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      task.update(confirmed);
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(tab.armedAtAct).toEqual([[STAYLIST, PAY]]);
      expect(tab.armed).toBeUndefined();
    });

    it('does not carry the arm into the next step when the click never reached the page', async () => {
      const { ask } = scriptedJev([pay, safe]);
      const { tab, asTab, acted } = fakeTab(pages());
      tab.staleOnce = true;
      const task = new BrowserTask(asTab, ask, options);
      task.update(confirmed);
      await task.run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(tab.armedAtAct).toEqual([[STAYLIST, PAY], undefined]);
    });

    it('does not count an accepted confirm toward "the page keeps asking", where a declined one is a loop', async () => {
      const dialogTwice = async (accepted: boolean) => {
        const { ask } = scriptedJev([pay]);
        const { tab, asTab } = fakeTab(pages());
        tab.dialogOnAct = { ...answeredOk, accepted };
        const task = new BrowserTask(asTab, ask, options);
        task.update(confirmed);
        await task.run();
        expect((await task.run()).status).toBe('needs_confirmation');
        task.update(confirmed);
        return task.run();
      };
      expect((await dialogTwice(true)).status).toBe('step_budget');
      expect((await dialogTwice(false)).status).toBe('blocked');
    });
  });

  it('gives a gray-zone click a screenshot look before it runs, and a clearly safe one none', async () => {
    const run = async (commit_risk: number) => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk }]);
      const { tab, asTab, acted } = fakeTab();
      await new BrowserTask(asTab, ask, { goal: 'Pay', maxSteps: 1, screenshots: 'fallback', changeWaitMs: 0 }).run();
      return { requests, screenshots: tab.screenshots, acted };
    };

    const gray = await run(0.35);
    expect(gray).toMatchObject({ screenshots: 1, acted: [{ label: 'Confirm booking and pay €412' }] });
    expect(gray.requests).toHaveLength(2);

    const safe = await run(0.1);
    expect(safe.screenshots).toBe(0);
    expect(safe.requests).toHaveLength(1);
  });

  it('waits and re-decides when the completion check rejects DONE', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'DONE', done_check: 0.1 },
      { operation: 'DONE', done_check: 0.97 },
    ]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Search', doneWhen: 'Results listed' }).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.97 });
    expect(requests).toHaveLength(2);
  });

  it('re-observes and re-decides when the page moved before input', async () => {
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '1' },
      { operation: 'CLICK', click_target: '1' },
      { operation: 'DONE' },
    ]);
    const { tab, asTab, acted } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    tab.staleOnce = true;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(acted).toHaveLength(1);
    expect(summary.jev.requests).toBe(3);
  });

  it('stops as blocked when three actions change nothing', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Loop', changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({ status: 'blocked', reason: 'The last 3 actions did not change the page' });
    expect(summary.steps).toHaveLength(3);
  });

  describe('on a page that changes faster than a decision takes', () => {
    const PAY = 'Confirm booking and pay €412';
    const options = { goal: 'Pay', maxSteps: 5, changeWaitMs: 0 };

    it('does not spend the decision budget on clicks the page refused', async () => {
      // maxSteps 5 gives 10 decisions: 10 refusals plus the click and DONE would end step_budget if each were charged; 10 is the most the cap allows.
      const clicks = Array.from({ length: 11 }, () => ({ operation: 'CLICK', click_target: '4' }));
      const { ask } = scriptedJev([...clicks, { operation: 'DONE' }]);
      const { tab, asTab, acted } = fakeTab([page({ fingerprint: 'before' }), page({ fingerprint: 'after' })]);
      tab.stale = 10;
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([{ label: PAY }]);
      expect(summary.status).toBe('done');
    });

    it('hands back blocked once clicks have been refused more than 2 times maxSteps', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4' }]);
      const { tab, asTab, acted } = fakeTab();
      tab.stale = 1000;
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({
        status: 'blocked',
        reason: `The page kept changing under the click: "${PAY}" was refused 11 times as stale`,
      });
      expect(tab.calls).toHaveLength(11);
      expect(acted).toEqual([]);
    });

    it('still ends step_budget when decisions are spent without a refusal', async () => {
      // A stop the page has already moved past is re-decided without acting; none of that is a refusal, so the 10-decision budget holds.
      const { ask, requests } = scriptedJev([{ operation: 'BLOCKED' }]);
      const { tab, asTab } = fakeTab();
      tab.fresh = async () => false;
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'step_budget', reason: 'Made 10 decisions without finishing' });
      expect(requests).toHaveLength(10);
    });
  });
});

describe('screenshots', () => {
  const shaky: Record<string, string | number>[] = [{ operation: 'CLICK', click_target: '1', confidence: 0.1 }, { operation: 'DONE' }];

  it('off: a low-confidence step hands back without a screenshot', async () => {
    const { ask, requests } = scriptedJev(shaky);
    const { tab, asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('uncertain');
    expect(tab.screenshots).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('fallback: re-decides the shaky step with a marked screenshot, then acts on that decision', async () => {
    const { ask, requests } = scriptedJev([...shaky.slice(0, 1), { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', screenshots: 'fallback' }).run();
    expect(summary).toMatchObject({ status: 'done', jev: { requests: 2, screenshots: 1 } });
    expect(Array.isArray(requests[0].state)).toBe(false);
    expect((requests[1].state as any)[0].type).toBe('image_url');
    expect(tab.screenshots).toBe(1);
  });

  it('fallback: a confident step stays text-only', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab();
    await new BrowserTask(asTab, ask, { goal: 'Open', screenshots: 'fallback' }).run();
    expect(tab.screenshots).toBe(0);
  });

  it('always: every decision carries a screenshot', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    await new BrowserTask(asTab, ask, { goal: 'Open', screenshots: 'always' }).run();
    expect(requests.every((request) => Array.isArray(request.state))).toBe(true);
  });

  it('records a sharp shot before each action and of the final page, never sent to the model', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-record-'));
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', recordDir }).run();
    expect(summary.status).toBe('done');
    expect(tab.recorded).toBe(2);
    expect(tab.screenshots).toBe(0);
    expect(requests.some((request) => Array.isArray(request.state))).toBe(false);
    expect(readdirSync(recordDir).sort()).toEqual(['01.jpg', '02.jpg', 'index.html', 'summary.json']);
    const { steps } = JSON.parse(readFileSync(join(recordDir, 'summary.json'), 'utf8'));
    expect(steps.map((s: { operation: string }) => s.operation)).toEqual(['CLICK', 'done']);
    expect(steps[0].description).toMatch(/^Click "/);
    expect(readFileSync(join(recordDir, 'index.html'), 'utf8')).toContain('<img src="01.jpg"');
  });

  it('returns the run\'s own status when its recording cannot start or take the final shot', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab();
    const dropped = async () => {
      throw new Error('Browser connection closed');
    };
    tab.send = dropped;
    tab.markedScreenshot = async (_marks, _viewport, options) => {
      if (options?.sharp) return dropped();
      return 'SCREENSHOT';
    };
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-record-'));
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', recordDir }).run();
    expect(summary.status).toBe('done');
  });

  it('holds each video frame until the next, without freezing on idle stretches', () => {
    expect(frameDurations([10, 10.2, 19, 19.01]).map((s) => Number(s.toFixed(3)))).toEqual([0.2, 1.5, 0.033, 1.5]);
  });

  it('places each step in the video by the frames shown before it', () => {
    const times = [100, 100.5, 110];
    expect(videoOffset(times, frameDurations(times), 105)).toBe(2);
  });

  it('describes steps as plain sentences, cutting long row labels at a word', () => {
    expect(describeStep({ operation: 'TYPE_TEXT', element: 'Search', valueKey: 'search_query' })).toBe(
      'Type the "search_query" value into "Search"',
    );
    const row = describeStep({ operation: 'CLICK', element: `2026-10-15 15:19:13 handle-chatbot-message ${'x '.repeat(60)}` });
    expect(row).toMatch(/^Click "2026-10-15 15:19:13 handle-chatbot-message[^"]*…"$/);
    expect(row.length).toBeLessThan(85);
  });

  it('replaces the shot of an action the page moved away from with its retry', async () => {
    const click = { operation: 'CLICK', click_target: '1' };
    const { ask } = scriptedJev([click, click, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    tab.staleOnce = true;
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-record-'));
    await new BrowserTask(asTab, ask, { goal: 'Open', recordDir }).run();
    const { steps } = JSON.parse(readFileSync(join(recordDir, 'summary.json'), 'utf8'));
    expect(steps.map((s: { file: string; operation: string }) => [s.file, s.operation])).toEqual([
      ['01.jpg', 'CLICK'],
      ['02.jpg', 'done'],
    ]);
  });
});

describe('JPEG size', () => {
  // A 7x3 screenshot from Chrome: an ICC profile segment sits between the file header and the frame header.
  const chromeJpeg =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+AjIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//j/2wBDASstLTw1PHZBQXb4pYyl+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj/wAARCAADAAcDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJIAP//Z';

  it('reads the width and height of a real screenshot, skipping the segments before its frame', () => {
    expect(jpegSize(chromeJpeg)).toEqual({ width: 7, height: 3 });
  });

  it('reads a frame header that follows fill bytes and a comment segment', () => {
    // SOI, fill bytes, a 4-byte comment segment, then SOF0 (8 bits, height 1536, width 709).
    const bytes = [0xff, 0xd8, 0xff, 0xff, 0xfe, 0x00, 0x04, 0x61, 0x62, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x06, 0x00, 0x02, 0xc5, 0x01];
    expect(jpegSize(Buffer.from(bytes).toString('base64'))).toEqual({ width: 709, height: 1536 });
  });

  it('is null for bytes that are not a JPEG, or a JPEG cut off before its frame', () => {
    expect(jpegSize(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64'))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64'))).toBeNull();
    expect(jpegSize('')).toBeNull();
  });
});

describe('model choice', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('routes Jev to the TypeSafe API when its key is set, otherwise through OpenRouter', () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(resolveModel({ model: 'jev' })).toMatchObject({
      profile: { model: 'typesafe/jev-1.14', baseURL: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY' },
      screenshots: 'fallback',
    });
    expect(resolveModel({ model: 'jev' }).profile).toMatchObject({
      model: 'typesafe/jev-1.14',
      baseURL: 'https://openrouter.ai/api',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    });
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-key');
    const direct = resolveModel({ model: 'jev' });
    expect(direct).toMatchObject({
      profile: { model: 'jev-1.14.0', apiKeyEnv: 'TYPESAFE_API_KEY', imageTransport: 'assets', box: true },
      screenshots: 'fallback',
    });
    expect(direct.profile.baseURL).toBeUndefined();
    // OpenRouter drops TypeSafe's `assets` map, so Box only runs on the direct route.
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(resolveModel({ model: 'jev' }).profile).toMatchObject({ imageTransport: 'image_url', box: false });
  });

  it('defaults Clef to text-only and Clef-omni to a screenshot every step', () => {
    expect(resolveModel({ model: 'clef' })).toMatchObject({ screenshots: 'off' });
    expect(resolveModel({ model: 'clef-omni' })).toMatchObject({
      profile: { model: 'cloudflare/clef-omni', apiKeyEnv: 'OPENROUTER_API_KEY' },
      screenshots: 'always',
    });
  });

  it('refuses screenshots for a model that cannot read them, and unknown names', () => {
    expect(() => resolveModel({ model: 'clef', screenshots: 'always' })).toThrow(/cannot read screenshots/);
    expect(() => resolveModel({ model: 'gpt' })).toThrow(/Unknown model/);
    expect(() => resolveModel({ model: 'clef-omni', screenshots: 'sometimes' })).toThrow(/Unknown screenshot mode/);
  });
});

describe('per-element commit risk', () => {
  const input = { page: page(), goal: 'Book', values: {}, history: [], checkCommitRisk: true };

  it('drops the page-level guess and asks about the chosen click by name', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '4', risk_4: 0.92 }]);
    const decision = await decide(ask, { ...input, elementRisk: 'chosen' });
    expect(requests[0].questions).not.toHaveProperty('commit_risk');
    expect(Object.keys(requests[1].questions)).toEqual(['risk_4']);
    expect((requests[1].questions.risk_4 as any).instructions.element.element).toBe('[4] Confirm booking and pay €412');
    expect(decision).toMatchObject({ commitRisk: 0.92, elementRisks: { '4': 0.92 }, requests: 2 });
  });

  it('asks about a collapsed control the click head favours when the operation is BLOCKED, and about no other', async () => {
    const folded = foldedPage('a', 'false');
    const more = clickTargetOf(folded, 'Show more details');
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: more, [`risk_${more}`]: 0.02 }]);
    const decision = await decide(ask, { ...input, page: folded, elementRisk: 'chosen' });
    expect(Object.keys(requests[1].questions)).toEqual([`risk_${more}`]);
    expect(decision).toMatchObject({ operation: 'BLOCKED', elementRisks: { [more]: 0.02 }, requests: 2 });

    const plain = foldedPage('a');
    const unfolded = scriptedJev([{ operation: 'BLOCKED', click_target: clickTargetOf(plain, 'Show more details') }]);
    expect((await decide(unfolded.ask, { ...input, page: plain, elementRisk: 'chosen' })).requests).toBe(1);
  });

  it('asks about every collapsed overflow control when the operation is BLOCKED, and about no other collapsed one', async () => {
    const chips = [overflowChip(32, 'Show 3 more tags'), overflowChip(33, '⋯'), overflowChip(34, 'Filters')];
    const state = overflowPage('a', chips);
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: clickTargetOf(state, 'Open menu') }]);
    const decision = await decide(ask, { ...input, page: state, elementRisk: 'chosen' });
    const judged = ['Show 3 more tags', '⋯'].map((label) => clickTargetOf(state, label));
    expect(Object.keys(requests[1].questions)).toEqual(judged.map((index) => `risk_${index}`));
    expect(Object.keys(decision.elementRisks!)).toEqual(judged);
  });

  it('judges the overflow controls for an unsure step once the bar is passed, and for a confident one never', async () => {
    const state = overflowPage('a', [overflowChip(32, 'Show 1 more session details'), overflowChip(33, 'More actions')]);
    const menu = clickTargetOf(state, 'Open menu');
    const chips = ['Show 1 more session details', 'More actions'].map((label) => clickTargetOf(state, label));
    const judged = async (confidence: number, unsureBelow?: number) => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', confidence, click_target: menu }]);
      await decide(ask, { ...input, page: state, elementRisk: 'chosen', unsureBelow });
      return Object.keys(requests[1].questions);
    };
    expect(await judged(0.22, 0.3)).toEqual([menu, ...chips].map((index) => `risk_${index}`));
    expect(await judged(0.95, 0.3)).toEqual([`risk_${menu}`]);
    expect(await judged(0.22)).toEqual([`risk_${menu}`]);
  });

  describe('with a collapsed "More actions" on each of five rows', () => {
    const chips = [0, 1, 2, 3, 4].map((row) => overflowChip(32 + row, 'More actions'));
    const state = overflowPage('a', chips);
    // The two header menus take indexes 1 and 2, so row n's chip is element 3 + n.
    const rowChip = (row: number) => String(3 + row);

    it('judges only three of them by name when the operation is BLOCKED', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: clickTargetOf(state, 'Open menu') }]);
      await decide(ask, { ...input, page: state, elementRisk: 'chosen' });
      expect(Object.keys(requests[1].questions)).toEqual([0, 1, 2].map((row) => `risk_${rowChip(row)}`));
    });

    it('picks the three the click head ranks highest', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', click_target: rowChip(4) }]);
      await decide(ask, { ...input, page: state, elementRisk: 'chosen' });
      expect(Object.keys(requests[1].questions).sort()).toEqual([4, 0, 1].map((row) => `risk_${rowChip(row)}`).sort());
    });
  });

  it('scores the ranked taps for the autopilot, and a malformed score counts as risky', async () => {
    const ask: Ask = async (request) => {
      if (!('operation' in request.questions)) return { answers: { risk_1: { noul: 0.1 } }, usage: { input_tokens: 1 } };
      return scriptedJev([{ operation: 'WAIT' }]).ask(request);
    };
    const decision = await decide(ask, { ...input, elementRisk: 'ranked' });
    expect(decision.elementRisks).toEqual({ '1': 0.1, '4': 1 });
  });

  describe('with the page-level question kept (Jev)', () => {
    const run = async (script: Record<string, any>) => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', ...script }]);
      const { asTab, acted } = fakeTab();
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pay', maxSteps: 1, elementRisk: true, pageRisk: true, changeWaitMs: 0 }).run();
      return { summary, acted };
    };

    it('holds the click when only the chosen element looks irreversible', async () => {
      const { summary, acted } = await run({ commit_risk: 0.2, risk_4: 0.8 });
      expect(summary.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });

    it('holds the click when only the page looks irreversible: the higher of the two wins', async () => {
      const { summary, acted } = await run({ commit_risk: 0.8, risk_4: 0.1 });
      expect(summary.status).toBe('needs_confirmation');
      expect(acted).toEqual([]);
    });

    it('lets the click through when both questions find it safe', async () => {
      const { acted } = await run({ commit_risk: 0.1, risk_4: 0.1 });
      expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    });

    it('asks the page-level question only when pageRisk is on', () => {
      const space = buildActionSpace(bookingActions);
      expect(buildRequest({ ...input, elementRisk: 'chosen', pageRisk: true }, space).questions).toHaveProperty('commit_risk');
      expect(buildRequest({ ...input, elementRisk: 'chosen', pageRisk: false }, space).questions).not.toHaveProperty('commit_risk');
    });

    // An issue form: a Labels dropdown beside a Create button, so the page-level question reads the Create button.
    describe('opening a collapsed control', () => {
      const issueForm = (expanded?: string) =>
        page({
          actions: [
            { id: 'labels', kind: 'click', node: 10, role: 'button', label: 'Labels', ...(expanded && { expanded }) },
            { id: 'create', kind: 'click', node: 11, role: 'button', label: 'Create issue' },
            { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
          ],
        });
      const opening = async (form: PageState, script: Record<string, any>) => {
        const labels = clickTargetOf(form, 'Labels');
        const { ask } = scriptedJev([{ operation: 'CLICK', click_target: labels, [`risk_${labels}`]: 0.01, ...script }]);
        const { asTab, acted } = fakeTab([form]);
        const options = { goal: 'Label the issue', maxSteps: 1, elementRisk: true, pageRisk: true, changeWaitMs: 0 };
        const task = new BrowserTask(asTab, ask, options);
        const summary = await task.run();
        return { summary, acted, commitRisk: task.trace[0].decision.commitRisk };
      };

      it('is judged by its name alone: the page-level question reads the Create button, not the dropdown', async () => {
        const { summary, acted, commitRisk } = await opening(issueForm('false'), { commit_risk: 0.55 });
        expect(commitRisk).toBe(0.01);
        expect(acted).toEqual([{ label: 'Labels' }]);
        expect(summary.status).not.toBe('needs_confirmation');
      });

      it('keeps the higher of the two for a control that is not collapsed', async () => {
        const { summary, acted, commitRisk } = await opening(issueForm(), { commit_risk: 0.55 });
        expect(commitRisk).toBe(0.55);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it('keeps the higher of the two for a control that is already open', async () => {
        const { summary, acted } = await opening(issueForm('true'), { commit_risk: 0.55 });
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it('still asks for confirmation when its name says irreversible', async () => {
        const form = issueForm('false');
        const { summary, acted } = await opening(form, { commit_risk: 0.1, [`risk_${clickTargetOf(form, 'Labels')}`]: 0.7 });
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });
    });

    // The same form with its Labels list open: the page-level question still reads the Create button, not the row picked.
    describe('picking from an open list', () => {
      const openList = (row: { role: string; label: string }, listExpanded?: string) =>
        page({
          actions: [
            { id: 'labels', kind: 'click', node: 10, role: 'combobox', label: 'Labels', ...(listExpanded && { expanded: listExpanded }) },
            { id: 'row', kind: 'click', node: 12, ...row },
            { id: 'other', kind: 'click', node: 13, role: row.role, label: 'help wanted' },
            { id: 'create', kind: 'click', node: 11, role: 'button', label: 'Create issue' },
            { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
          ],
        });
      const picking = async (form: PageState, label: string, script: Record<string, any>) => {
        const row = clickTargetOf(form, label);
        const { ask } = scriptedJev([{ operation: 'CLICK', click_target: row, commit_risk: 0.55, [`risk_${row}`]: 0.01, ...script }]);
        const { asTab, acted } = fakeTab([form]);
        const options = { goal: 'Label the issue', maxSteps: 1, elementRisk: true, pageRisk: true, changeWaitMs: 0 };
        const task = new BrowserTask(asTab, ask, options);
        const summary = await task.run();
        return { summary, acted, commitRisk: task.trace[0].decision.commitRisk };
      };

      it('is judged by its own name: the page-level question reads the Create button, not the row', async () => {
        const form = openList({ role: 'option', label: 'bug' }, 'true');
        const { summary, acted, commitRisk } = await picking(form, 'bug', {});
        expect(commitRisk).toBe(0.01);
        expect(acted).toEqual([{ label: 'bug' }]);
        expect(summary.status).not.toBe('needs_confirmation');
      });

      it.each(['menuitemcheckbox', 'menuitemradio'])('judges a %s row the same way', async (role) => {
        const form = openList({ role, label: 'bug' }, 'true');
        const { summary, acted, commitRisk } = await picking(form, 'bug', {});
        expect(commitRisk).toBe(0.01);
        expect(acted).toEqual([{ label: 'bug' }]);
        expect(summary.status).not.toBe('needs_confirmation');
      });

      it.each([
        ['menuitem', 'Delete'],
        ['checkbox', 'Subscribe'],
      ])('keeps the higher of the two for a %s row, which performs an action', async (role, label) => {
        const form = openList({ role, label }, 'true');
        const { summary, acted, commitRisk } = await picking(form, label, {});
        expect(commitRisk).toBe(0.55);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it.each([undefined, 'false'])('keeps the higher of the two for an option when no list is open (expanded %s)', async (listExpanded) => {
        const form = openList({ role: 'option', label: 'bug' }, listExpanded);
        const { summary, acted, commitRisk } = await picking(form, 'bug', {});
        expect(commitRisk).toBe(0.55);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });

      it('still asks for confirmation when the option name says irreversible', async () => {
        const form = openList({ role: 'option', label: 'Delete project' }, 'true');
        const { summary, acted, commitRisk } = await picking(form, 'Delete project', { commit_risk: 0.1, [`risk_${clickTargetOf(form, 'Delete project')}`]: 0.8 });
        expect(commitRisk).toBe(0.8);
        expect(summary.status).toBe('needs_confirmation');
        expect(acted).toEqual([]);
      });
    });
  });
});

describe('box geometry', () => {
  it('maps a box to the observed target it overlaps, and nothing when the overlap is weak', () => {
    const rect = toViewportRect({ top: 0.8, bottom: 0.9, left: 0.05, right: 0.95 }, { w: 400, h: 800 });
    expect(Object.values(rect).map(Math.round)).toEqual([20, 640, 360, 80]);
    const targets = { '1': { ...bookingActions[1] }, '4': { ...bookingActions[4], rect: { x: 20, y: 650, w: 360, h: 60 } } };
    expect(matchTarget(rect, targets)).toMatchObject({ index: '4' });
    expect(matchTarget({ x: 0, y: 0, w: 5, h: 5 }, targets).index).toBeUndefined();
    // A wide row box around a narrower button still points at it: each centre lies inside the other.
    expect(matchTarget({ x: 0, y: 640, w: 400, h: 80 }, { '4': { ...bookingActions[4], rect: { x: 150, y: 660, w: 100, h: 40 } } })).toMatchObject({ index: '4' });
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3);
  });

  it('reads malformed or inverted boxes as no box', () => {
    expect(readBox({ box: { top: 0.5, bottom: 0.4, left: 0, right: 1 }, confidence: 1 })).toBeUndefined();
    expect(readBox({ box: { top: 0, bottom: 1.2, left: 0, right: 1 } })).toBeUndefined();
    expect(readBox({ box: { top: 0, bottom: 1, left: 0, right: 1 } })).toMatchObject({ confidence: 0 });
  });
});

describe('screenshots as TypeSafe assets, with Box', () => {
  const input = { page: page(), goal: 'Pay', values: {}, history: [], checkCommitRisk: true };

  it('places the screenshot as an asset under `screenshot` and asks where the next click belongs', () => {
    const space = buildActionSpace(bookingActions);
    const { state, questions } = buildRequest(
      { ...input, screenshot: 'AAAA', imageTransport: 'assets', box: true },
      space,
    ) as any;
    expect(Array.isArray(state)).toBe(false);
    expect(state.screenshot.constructor.name).toBe('Image');
    expect(questions.next_click_box).toMatchObject({ type: 'box' });
    expect(questions).toHaveProperty('next_click_present');
    expect(questions).toHaveProperty('next_click_commit_risk');
  });

  it('turns the next-click box into the observed target it covers, and checks the chosen click', async () => {
    const { ask, requests } = scriptedJev([
      {
        operation: 'CLICK',
        click_target: '4',
        next_click_box: boxAt(PAY_RECT),
        next_click_present: 0.95,
        next_click_commit_risk: 0.97,
        target_visible: 0.99,
        target_box: boxAt(PAY_RECT),
      },
    ]);
    const decision = await decide(ask, { ...input, screenshot: 'AAAA', imageTransport: 'assets', box: true });
    expect(decision.nextClick).toMatchObject({ match: '4', present: 0.95, commitRisk: 0.97 });
    expect(Object.keys(requests[1].questions)).toEqual(['target_visible', 'target_box']);
    expect(decision.targetCheck!.visible).toBe(0.99);
    expect(decision.targetCheck!.overlap).toBeCloseTo(1);
  });

  it('asks the risk of the element the box covers by name, even when no click was chosen', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'BLOCKED', next_click_box: boxAt(PAY_RECT), next_click_present: 0.9, next_click_commit_risk: 0.02, risk_4: 0.95 },
    ]);
    const decision = await decide(ask, { ...input, screenshot: 'AAAA', imageTransport: 'assets', box: true, elementRisk: 'chosen' });
    expect(Object.keys(requests[1].questions)).toEqual(['risk_4']);
    expect(decision).toMatchObject({ nextClick: { match: '4', commitRisk: 0.02 }, elementRisks: { '4': 0.95 }, requests: 2 });
  });
});

describe('Box in the task loop', () => {
  const boxed = { goal: 'Pay', screenshots: 'always' as const, imageTransport: 'assets' as const, box: true };
  // As Jev's profile runs it: the click is also judged by name, and the higher risk wins.
  const judgedByName = { ...boxed, elementRisk: true, pageRisk: true };
  // Without the text fields, the Pay button is click target 3 (4 on the full booking page).
  // BLOCKED with empty text fields is needs_input; these pages have none.
  const noFields = (overrides: Partial<PageState> = {}) =>
    page({ actions: bookingActions.filter((action) => action.kind !== 'fill'), ...overrides });

  it('hands back when the screenshot points at a different control than Jev chose', async () => {
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '1', next_click_box: boxAt(PAY_RECT), next_click_present: 0.9, target_visible: 0.9 },
    ]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, boxed).run();
    expect(summary).toMatchObject({ status: 'uncertain' });
    expect(summary.reason).toContain('screenshot points at "Confirm booking and pay €412"');
    expect(acted).toEqual([]);
  });

  it('does not call a loose box that also covers the chosen control a disagreement', async () => {
    const both = { x: 0, y: 90, w: 393, h: 670 };
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '1', next_click_box: boxAt(both), next_click_present: 0.9 },
      // The covered-check follow-up is the second request.
      { operation: 'DONE', target_visible: 0.9 },
    ]);
    const { asTab, acted } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    await new BrowserTask(asTab, ask, boxed).run();
    expect(acted).toEqual([{ label: 'Open Full name' }]);
  });

  it('hands back when the chosen control looks covered on screen', async () => {
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '1', next_click_box: boxAt(NAME_RECT), next_click_present: 0.9, target_visible: 0.05 },
    ]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, boxed).run();
    expect(summary.reason).toContain('looks covered on screen');
  });

  it('rescues a BLOCKED step by clicking the observed element the box covers, still gated by commit risk', async () => {
    const blockedOnPay = {
      operation: 'BLOCKED',
      next_click_box: boxAt(PAY_RECT),
      next_click_present: 0.9,
      next_click_commit_risk: 0.95,
    };
    const { ask } = scriptedJev([blockedOnPay]);
    const { asTab, acted } = fakeTab([noFields()]);
    const summary = await new BrowserTask(asTab, ask, boxed).run();
    expect(summary).toMatchObject({ status: 'needs_confirmation' });
    expect(acted).toEqual([]);

    const safe = scriptedJev([{ ...blockedOnPay, next_click_commit_risk: 0.02 }, { operation: 'DONE' }]);
    const run = fakeTab([noFields({ fingerprint: 'a' }), noFields({ fingerprint: 'b' })]);
    await new BrowserTask(run.asTab, safe.ask, boxed).run();
    expect(run.acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
  });

  it('a rescue onto an element that is risky by name asks for confirmation even when the box rates its target safe', async () => {
    const { ask } = scriptedJev([
      {
        operation: 'BLOCKED',
        next_click_box: boxAt(PAY_RECT),
        next_click_present: 0.9,
        next_click_commit_risk: 0.02,
        risk_3: 0.95,
      },
    ]);
    const { asTab, acted } = fakeTab([noFields()]);
    const summary = await new BrowserTask(asTab, ask, judgedByName).run();
    expect(summary).toMatchObject({ status: 'needs_confirmation' });
    expect(acted).toEqual([]);
  });

  it('a rescue onto an element that is safe by name still clicks it', async () => {
    const blockedOnPay = {
      operation: 'BLOCKED',
      next_click_box: boxAt(PAY_RECT),
      next_click_present: 0.9,
      next_click_commit_risk: 0.02,
      risk_3: 0.02,
    };
    // The risk follow-up is the second request, so it reads the second step's script too.
    const { ask } = scriptedJev([blockedOnPay, { operation: 'DONE', risk_3: 0.02 }]);
    const { asTab, acted } = fakeTab([noFields({ fingerprint: 'a' }), noFields({ fingerprint: 'b' })]);
    await new BrowserTask(asTab, ask, judgedByName).run();
    expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
  });

  it('follows a confident screenshot box when the next-step head is unsure', async () => {
    const { ask } = scriptedJev([
      {
        operation: 'WAIT',
        confidence: 0.1,
        next_click_box: boxAt(PAY_RECT),
        next_click_present: 0.9,
        next_click_commit_risk: 0.02,
      },
      { operation: 'DONE' },
    ]);
    const { asTab, acted } = fakeTab([noFields({ fingerprint: 'a' }), noFields({ fingerprint: 'b' })]);
    await new BrowserTask(asTab, ask, boxed).run();
    expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
  });

  it('clicks a box the DOM never reported only with allowCoordinateClicks', async () => {
    const canvasOnly = { operation: 'BLOCKED', next_click_box: boxAt({ x: 100, y: 400, w: 100, h: 50 }), next_click_present: 0.9 };
    const options = { ...boxed, changeWaitMs: 0 };
    const off = scriptedJev([canvasOnly]);
    const offTab = fakeTab([noFields()]);
    expect((await new BrowserTask(offTab.asTab, off.ask, options).run()).status).toBe('blocked');
    expect(offTab.tab.clicksAt).toEqual([]);

    const on = scriptedJev([canvasOnly, { operation: 'DONE' }]);
    const onTab = fakeTab([noFields({ fingerprint: 'a' }), noFields({ fingerprint: 'b' })]);
    const summary = await new BrowserTask(onTab.asTab, on.ask, { ...options, allowCoordinateClicks: true }).run();
    expect(onTab.tab.clicksAt).toHaveLength(1);
    expect(onTab.tab.clicksAt[0].x).toBeCloseTo(150);
    expect(onTab.tab.clicksAt[0].y).toBeCloseTo(425);
    expect(summary.steps[0]).toMatchObject({ operation: 'CLICK_AT', element: 'canvas @ 150,425' });
  });

  it('a rejected DONE rescued onto a risky control still asks for confirmation', async () => {
    const { ask } = scriptedJev([
      { operation: 'DONE', done_check: 0.2, next_click_box: boxAt(PAY_RECT), next_click_present: 0.9, next_click_commit_risk: 0.95 },
    ]);
    const { asTab, acted } = fakeTab([noFields()]);
    const summary = await new BrowserTask(asTab, ask, { ...boxed, doneWhen: 'Paid' }).run();
    expect(summary).toMatchObject({ status: 'needs_confirmation' });
    expect(summary.reason).toContain('Confirm booking and pay €412');
    expect(acted).toEqual([]);
  });

  it('an unsure step rescued onto a risky control still asks for confirmation', async () => {
    const unsureOnPay = {
      operation: 'WAIT',
      confidence: 0.1,
      next_click_box: boxAt(PAY_RECT),
      next_click_present: 0.9,
      next_click_commit_risk: 0.95,
    };
    const { ask } = scriptedJev([unsureOnPay]);
    const { asTab, acted } = fakeTab([noFields({ fingerprint: 'a' }), noFields({ fingerprint: 'b' }), noFields({ fingerprint: 'c' })]);
    const task = new BrowserTask(asTab, ask, boxed);

    expect((await task.run()).status).toBe('needs_confirmation');
    expect(acted).toEqual([]);

    // One confirmation covers one click: the same rescue on the next step is gated again.
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    expect(summary.status).toBe('needs_confirmation');
  });

  it('a coordinate click on a risky box still asks for confirmation', async () => {
    const canvasPay = {
      operation: 'BLOCKED',
      next_click_box: boxAt({ x: 100, y: 400, w: 100, h: 50 }),
      next_click_present: 0.9,
      next_click_commit_risk: 0.95,
    };
    const { ask } = scriptedJev([canvasPay]);
    const { tab, asTab } = fakeTab([noFields()]);
    const summary = await new BrowserTask(asTab, ask, { ...boxed, allowCoordinateClicks: true }).run();
    expect(summary).toMatchObject({ status: 'needs_confirmation' });
    expect(tab.clicksAt).toEqual([]);
  });
});

describe('loop gotchas', () => {
  const operationIds = (request: any) => Object.keys(request.questions.operation.criteria);
  const withExpanded = page({
    actions: [...bookingActions, { id: 'm', kind: 'click', node: 9, role: 'button', label: 'Past 1 day', expanded: 'true' }],
  });

  it('offers Escape only while something is expanded, as a fixed key', async () => {
    const closed = scriptedJev([{ operation: 'DONE' }]);
    await new BrowserTask(fakeTab().asTab, closed.ask, { goal: 'x' }).run();
    expect(operationIds(closed.requests[0])).not.toContain('PRESS_ESCAPE');

    const open = scriptedJev([{ operation: 'PRESS_ESCAPE' }, { operation: 'DONE' }]);
    const { asTab, acted } = fakeTab([withExpanded, page({ fingerprint: 'closed' })]);
    await new BrowserTask(asTab, open.ask, { goal: 'x' }).run();
    expect(operationIds(open.requests[0])).toContain('PRESS_ESCAPE');
    expect(acted[0].label).toMatch(/^Press Escape/);
  });

  it('tells Jev about a covered target on the 2nd miss and hands back on the 3rd instead of retrying blind', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { tab, asTab, acted } = fakeTab();
    tab.unreachable = 10;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('could not be reached 3 times');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2])).toContain('another layer covers it');
    expect(acted).toEqual([]);
  });

  describe('a covered target', () => {
    const DATE = 'Sunday, November 1, 2026';
    const BANNER = 'could not be reached: it is covered by a layer listing "Decline", "Accept", "Manage settings"; close that layer first (one of those), then try again';
    const TODAYS_NOTE = 'could not be reached: another layer covers it; close that layer first';
    const control = (node: number, label: string): PageAction => ({ id: `n${node}`, kind: 'click', node, role: 'button', label });
    const cookieBanner = (extras: PageAction[] = []) =>
      page({
        actions: [control(21, DATE), control(114, 'Decline'), control(115, 'Accept'), control(116, 'Manage settings'), ...extras],
        text: 'Cookies on this site: we use them to remember your choices',
      });
    const noteOf = (summary: { steps: { not_executed?: string }[] }) => summary.steps.find((step) => step.not_executed)?.not_executed;

    it('names the controls of the covering layer on the 2nd miss, and a pick among them is acted on', async () => {
      const state = cookieBanner();
      const date = { operation: 'CLICK', click_target: clickTargetOf(state, DATE) };
      const { ask, requests } = scriptedJev([date, date, { operation: 'CLICK', click_target: clickTargetOf(state, 'Decline') }, { operation: 'DONE' }]);
      const { tab, asTab, acted } = fakeTab([state]);
      tab.unreachable = 2;
      tab.coverNodes = [114, 115, 116];
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pick the date', changeWaitMs: 0 }).run();
      expect(noteOf(summary)).toBe(BANNER);
      expect(requests[2].state.recent_actions.at(-1).not_executed).toBe(BANNER);
      expect(acted).toEqual([{ label: 'Decline' }]);
    });

    it('names them in the reason when the third miss hands the run back', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: clickTargetOf(cookieBanner(), DATE) }]);
      const { tab, asTab, acted } = fakeTab([cookieBanner()]);
      tab.unreachable = 10;
      tab.coverNodes = [114, 115, 116];
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pick the date' }).run();
      expect(summary.status).toBe('blocked');
      expect(summary.reason).toBe(`"${DATE}" could not be reached 3 times: it is covered by a layer listing "Decline", "Accept", "Manage settings"`);
      expect(acted).toEqual([]);
    });

    it('names at most 3 controls, in list order, each cut at 40 characters', async () => {
      const state = cookieBanner([control(117, 'Reject non-essential'), control(118, 'Close')]);
      state.actions[1] = control(114, 'Accept all cookies and share your data with our partners');
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: clickTargetOf(state, DATE) }]);
      const { tab, asTab } = fakeTab([state]);
      tab.unreachable = 10;
      tab.coverNodes = [118, 117, 116, 115, 114];
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pick the date' }).run();
      expect(noteOf(summary)).toContain('covered by a layer listing "Accept all cookies and share your data w", "Accept", "Manage settings";');
      expect(summary.reason).toContain('covered by a layer listing "Accept all cookies and share your data w", "Accept", "Manage settings"');
      expect(summary.reason).not.toContain('Reject');
    });

    it.each([
      ['no cover nodes', []],
      ['cover nodes no listed control has', [900, 901]],
    ])('keeps today\'s texts with %s', async (_name, coverNodes) => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: clickTargetOf(cookieBanner(), DATE) }]);
      const { tab, asTab } = fakeTab([cookieBanner()]);
      tab.unreachable = 10;
      tab.coverNodes = coverNodes;
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pick the date' }).run();
      expect(noteOf(summary)).toBe(TODAYS_NOTE);
      expect(summary.reason).toBe(`"${DATE}" could not be reached 3 times: something on the page covers it`);
    });

    it('keeps today\'s texts when the covering controls carry no label', async () => {
      const state = page({ actions: [control(21, DATE), control(114, ''), control(115, '  ')] });
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: clickTargetOf(state, DATE) }]);
      const { tab, asTab } = fakeTab([state]);
      tab.unreachable = 10;
      tab.coverNodes = [114, 115];
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pick the date' }).run();
      expect(noteOf(summary)).toBe(TODAYS_NOTE);
      expect(summary.reason).toBe(`"${DATE}" could not be reached 3 times: something on the page covers it`);
    });

    it('skips a cover node that is not a listed control, and never quotes page text', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: clickTargetOf(cookieBanner(), DATE) }]);
      const { tab, asTab } = fakeTab([cookieBanner()]);
      tab.unreachable = 10;
      tab.coverNodes = [114, 777, 116];
      const summary = await new BrowserTask(asTab, ask, { goal: 'Pick the date' }).run();
      expect(noteOf(summary)).toBe(BANNER.replace(', "Accept"', ''));
      expect(noteOf(summary)).not.toContain('Cookies on this site');
      expect(summary.reason).not.toContain('Cookies on this site');
    });
  });

  it('closes an open popup covering the target with Escape by itself, then retries the choice', async () => {
    const click = { operation: 'CLICK', click_target: '1' };
    const { ask } = scriptedJev([click, click, { operation: 'DONE' }]);
    const { tab, asTab, acted } = fakeTab([withExpanded, withExpanded, page({ fingerprint: 'closed' }), page({ fingerprint: 'after' })]);
    tab.unreachable = 1;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('done');
    expect(acted.map((a) => a.label)).toEqual(['dismissPopup', 'Open Full name']);
  });

  it('runs an Escape the page refused twice because it keeps changing on the third try', async () => {
    const { ask } = scriptedJev([{ operation: 'PRESS_ESCAPE' }, { operation: 'PRESS_ESCAPE' }, { operation: 'PRESS_ESCAPE' }, { operation: 'DONE' }]);
    const pages = ['a', 'b', 'c', 'd', 'e'].map((fingerprint) => page({ actions: withExpanded.actions, fingerprint }));
    const { tab, asTab, acted } = fakeTab(pages);
    tab.busy = true;
    const task = new BrowserTask(asTab, ask, { goal: 'x', changeWaitMs: 0 });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(tab.calls).toEqual([
      { kind: 'escape', forced: false },
      { kind: 'escape', forced: false },
      { kind: 'escape', forced: true },
    ]);
    expect(task.trace.filter((entry) => entry.decision.operation === 'PRESS_ESCAPE').map((entry) => entry.executed)).toEqual([false, false, true]);
    expect(acted).toHaveLength(1);
  });

  it('starts counting refusals again after any executed action', async () => {
    const scrolling = (fingerprint: string) =>
      page({ actions: [...bookingActions, { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 }], fingerprint });
    const scroll = { operation: 'SCROLL_DOWN' };
    const { ask } = scriptedJev([scroll, scroll, { operation: 'CLICK', click_target: '1' }, scroll, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(scrolling));
    tab.busy = true;
    const summary = await new BrowserTask(asTab, ask, { goal: 'x', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    // Two refusals would force the next scroll, but the executed click in between started the count over.
    expect(tab.calls).toEqual([
      { kind: 'scroll', forced: false },
      { kind: 'scroll', forced: false },
      { kind: 'click', forced: false },
      { kind: 'scroll', forced: false },
    ]);
  });

  it('waits on an unsure WAIT instead of handing back', async () => {
    const { ask } = scriptedJev([{ operation: 'WAIT', confidence: 0.2 }, { operation: 'DONE' }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Load', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
  });

  it('presses an unsure Escape instead of handing back', async () => {
    const { ask } = scriptedJev([{ operation: 'PRESS_ESCAPE', confidence: 0.29 }, { operation: 'DONE' }]);
    const { asTab, acted } = fakeTab([withExpanded, page({ fingerprint: 'closed' })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'x', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(acted[0].label).toMatch(/^Press Escape/);
  });

  it('stops an action that only toggles the page back and forth', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const flips = ['x', 'a', 'b', 'a', 'b', 'a', 'b'].map((fingerprint) => page({ fingerprint }));
    const { asTab, acted } = fakeTab(flips);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Pick a range' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('toggles the page back and forth');
    expect(acted).toHaveLength(4);
  });

  it('accepts steady done evidence (3 decisions ≥ 0.75) but not a single spike', async () => {
    const steady = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.8 }]);
    const pages = Array.from({ length: 10 }, (_, i) => page({ fingerprint: String(i) }));
    const summary = await new BrowserTask(fakeTab(pages).asTab, steady.ask, { goal: 'x', doneWhen: 'y' }).run();
    expect(summary).toMatchObject({ status: 'done', steps: [{}, {}] });

    const spike = scriptedJev([
      { operation: 'CLICK', click_target: '1', done_check: 0.86 },
      { operation: 'CLICK', click_target: '1', done_check: 0.1 },
      { operation: 'BLOCKED' },
    ]);
    const once = await new BrowserTask(fakeTab(pages).asTab, spike.ask, { goal: 'x', doneWhen: 'y', changeWaitMs: 0 }).run();
    expect(once.status).not.toBe('done');
  });

  it('hands back when Jev stays unsure for 6 actions in a row', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.35 }]);
    const pages = Array.from({ length: 10 }, (_, i) => page({ fingerprint: String(i) }));
    const summary = await new BrowserTask(fakeTab(pages).asTab, ask, { goal: 'Find it' }).run();
    expect(summary.status).toBe('uncertain');
    expect(summary.reason).toContain('unsure for 6 actions');
    expect(summary.steps).toHaveLength(6);
  });

  it('does not count an unsure WAIT or Escape toward the 6 unsure actions', async () => {
    const unsureClick = { operation: 'CLICK', click_target: '1', confidence: 0.35 };
    const { ask } = scriptedJev([
      unsureClick,
      unsureClick,
      { operation: 'WAIT', confidence: 0.29 },
      unsureClick,
      unsureClick,
      { operation: 'PRESS_ESCAPE', confidence: 0.29 },
      unsureClick,
      unsureClick,
    ]);
    // Escape is offered only on a page with something expanded: the one seen at the sixth decision.
    const pages = Array.from({ length: 12 }, (_, i) => page({ ...(i === 5 ? withExpanded : {}), fingerprint: String(i) }));
    const { asTab } = fakeTab(pages);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Find it', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('uncertain');
    expect(summary.reason).toContain('unsure for 6 actions');
    // Six unsure clicks tripped it, with the WAIT and the Escape between them.
    expect(summary.steps.filter((step) => step.operation === 'CLICK')).toHaveLength(6);
    expect(summary.steps).toHaveLength(8);
  });

  it('stops the same click repeated 6 times in 7 actions even when the page changes each time', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const pages = Array.from({ length: 12 }, (_, i) => page({ fingerprint: String(i) }));
    const summary = await new BrowserTask(fakeTab(pages).asTab, ask, { goal: 'Open it' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('6 times in 7 actions');
  });

  it('tells Jev a rejected DONE was premature, and hands the supplied values to the page reader', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.1 }, { operation: 'DONE', done_check: 0.9 }]);
    const { tab, asTab } = fakeTab();
    await new BrowserTask(asTab, ask, { goal: 'x', doneWhen: 'Results listed', values: { user: 'u-Gy8s1' } }).run();
    expect(JSON.stringify(requests[1])).toContain('rejected: \\"Results listed\\" is not visible yet');
    expect(tab.wanted).toEqual(['u-Gy8s1']);
  });

  describe('BLOCKED on a page that may already meet the goal', () => {
    // No text fields, so BLOCKED is not needs_input.
    const noFields = page({ actions: bookingActions.filter((action) => action.kind !== 'fill') });
    const options = { goal: 'x', doneWhen: 'It is done', changeWaitMs: 0 };

    it('ends as done when Jev is blocked on a page whose completion check passes', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', done_check: 0.6 }]);
      const summary = await new BrowserTask(fakeTab([noFields]).asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'done', reason: 'Completion condition verified: It is done' });
      expect(requests).toHaveLength(1);
    });

    it('stays blocked when the completion check does not pass', async () => {
      const { ask } = scriptedJev([{ operation: 'BLOCKED', done_check: 0.3 }]);
      const summary = await new BrowserTask(fakeTab([noFields]).asTab, ask, options).run();
      expect(summary.status).toBe('blocked');
    });

    it('stays blocked without a completion condition', async () => {
      const { ask } = scriptedJev([{ operation: 'BLOCKED', done_check: 0.9 }]);
      const summary = await new BrowserTask(fakeTab([noFields]).asTab, ask, { goal: 'x', changeWaitMs: 0 }).run();
      expect(summary.status).toBe('blocked');
    });
  });

  describe('an unsure step on a page whose completion check passes', () => {
    const options = { goal: 'x', doneWhen: 'It is done', changeWaitMs: 0, screenshots: 'fallback' as const };
    // The text-only look is unsure and sees no goal; the screenshot second look is unsure too, with the given done check.
    const unsureClick = (doneCheck: number) => [
      { operation: 'CLICK', click_target: '1', confidence: 0.2, done_check: 0.1 },
      { operation: 'CLICK', click_target: '1', confidence: 0.2, done_check: doneCheck },
    ];

    it('ends as done when the screenshot look is unsure but its completion check is steady-high', async () => {
      const { ask, requests } = scriptedJev(unsureClick(0.8));
      const { tab, asTab, acted } = fakeTab();
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'done', reason: 'Completion condition verified: It is done' });
      expect(requests).toHaveLength(2);
      expect(tab.screenshots).toBe(1);
      expect(acted).toEqual([]);
    });

    it('stays uncertain below the steady-evidence bar', async () => {
      const { ask } = scriptedJev(unsureClick(0.6));
      const { asTab, acted } = fakeTab();
      expect((await new BrowserTask(asTab, ask, options).run()).status).toBe('uncertain');
      expect(acted).toEqual([]);
    });

    it('stays uncertain when no screenshot backed the decision', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.2, done_check: 0.8 }]);
      const { tab, asTab } = fakeTab();
      const summary = await new BrowserTask(asTab, ask, { ...options, screenshots: 'off' }).run();
      expect(summary.status).toBe('uncertain');
      expect(tab.screenshots).toBe(0);
    });

    it('stays uncertain without a completion condition', async () => {
      const { ask } = scriptedJev(unsureClick(0.8));
      const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'x', changeWaitMs: 0, screenshots: 'fallback' }).run();
      expect(summary.status).toBe('uncertain');
    });
  });

  describe('BLOCKED while the click head favours a collapsed control', () => {
    const options = { goal: 'Find the prompt', elementRisk: true, changeWaitMs: 0 };
    const more = clickTargetOf(foldedPage('a', 'false'), 'Show more details');
    const blockedOnMore = { operation: 'BLOCKED', click_target: more };

    it('opens a collapsed control the click head favours instead of handing back blocked', async () => {
      // The risk follow-up is the second request, so it reads the second step's script too.
      const { ask } = scriptedJev([{ ...blockedOnMore, [`risk_${more}`]: 0.02 }, { [`risk_${more}`]: 0.02 }, { operation: 'DONE' }]);
      const { asTab, acted } = fakeTab([foldedPage('a', 'false'), foldedPage('b', 'true')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([{ label: 'Show more details' }]);
      expect(summary.status).toBe('done');
    });

    it('opens it only once per element', async () => {
      const { ask } = scriptedJev([{ ...blockedOnMore, [`risk_${more}`]: 0.02 }]);
      const { asTab, acted } = fakeTab([foldedPage('a', 'false'), foldedPage('b', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([{ label: 'Show more details' }]);
      expect(summary.status).toBe('blocked');
    });

    it('does not open a control that is not collapsed', async () => {
      const { ask } = scriptedJev([{ ...blockedOnMore, [`risk_${more}`]: 0.02 }]);
      const { asTab, acted } = fakeTab([foldedPage('a'), foldedPage('b')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([]);
      expect(summary.status).toBe('blocked');
    });

    it('a collapsed control judged risky by name asks for confirmation', async () => {
      const { ask } = scriptedJev([{ ...blockedOnMore, [`risk_${more}`]: 0.9 }]);
      const { asTab, acted } = fakeTab([foldedPage('a', 'false'), foldedPage('b', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'needs_confirmation' });
      expect(summary.reason).toContain('Show more details');
      expect(acted).toEqual([]);
    });

    it('a collapsed control that is safe by name opens even on a page judged irreversible', async () => {
      const { ask } = scriptedJev([{ ...blockedOnMore, commit_risk: 0.9, [`risk_${more}`]: 0.02 }]);
      const { asTab, acted } = fakeTab([foldedPage('a', 'false'), foldedPage('b', 'false')]);
      const summary = await new BrowserTask(asTab, ask, { ...options, pageRisk: true }).run();
      expect(summary.status).not.toBe('needs_confirmation');
      expect(acted).toEqual([{ label: 'Show more details' }]);
    });

    it('a collapsed control judged irreversible by name still asks for confirmation when the page-level question is on', async () => {
      const { ask } = scriptedJev([{ ...blockedOnMore, commit_risk: 0.1, [`risk_${more}`]: 0.9 }]);
      const { asTab, acted } = fakeTab([foldedPage('a', 'false'), foldedPage('b', 'false')]);
      const summary = await new BrowserTask(asTab, ask, { ...options, pageRisk: true }).run();
      expect(summary).toMatchObject({ status: 'needs_confirmation' });
      expect(acted).toEqual([]);
    });

    it('still opens a confirmed control: only a click that ran counts as opened', async () => {
      const { ask } = scriptedJev([{ ...blockedOnMore, [`risk_${more}`]: 0.9 }]);
      const { asTab, acted } = fakeTab([foldedPage('a', 'false'), foldedPage('b', 'false'), foldedPage('c', 'false')]);
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');
      task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
      await task.run();
      expect(acted).toEqual([{ label: 'Show more details' }]);
    });
  });

  describe('BLOCKED with the target behind a collapsed overflow control', () => {
    const options = { goal: 'Open the source observation', elementRisk: true, changeWaitMs: 0 };
    const menu = clickTargetOf(overflowPage('a', []), 'Open menu');

    it.each(['Show 1 more session details', 'More actions'])('opens "%s" even though the click head favours another control', async (label) => {
      const chip = overflowChip(32, label);
      const closed = overflowPage('a', [chip]);
      const opened = overflowPage('b', [overflowChip(32, label, 'true'), SOURCE_LINK]);
      const link = clickTargetOf(opened, 'View source observation');
      const chipTarget = clickTargetOf(closed, label);
      const { ask } = scriptedJev([
        { operation: 'BLOCKED', click_target: menu, [`risk_${chipTarget}`]: 0.02 },
        { [`risk_${chipTarget}`]: 0.02 },
        { operation: 'CLICK', click_target: link },
        { [`risk_${link}`]: 0.02 },
        { operation: 'DONE' },
      ]);
      const { asTab, acted } = fakeTab([closed, opened, overflowPage('c', [])]);
      const task = new BrowserTask(asTab, ask, options);
      const summary = await task.run();
      expect(acted).toEqual([{ label }, { label: 'View source observation' }]);
      expect(summary.status).toBe('done');
      expect(task.trace[0]).toMatchObject({ executed: true, decision: { via: 'disclosure', action: label } });
    });

    it('opens an overflow control only once, then hands back blocked', async () => {
      const chip = overflowChip(32, 'More actions');
      const chipTarget = clickTargetOf(overflowPage('a', [chip]), 'More actions');
      const { ask } = scriptedJev([{ operation: 'BLOCKED', click_target: menu, [`risk_${chipTarget}`]: 0.02 }]);
      const { asTab, acted } = fakeTab([overflowPage('a', [chip]), overflowPage('b', [chip])]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([{ label: 'More actions' }]);
      expect(summary.status).toBe('blocked');
    });

    it('moves on to the next overflow control once the first has been opened', async () => {
      const chips = [overflowChip(32, '+2'), overflowChip(33, 'More options')];
      const risks = Object.fromEntries(chips.map((chip) => [`risk_${clickTargetOf(overflowPage('a', chips), chip.label)}`, 0.02]));
      const { ask } = scriptedJev([{ operation: 'BLOCKED', click_target: menu, ...risks }]);
      const { asTab, acted } = fakeTab(['a', 'b', 'c'].map((fingerprint) => overflowPage(fingerprint, chips)));
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([{ label: '+2' }, { label: 'More options' }]);
      expect(summary.status).toBe('blocked');
    });

    it('leaves a collapsed control alone when its label is no overflow and the click head does not favour it', async () => {
      const closed = overflowPage('a', [overflowChip(32, 'Filters')]);
      const { ask } = scriptedJev([{ operation: 'BLOCKED', click_target: menu }]);
      const { asTab, acted } = fakeTab([closed, overflowPage('b', [overflowChip(32, 'Filters')])]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([]);
      expect(summary.status).toBe('blocked');
    });

    it('asks for confirmation instead of opening an overflow control judged risky by name', async () => {
      const closed = overflowPage('a', [overflowChip(32, 'More actions')]);
      const chipTarget = clickTargetOf(closed, 'More actions');
      const { ask } = scriptedJev([{ operation: 'BLOCKED', click_target: menu, [`risk_${chipTarget}`]: 0.9 }]);
      const { asTab, acted } = fakeTab([closed, overflowPage('b', [overflowChip(32, 'More actions')])]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'needs_confirmation' });
      expect(summary.reason).toContain('More actions');
      expect(acted).toEqual([]);
    });
  });

  describe('an unsure step with the target behind a collapsed overflow control', () => {
    const options = { goal: 'Open the source observation', elementRisk: true, changeWaitMs: 0 };
    const COUNT = 'Show 1 more session details';
    const closed = (fingerprint = 'a') => overflowPage(fingerprint, [overflowChip(32, COUNT), overflowChip(33, 'More actions')]);
    const opened = overflowPage('b', [overflowChip(32, COUNT, 'true'), overflowChip(33, 'More actions'), SOURCE_LINK]);
    const countTarget = clickTargetOf(closed(), COUNT);
    const moreTarget = clickTargetOf(closed(), 'More actions');
    const risks = (risk: number) => ({ [`risk_${countTarget}`]: risk, [`risk_${moreTarget}`]: risk });
    // A click at 0.22 on a generic menu: under the 0.3 bar, so it would be handed back as uncertain.
    const unsure = { operation: 'CLICK', confidence: 0.22, click_target: clickTargetOf(closed(), 'Open menu') };

    it('opens the count chip instead of handing back uncertain, judged by name', async () => {
      const link = clickTargetOf(opened, 'View source observation');
      const { ask, requests } = scriptedJev([
        { ...unsure, ...risks(0.02) },
        risks(0.02),
        { operation: 'CLICK', click_target: link },
        { [`risk_${link}`]: 0.02 },
        { operation: 'DONE' },
      ]);
      const { asTab, acted } = fakeTab([closed(), opened, overflowPage('c', [])]);
      const task = new BrowserTask(asTab, ask, options);
      const summary = await task.run();
      expect(acted).toEqual([{ label: COUNT }, { label: 'View source observation' }]);
      expect(summary.status).toBe('done');
      expect(task.trace[0]).toMatchObject({ executed: true, decision: { via: 'disclosure', action: COUNT } });
      expect(Object.keys(requests[1].questions)).toContain(`risk_${countTarget}`);
    });

    it('opens the count chip first when the click head ranks "More actions" above it', async () => {
      const page = overflowPage('a', [overflowChip(32, 'More actions'), overflowChip(33, COUNT)]);
      const [more, count] = ['More actions', COUNT].map((label) => clickTargetOf(page, label));
      const head = { '1': 0.5, '2': 0.45, [more]: 0.04, [count]: 0.01 };
      const link = clickTargetOf(opened, 'View source observation');
      const script = scriptedJev([
        { operation: 'BLOCKED', [`risk_${more}`]: 0.02, [`risk_${count}`]: 0.02 },
        { [`risk_${more}`]: 0.02, [`risk_${count}`]: 0.02 },
        { operation: 'CLICK', click_target: link },
        { operation: 'DONE' },
      ]);
      const { asTab, acted } = fakeTab([page, opened, overflowPage('c', [])]);
      const summary = await new BrowserTask(asTab, withClickHead(script.ask, head), options).run();
      expect(acted).toEqual([{ label: COUNT }, { label: 'View source observation' }]);
      expect(summary.status).toBe('done');
    });

    it('still hands back uncertain once every overflow control has been opened', async () => {
      const lone = (fingerprint: string) => overflowPage(fingerprint, [overflowChip(32, COUNT)]);
      const { ask } = scriptedJev([{ ...unsure, [`risk_${clickTargetOf(lone('a'), COUNT)}`]: 0.02 }]);
      const { asTab, acted } = fakeTab([lone('a'), lone('b')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([{ label: COUNT }]);
      expect(summary).toMatchObject({ status: 'uncertain', reason: expect.stringContaining('Open menu') });
    });

    it('still hands back uncertain when the page has no overflow control', async () => {
      const { ask } = scriptedJev([unsure]);
      const { asTab, acted } = fakeTab([overflowPage('a', [overflowChip(32, 'Filters')])]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([]);
      expect(summary.status).toBe('uncertain');
    });

    it('ends done without opening anything when the screenshot-backed check already accepts the goal', async () => {
      const { ask } = scriptedJev([{ ...unsure, ...risks(0.02), done_check: 0.8 }]);
      const { asTab, acted } = fakeTab([closed(), closed('b')]);
      const summary = await new BrowserTask(asTab, ask, { ...options, doneWhen: 'The user is open', screenshots: 'always' }).run();
      expect(summary.status).toBe('done');
      expect(acted).toEqual([]);
    });

    it('asks for confirmation instead of opening a count chip judged risky by name', async () => {
      const { ask } = scriptedJev([{ ...unsure, ...risks(0.9) }]);
      const { asTab, acted } = fakeTab([closed(), closed('b')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'needs_confirmation' });
      expect(summary.reason).toContain(COUNT);
      expect(acted).toEqual([]);
    });
  });

  describe('the rescues and the signed-in user\'s account menu', () => {
    const options = { goal: 'Open the source observation', elementRisk: true, changeWaitMs: 0 };
    const COUNT = 'Show 1 more session details';
    const MENU: PageAction = { id: 'menu', kind: 'click', node: 30, role: 'button', label: 'Open menu' };
    // A phone's session page: the global account menu and the session's own "+1" chip are both collapsed.
    const phone = (fingerprint: string, countExpanded = 'false', extras: PageAction[] = []) =>
      page({ actions: [MENU, overflowChip(31, 'Account menu'), overflowChip(32, COUNT, countExpanded), ...extras], fingerprint });
    const closed = phone('a');
    const opened = phone('b', 'true', [SOURCE_LINK]);
    const [menu, account, count] = ['Open menu', 'Account menu', COUNT].map((label) => clickTargetOf(closed, label));
    // The click head leans toward the account menu, as it did in the Langfuse runs (0.43 to 0.48).
    const leansToAccount = { [menu]: 0.4, [account]: 0.45, [count]: 0.15 };
    const link = clickTargetOf(opened, 'View source observation');

    it('opens the "+1" chip, not the account menu the click head favours, when BLOCKED', async () => {
      const script = scriptedJev([{ operation: 'BLOCKED' }, {}, { operation: 'CLICK', click_target: link }, {}, { operation: 'DONE' }]);
      const { asTab, acted } = fakeTab([closed, opened, phone('c')]);
      const task = new BrowserTask(asTab, withClickHead(script.ask, leansToAccount), options);
      const summary = await task.run();
      expect(acted).toEqual([{ label: COUNT }, { label: 'View source observation' }]);
      expect(summary.status).toBe('done');
      expect(task.trace[0]).toMatchObject({ executed: true, decision: { via: 'disclosure', action: COUNT } });
      // No risk question is spent on a control the rescue would not open.
      const asked = Object.keys(script.requests[1].questions);
      expect(asked).toContain(`risk_${count}`);
      expect(asked).not.toContain(`risk_${account}`);
    });

    it('opens the "+1" chip only once, and never falls back to the account menu', async () => {
      const script = scriptedJev([{ operation: 'BLOCKED' }]);
      const { asTab, acted } = fakeTab([closed, phone('b')]);
      const summary = await new BrowserTask(asTab, withClickHead(script.ask, leansToAccount), options).run();
      expect(acted).toEqual([{ label: COUNT }]);
      expect(summary.status).toBe('blocked');
    });

    it('opens nothing when the account menu is the only collapsed control', async () => {
      const alone = (fingerprint: string) => page({ actions: [MENU, overflowChip(31, 'Account menu')], fingerprint });
      const [aloneMenu, aloneAccount] = ['Open menu', 'Account menu'].map((label) => clickTargetOf(alone('a'), label));
      const script = scriptedJev([{ operation: 'BLOCKED' }]);
      const head = { [aloneMenu]: 0.4, [aloneAccount]: 0.6 };
      const { asTab, acted } = fakeTab([alone('a'), alone('b')]);
      const summary = await new BrowserTask(asTab, withClickHead(script.ask, head), options).run();
      expect(acted).toEqual([]);
      expect(summary.status).toBe('blocked');
    });

    it('an unsure step opens the "+1" chip, never the account menu', async () => {
      const unsure = { operation: 'CLICK', confidence: 0.22, click_target: account };
      const script = scriptedJev([unsure, {}, { operation: 'CLICK', click_target: link }, {}, { operation: 'DONE' }]);
      const { asTab, acted } = fakeTab([closed, opened, phone('c')]);
      const summary = await new BrowserTask(asTab, withClickHead(script.ask, leansToAccount), options).run();
      expect(acted).toEqual([{ label: COUNT }, { label: 'View source observation' }]);
      expect(summary.status).toBe('done');
    });

    it('an unsure step with the account menu as the only collapsed control hands back uncertain', async () => {
      const alone = page({ actions: [MENU, overflowChip(31, 'Account menu')], fingerprint: 'a' });
      const { ask } = scriptedJev([{ operation: 'CLICK', confidence: 0.22, click_target: clickTargetOf(alone, 'Account menu') }]);
      const { asTab, acted } = fakeTab([alone, { ...alone, fingerprint: 'b' }]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(acted).toEqual([]);
      expect(summary.status).toBe('uncertain');
    });

    it('still acts on the account menu when the model itself chooses it', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: account }, {}, { operation: 'DONE' }]);
      const { asTab, acted } = fakeTab([closed, phone('b')]);
      const task = new BrowserTask(asTab, ask, { ...options, goal: 'Open my profile settings' });
      const summary = await task.run();
      expect(acted).toEqual([{ label: 'Account menu' }]);
      expect(summary.status).toBe('done');
      expect(task.trace[0]).toMatchObject({ executed: true, decision: { action: 'Account menu' } });
      expect(task.trace[0].decision).not.toHaveProperty('via');
    });
  });

  it('keeps a click that progresses each time, like paging or a counter', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const pages = ['x', 'a', 'b', 'c', 'd', 'e'].map((fingerprint) => page({ fingerprint }));
    const summary = await new BrowserTask(fakeTab(pages).asTab, ask, { goal: 'Page through', maxSteps: 5 }).run();
    expect(summary.status).toBe('step_budget');
  });

  describe('a menu the run opened, before it says done', () => {
    const options = { goal: 'Add the label', doneWhen: 'The issue shows the label', changeWaitMs: 0 };
    // A label picker that applies the choice only when its menu closes: the text already shows it while the menu is open.
    const trigger = (expanded: string): PageAction => ({ id: 'labels', kind: 'click', node: 50, role: 'combobox', label: 'Labels', expanded });
    const helpWanted: PageAction = { id: 'help', kind: 'click', node: 51, role: 'option', label: 'help wanted' };
    const comments: PageAction = { id: 'comments', kind: 'click', node: 52, role: 'link', label: 'Comments' };
    const issue = (fingerprint: string, expanded: string, menuListed = expanded === 'true') =>
      page({ actions: [trigger(expanded), ...(menuListed ? [helpWanted] : []), comments], fingerprint });
    const closed = issue('a', 'false');
    const open = issue('b', 'true');
    const labels = clickTargetOf(closed, 'Labels');
    const option = clickTargetOf(open, 'help wanted');
    const openLabels = { operation: 'CLICK', click_target: labels };
    const pickOption = { operation: 'CLICK', click_target: option };
    const closedByRun = { operation: 'PRESS_ESCAPE', element: 'closed the menu this run opened before finishing', page_changed: true };

    it('closes it once and judges done again on the closed page, on the evident path', async () => {
      const evident = { operation: 'CLICK', click_target: '1', done_check: 0.93 };
      const { ask, requests } = scriptedJev([openLabels, pickOption, evident, evident]);
      const { asTab, acted } = fakeTab([closed, open, issue('c', 'true'), issue('d', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted).toEqual([{ label: 'Labels' }, { label: 'help wanted' }, { label: 'dismissPopup' }]);
      expect(summary.steps.map((step) => step.operation)).toEqual(['CLICK', 'CLICK', 'PRESS_ESCAPE']);
      expect(summary.steps[2]).toMatchObject(closedByRun);
      expect(requests).toHaveLength(4);
    });

    it('does the same when the model says DONE', async () => {
      const done = { operation: 'DONE', done_check: 0.6 };
      const { ask, requests } = scriptedJev([openLabels, pickOption, done, done]);
      const { asTab, acted } = fakeTab([closed, open, issue('c', 'true'), issue('d', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted.filter((a) => a.label === 'dismissPopup')).toHaveLength(1);
      expect(summary.steps[2]).toMatchObject(closedByRun);
      expect(requests).toHaveLength(4);
    });

    it('does the same when BLOCKED on a page that already meets the goal', async () => {
      const blocked = { operation: 'BLOCKED', done_check: 0.6 };
      const { ask } = scriptedJev([openLabels, pickOption, blocked, blocked]);
      const { asTab, acted } = fakeTab([closed, open, issue('c', 'true'), issue('d', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted.filter((a) => a.label === 'dismissPopup')).toHaveLength(1);
    });

    it('does the same for an unsure step on a page the screenshot-backed check accepts', async () => {
      const unsure = { operation: 'CLICK', click_target: '1', confidence: 0.2, done_check: 0.8 };
      const { ask } = scriptedJev([openLabels, pickOption, unsure, unsure]);
      const { asTab, acted } = fakeTab([closed, open, issue('c', 'true'), issue('d', 'false')]);
      const summary = await new BrowserTask(asTab, ask, { ...options, screenshots: 'always' }).run();
      expect(summary.status).toBe('done');
      expect(acted.filter((a) => a.label === 'dismissPopup')).toHaveLength(1);
    });

    it('does the same when a loop guard hands back and the last look finds the goal met', async () => {
      // Three picks that change nothing trip the guard; its last look reads the goal as met while the menu is still open.
      const lookFindsGoal = { ...pickOption, done_check: 0.8 };
      const evident = { operation: 'CLICK', click_target: '1', done_check: 0.93 };
      const { ask, requests } = scriptedJev([openLabels, pickOption, pickOption, pickOption, lookFindsGoal, evident]);
      const { asTab, acted } = fakeTab([closed, open, open, open, open, issue('d', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted.filter((a) => a.label === 'dismissPopup')).toHaveLength(1);
      expect(summary.steps.at(-1)).toMatchObject(closedByRun);
      expect(requests).toHaveLength(6);
    });

    it('leaves a menu the page had open alone', async () => {
      const opened = issue('a', 'true');
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: clickTargetOf(opened, 'help wanted') }, { operation: 'DONE', done_check: 0.6 }]);
      const { asTab, acted } = fakeTab([opened, issue('b', 'true')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted).toEqual([{ label: 'help wanted' }]);
    });

    it('leaves a fold the disclosure rescue opened to read alone', async () => {
      const chip = 'Show 1 more session details';
      const folded = overflowPage('a', [overflowChip(32, chip)]);
      const unfolded = overflowPage('b', [overflowChip(32, chip, 'true'), SOURCE_LINK]);
      const chipTarget = clickTargetOf(folded, chip);
      const { ask } = scriptedJev([
        { operation: 'BLOCKED', click_target: clickTargetOf(folded, 'Open menu'), [`risk_${chipTarget}`]: 0.02 },
        { [`risk_${chipTarget}`]: 0.02 },
        { operation: 'DONE', done_check: 0.6 },
      ]);
      const { asTab, acted } = fakeTab([folded, unfolded]);
      const summary = await new BrowserTask(asTab, ask, { ...options, elementRisk: true }).run();
      expect(summary.status).toBe('done');
      expect(acted).toEqual([{ label: chip }]);
    });

    it('sends an unsaved edit back before it closes the menu: not done yet, so nothing is closed for it', async () => {
      const tick = (checked: string): PageAction => ({ id: 'tick', kind: 'click', node: 51, role: 'checkbox', label: 'help wanted', checked });
      const save: PageAction = { id: 'save', kind: 'click', node: 52, role: 'button', label: 'Save' };
      const form = (fingerprint: string, expanded: string, ticked = 'false') =>
        page({ actions: [trigger(expanded), ...(expanded === 'true' ? [tick(ticked)] : []), save], fingerprint });
      const [start, opened, ticked] = [form('a', 'false'), form('b', 'true'), form('c', 'true', 'true')];
      const done = { operation: 'DONE', done_check: 0.6 };
      const { ask } = scriptedJev([
        { operation: 'CLICK', click_target: clickTargetOf(start, 'Labels') },
        { operation: 'CLICK', click_target: clickTargetOf(opened, 'help wanted') },
        done,
        { operation: 'CLICK', click_target: clickTargetOf(ticked, 'Save') },
        done,
        done,
      ]);
      // The pages after the send-back and after Save still show the menu open and the box ticked; the last one is closed.
      const { asTab, acted } = fakeTab([start, opened, ticked, form('d', 'true', 'true'), form('e', 'true', 'true'), form('f', 'false', 'true')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(summary.steps.map((step) => step.operation)).toEqual(['CLICK', 'CLICK', 'DONE', 'CLICK', 'PRESS_ESCAPE']);
      expect(summary.steps[2].not_executed).toContain('the last step changed a field and nothing was saved');
      expect(acted).toEqual([{ label: 'Labels' }, { label: 'help wanted' }, { label: 'Save' }, { label: 'dismissPopup' }]);
    });

    it('closes it only once: a goal whose evidence is the open menu still finishes', async () => {
      const done = { operation: 'DONE', done_check: 0.6 };
      const reopen = { operation: 'CLICK', click_target: clickTargetOf(issue('d', 'false'), 'Labels') };
      const { ask, requests } = scriptedJev([openLabels, pickOption, done, reopen, done]);
      const { asTab, acted } = fakeTab([closed, open, issue('c', 'true'), issue('d', 'false'), issue('e', 'true')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted).toEqual([{ label: 'Labels' }, { label: 'help wanted' }, { label: 'dismissPopup' }, { label: 'Labels' }]);
      expect(requests).toHaveLength(5);
    });

    it('leaves a menu alone that a later click of the run closed', async () => {
      const { ask } = scriptedJev([openLabels, pickOption, { operation: 'DONE', done_check: 0.6 }]);
      const { asTab, acted } = fakeTab([closed, open, issue('c', 'false')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('done');
      expect(acted).toEqual([{ label: 'Labels' }, { label: 'help wanted' }]);
    });
  });

  describe('a risky submit while the menu the run opened still lists a supplied value', () => {
    const options = { goal: 'Open an issue labelled with the text in label', values: { label: 'bug' }, changeWaitMs: 0 };
    const labelsTrigger = (expanded: string): PageAction => ({ id: 'labels', kind: 'click', node: 50, role: 'combobox', label: 'Labels', expanded });
    const bugOption = (extra: Partial<PageAction> = {}): PageAction => ({ id: 'bug', kind: 'click', node: 51, role: 'option', label: 'bug', ...extra });
    const create: PageAction = { id: 'create', kind: 'click', node: 52, role: 'button', label: 'Create issue' };
    const form = (fingerprint: string, expanded: string, menuListed = expanded === 'true') =>
      page({ actions: [labelsTrigger(expanded), ...(menuListed ? [bugOption()] : []), create], fingerprint });
    const closed = form('a', 'false');
    const open = (fingerprint: string) => form(fingerprint, 'true');
    const labels = { operation: 'CLICK', click_target: clickTargetOf(closed, 'Labels') };
    // The menu's rows take element numbers, so the same button has another number once the menu is open.
    const submit = { operation: 'CLICK', click_target: clickTargetOf(open('x'), 'Create issue'), commit_risk: 0.8 };
    const submitClosed = { ...submit, click_target: clickTargetOf(closed, 'Create issue') };
    const pickBug = { operation: 'CLICK', click_target: clickTargetOf(open('x'), 'bug') };
    const NOTE = 'not accepted: the menu you opened lists "bug" (label) and it isn\'t picked yet; pick it first, or answer BLOCKED';

    it('feeds back once to pick the value first, then lets the submit go to the hand-back as usual', async () => {
      const { ask } = scriptedJev([labels, submit, pickBug, submit]);
      const { asTab, acted } = fakeTab([closed, open('b'), open('c'), open('d'), open('e')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary).toMatchObject({ status: 'needs_confirmation' });
      expect(summary.reason).toContain('Create issue');
      expect(acted).toEqual([{ label: 'Labels' }, { label: 'bug' }]);
      expect(summary.steps.map((step) => [step.operation, step.element, step.not_executed])).toEqual([
        ['CLICK', 'Labels', undefined],
        ['CLICK', '', NOTE],
        ['CLICK', 'bug', undefined],
      ]);
    });

    it('does not interrupt a confirmed submit that comes after the pick', async () => {
      const { ask } = scriptedJev([labels, submit, pickBug, submit]);
      const { asTab, acted } = fakeTab([closed, open('b'), open('c'), open('d'), open('e'), form('f', 'false')]);
      const task = new BrowserTask(asTab, ask, options);
      expect((await task.run()).status).toBe('needs_confirmation');
      task.update({ confirmIrreversible: true, confirmTarget: 'Staylist' });
      await task.run();
      expect(acted.map((a) => a.label)).toEqual(['Labels', 'bug', 'Create issue']);
    });

    it('feeds back before a confirmed submit too, and the confirmation waits for the pick', async () => {
      const { ask } = scriptedJev([labels, submit, pickBug, submit]);
      const { asTab, acted } = fakeTab([closed, open('b'), open('c'), open('d'), open('e'), form('f', 'false')]);
      const task = new BrowserTask(asTab, ask, options);
      task.update({ confirmIrreversible: true, confirmTarget: 'Staylist' });
      const summary = await task.run();
      expect(acted.map((a) => a.label)).toEqual(['Labels', 'bug', 'Create issue']);
      expect(summary.steps.filter((step) => step.not_executed).map((step) => step.not_executed)).toEqual([NOTE]);
    });

    it('says nothing when the value was already picked', async () => {
      const { ask } = scriptedJev([labels, pickBug, submit]);
      const { asTab } = fakeTab([closed, open('b'), open('c'), open('d')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.steps.filter((step) => step.not_executed)).toEqual([]);
    });

    it('says nothing when the option already shows as applied', async () => {
      const applied = (fingerprint: string) => page({ actions: [labelsTrigger('true'), bugOption({ checked: 'true' }), create], fingerprint });
      const { ask } = scriptedJev([labels, submit]);
      const { asTab } = fakeTab([closed, applied('b'), applied('c')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.steps.filter((step) => step.not_executed)).toEqual([]);
    });

    it('says nothing with no menu open, or with a menu the page opened itself', async () => {
      const noMenu = scriptedJev([submitClosed]);
      const without = await new BrowserTask(fakeTab([closed, closed]).asTab, noMenu.ask, options).run();
      expect(without.status).toBe('needs_confirmation');
      expect(without.steps).toEqual([]);

      const byPage = scriptedJev([submit]);
      const withMenu = await new BrowserTask(fakeTab([open('a'), open('b')]).asTab, byPage.ask, options).run();
      expect(withMenu.status).toBe('needs_confirmation');
      expect(withMenu.steps).toEqual([]);
    });

    it('says nothing when the risky click is the option itself', async () => {
      const riskyPick = { ...pickBug, commit_risk: 0.8 };
      const { ask } = scriptedJev([labels, riskyPick]);
      const { asTab, acted } = fakeTab([closed, open('b'), open('c')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.reason).toContain('bug');
      expect(summary.steps.filter((step) => step.not_executed)).toEqual([]);
      expect(acted).toEqual([{ label: 'Labels' }]);
    });

    it('says nothing for a value the menu does not list', async () => {
      const { ask } = scriptedJev([labels, submit]);
      const { asTab } = fakeTab([closed, open('b'), open('c')]);
      const summary = await new BrowserTask(asTab, ask, { ...options, values: { label: 'enhancement' } }).run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.steps.filter((step) => step.not_executed)).toEqual([]);
    });

    it('feeds back once per option and value: the second submit goes to the hand-back as usual', async () => {
      const { ask } = scriptedJev([labels, submit, submit]);
      const { asTab, acted } = fakeTab([closed, open('b'), open('c'), open('d')]);
      const summary = await new BrowserTask(asTab, ask, options).run();
      expect(summary.status).toBe('needs_confirmation');
      expect(summary.steps.filter((step) => step.not_executed)).toHaveLength(1);
      expect(acted).toEqual([{ label: 'Labels' }]);
    });
  });

  describe('the last look before a guard hands back', () => {
    const click = { operation: 'CLICK', click_target: '1' };
    const options = { goal: 'Open it', doneWhen: 'It is open', changeWaitMs: 0 };
    const unchanged = { status: 'blocked', reason: 'The last 3 actions did not change the page' };

    it('ends as done, looking at a screenshot, when the page already shows the goal', async () => {
      // `fallback` re-decides each stalled step with a screenshot, so steps 2 and 3 take two requests each.
      const { ask, requests } = scriptedJev([...Array(5).fill(click), { ...click, done_check: 0.8 }]);
      const { tab, asTab } = fakeTab();
      const summary = await new BrowserTask(asTab, ask, { ...options, screenshots: 'fallback' }).run();
      expect(summary).toMatchObject({ status: 'done', done_probability: 0.8, reason: 'Completion condition verified: It is open' });
      expect(summary.steps).toHaveLength(3);
      expect(requests).toHaveLength(6);
      expect(tab.screenshots).toBe(3);
    });

    it("keeps the guard's stop when the look finds no completion evidence, or fails", async () => {
      const unconvinced = scriptedJev([click, click, click, { ...click, done_check: 0.2 }]);
      expect(await new BrowserTask(fakeTab().asTab, unconvinced.ask, options).run()).toMatchObject(unchanged);
      expect(unconvinced.requests).toHaveLength(4);

      const scripted = scriptedJev([click]);
      let calls = 0;
      const failingLook: Ask = async (request) => {
        if (++calls === 4) throw new Error('400 bad request');
        return scripted.ask(request);
      };
      expect(await new BrowserTask(fakeTab().asTab, failingLook, options).run()).toMatchObject(unchanged);
      expect(calls).toBe(4);
    });

    it('takes no look without completion evidence to check', async () => {
      const { ask, requests } = scriptedJev([{ ...click, done_check: 0.9 }]);
      const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Open it', changeWaitMs: 0 }).run();
      expect(summary).toMatchObject(unchanged);
      expect(requests).toHaveLength(3);
    });
  });

  describe('a done spike the next step contradicts', () => {
    const options = { goal: 'Open it', doneWhen: 'It is open', changeWaitMs: 0, screenshots: 'fallback' as const };
    // The right next step (a click at 0.87) while the done check spikes to 0.9: the unfiltered list that looks finished.
    const spike = { operation: 'CLICK', click_target: '1', confidence: 0.87, done_check: 0.9 };
    // Distinct fingerprints keep `fallback` from adding a second look after an action that "changed nothing".
    const pages = () => ['a', 'b', 'c', 'd'].map((fingerprint) => page({ fingerprint }));

    it('carries on with the next step when the screenshot look does not confirm the goal', async () => {
      const { ask, requests } = scriptedJev([spike, { operation: 'CLICK', click_target: '1', done_check: 0.3 }, { operation: 'DONE', done_check: 0.8 }]);
      const { tab, acted, asTab } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      const summary = await task.run();
      expect(summary.status).toBe('done');
      expect(acted).toHaveLength(1);
      expect(requests).toHaveLength(3);
      expect(tab.screenshots).toBe(1);
      // The spike and the look that did not confirm it both show before the step that then ran.
      expect(task.trace.slice(0, 3)).toMatchObject([
        { executed: false, decision: { operation: 'CLICK', doneProbability: 0.9 } },
        { executed: false, decision: { doneProbability: 0.3 } },
        { executed: true, decision: { operation: 'CLICK', doneProbability: 0.9 } },
      ]);
    });

    it('ends as done without acting when the screenshot look confirms the goal', async () => {
      const { ask, requests } = scriptedJev([spike, { ...spike, done_check: 0.8 }]);
      const { tab, acted, asTab } = fakeTab(pages());
      const task = new BrowserTask(asTab, ask, options);
      const summary = await task.run();
      expect(summary).toMatchObject({ status: 'done', done_probability: 0.8, reason: 'Completion condition verified: It is open' });
      expect(acted).toHaveLength(0);
      expect(requests).toHaveLength(2);
      expect(tab.screenshots).toBe(1);
      // The spike that triggered the look, then the look that ended the run (before the done's evidence request).
      expect(task.trace.filter((entry) => entry.decision.operation !== 'EVIDENCE').slice(-2)).toMatchObject([
        { executed: false, decision: { operation: 'CLICK', doneProbability: 0.9 } },
        { executed: false, decision: { doneProbability: 0.8 } },
      ]);
    });

    it('takes no look when the next step is waiting or unsure', async () => {
      for (const head of [{ operation: 'WAIT' }, { operation: 'CLICK', click_target: '1', confidence: 0.5 }]) {
        const { ask, requests } = scriptedJev([{ ...spike, ...head }]);
        const { tab, asTab } = fakeTab(pages());
        expect(await new BrowserTask(asTab, ask, options).run()).toMatchObject({ status: 'done' });
        expect(requests).toHaveLength(1);
        expect(tab.screenshots).toBe(0);
      }
    });

    it('takes no look when the profile is text-only or already sends a screenshot every step', async () => {
      for (const screenshots of ['off', 'always'] as const) {
        const { ask, requests } = scriptedJev([spike]);
        const { asTab } = fakeTab(pages());
        expect(await new BrowserTask(asTab, ask, { ...options, screenshots }).run()).toMatchObject({ status: 'done' });
        expect(requests).toHaveLength(1);
      }
    });

    it('carries on when the look fails', async () => {
      const scripted = scriptedJev([spike, { operation: 'DONE', done_check: 0.8 }]);
      let calls = 0;
      const failingLook: Ask = async (request) => {
        if (++calls === 2) throw new Error('400 bad request');
        return scripted.ask(request);
      };
      const { acted, asTab } = fakeTab(pages());
      const summary = await new BrowserTask(asTab, failingLook, options).run();
      expect(summary.status).toBe('done');
      expect(acted).toHaveLength(1);
      // Three decisions, then the done's evidence request.
      expect(calls).toBe(4);
    });
  });

  describe('waiting for the page to react', () => {
    afterEach(() => vi.useRealTimers());

    it('waits for a slow click handler instead of clicking again', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
      const pages = ['a', 'a', 'a', 'b'].map((fingerprint) => page({ fingerprint }));
      const { asTab, acted } = fakeTab(pages);
      const summary = await new BrowserTask(asTab, ask, { goal: 'Filter the list', changeWaitMs: 1000 }).run();
      expect(summary.status).toBe('done');
      expect(acted).toHaveLength(1);
      expect(summary.steps).toMatchObject([{ operation: 'CLICK', page_changed: true }]);
    });

    it('still ends as blocked when nothing ever changes, the wait only delays it', async () => {
      vi.useFakeTimers();
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
      const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Loop', changeWaitMs: 300 }).run();
      await vi.advanceTimersByTimeAsync(2000);
      const summary = await running;
      expect(summary).toMatchObject({ status: 'blocked', reason: 'The last 3 actions did not change the page' });
      expect(summary.steps).toHaveLength(3);
    });

    describe('a page that is still loading when Jev asks for input or says it is stuck', () => {
      const noFields = page({ actions: bookingActions.filter((action) => action.kind !== 'fill') });
      const arrived = page({ fingerprint: 'list arrived' });
      const askingForInput = { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE };

      // The first field with no value is a retry, so needs_input only comes (and waits) on the second ask.
      it.each([
        ['needs_input', [askingForInput, askingForInput], [page(), page(), arrived]],
        ['blocked', [{ operation: 'BLOCKED' }], [noFields, arrived]],
      ])('gives the page a moment before handing back %s, and goes on once it changed', async (_status, handBacks, pages) => {
        const { ask } = scriptedJev([...handBacks, { operation: 'DONE' }]);
        const { asTab, acted } = fakeTab(pages);
        const summary = await new BrowserTask(asTab, ask, { goal: 'Open datasets', values: { name: 'Ada' }, changeWaitMs: 1000 }).run();
        expect(summary.status).toBe('done');
        expect(acted).toEqual([]);
      });

      it('still hands back needs_input when the page never changes, only later', async () => {
        vi.useFakeTimers();
        const { ask, requests } = scriptedJev([askingForInput, askingForInput, { operation: 'DONE' }]);
        const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 300 }).run();
        await vi.advanceTimersByTimeAsync(2000);
        const summary = await running;
        expect(summary.status).toBe('needs_input');
        expect(requests).toHaveLength(2);
      });
    });

    it('does not count WAITs on a shimmering skeleton as a toggle or repeat loop', async () => {
      const { ask } = scriptedJev([...Array.from({ length: 8 }, () => ({ operation: 'WAIT' })), { operation: 'DONE' }]);
      const shimmer = Array.from({ length: 20 }, (_, i) => page({ fingerprint: i % 2 ? 's2' : 's1' }));
      const { asTab } = fakeTab([...shimmer, page({ fingerprint: 'loaded' })]);
      const summary = await new BrowserTask(asTab, ask, { goal: 'Wait for the list' }).run();
      expect(summary.status).not.toBe('blocked');
      expect(summary.steps).toHaveLength(8);
    });
  });
});

describe('real-site robustness', () => {
  const searchPage = (overrides: Partial<PageState> = {}) =>
    page({
      actions: [
        { id: 'e1', kind: 'fill', node: 10, role: 'searchbox', label: 'Search packages', value: '' },
        { id: 'e2', kind: 'fill', node: 11, role: 'textbox', label: 'Email address', value: '' },
        { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
      ],
      ...overrides,
    });

  it('offers Enter only right after typing into a search-like field, and presses it on that field', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'query' },
      { operation: 'PRESS_ENTER' },
      { operation: 'DONE' },
    ]);
    const { asTab, acted } = fakeTab([searchPage({ fingerprint: 'a' }), searchPage({ fingerprint: 'b' }), searchPage({ fingerprint: 'c' })]);
    await new BrowserTask(asTab, ask, { goal: 'Find zod', values: { query: 'zod' } }).run();
    expect(Object.keys((requests[0].questions.operation as any).criteria)).not.toContain('PRESS_ENTER');
    expect(Object.keys((requests[1].questions.operation as any).criteria)).toContain('PRESS_ENTER');
    expect(acted).toEqual([
      { label: 'Search packages', text: 'zod' },
      { label: 'Press Enter in "Search packages" to submit what was typed' },
    ]);
  });

  it('offers Enter after typing into a filter field, whose list only filters on Enter', async () => {
    const filterPage = (fingerprint: string) =>
      page({
        fingerprint,
        actions: [
          { id: 'e1', kind: 'fill', node: 10, role: 'textbox', label: 'Filter by name...', value: '' },
          { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
        ],
      });
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'query' },
      { operation: 'PRESS_ENTER' },
      { operation: 'DONE' },
    ]);
    const { asTab, acted } = fakeTab([filterPage('a'), filterPage('b'), filterPage('c')]);
    await new BrowserTask(asTab, ask, { goal: 'Filter alerts by cpu', values: { query: 'cpu' } }).run();
    expect(Object.keys((requests[1].questions.operation as any).criteria)).toContain('PRESS_ENTER');
    expect(acted).toEqual([
      { label: 'Filter by name...', text: 'cpu' },
      { label: 'Press Enter in "Filter by name..." to submit what was typed' },
    ]);
  });

  it('never offers Enter after typing into a field that is not search-like', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'DONE' },
    ]);
    const { asTab } = fakeTab([searchPage({ fingerprint: 'a' }), searchPage({ fingerprint: 'b' })]);
    await new BrowserTask(asTab, ask, { goal: 'Enter email', values: { email: 'a@b.co' } }).run();
    expect(Object.keys((requests[1].questions.operation as any).criteria)).not.toContain('PRESS_ENTER');
  });

  it("ends as done when the caller's completion evidence is plainly met, without acting", async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.95 }]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open it', doneWhen: 'It is open' }).run();
    expect(summary).toMatchObject({ status: 'done', done_probability: 0.95 });
    expect(acted).toEqual([]);
  });

  it('records when a typed value did not stick, so Jev does not treat the field as filled', async () => {
    const { ask } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'DONE' },
    ]);
    // The field still reads empty after typing: a popup swallowed the input.
    const { asTab } = fakeTab([searchPage({ fingerprint: 'a' }), searchPage({ fingerprint: 'b' })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Enter email', values: { email: 'a@b.co' } }).run();
    expect(summary.steps[0]).toMatchObject({ operation: 'TYPE_TEXT', value_kept: false });
  });
});

describe('errors become hand-backs', () => {
  const SETTLE_TIMEOUT = 'Page did not settle within 1s';
  const click = { operation: 'CLICK', click_target: '1' };

  /** A model that fails with `message` for its first `failures` calls, then answers DONE. */
  const failingJev = (failures: number, message: string) => {
    const scripted = scriptedJev([{ operation: 'DONE' }]);
    const state = { calls: 0 };
    const ask: Ask = async (request) => {
      if (++state.calls <= failures) throw new Error(message);
      return scripted.ask(request);
    };
    return { ask, state };
  };

  afterEach(() => vi.useRealTimers());

  it('ends as blocked when the first observe never settles', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { tab, asTab } = fakeTab();
    tab.observe = async () => {
      throw new StalePage(SETTLE_TIMEOUT);
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary).toMatchObject({ status: 'blocked', url: '', steps: [] });
    expect(summary.reason).toBe(`Browser error: ${SETTLE_TIMEOUT}`);
    expect(requests).toHaveLength(0);
  });

  it('ends as blocked, still reporting the executed action, when the page never settles after it', async () => {
    const { ask } = scriptedJev([click]);
    const { tab, asTab, acted } = fakeTab();
    let observed = 0;
    tab.observe = async () => {
      if (observed++) throw new StalePage(SETTLE_TIMEOUT);
      return page();
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('did not settle');
    expect(acted).toHaveLength(1);
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]).toMatchObject({ operation: 'CLICK', element: acted[0].label });
    expect(summary.steps[0]).not.toHaveProperty('page_changed');
  });

  it('still reports a typed value when the page never settles after typing it', async () => {
    const { ask } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' }]);
    const { tab, asTab, acted } = fakeTab();
    let observed = 0;
    tab.observe = async () => {
      if (observed++) throw new StalePage(SETTLE_TIMEOUT);
      return page();
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Enter email', values: { email: 'ada@example.com' } }).run();
    expect(summary.status).toBe('blocked');
    expect(acted).toEqual([{ label: 'Email address', text: 'ada@example.com' }]);
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]).toMatchObject({ operation: 'TYPE_TEXT', element: 'Email address', value_key: 'email' });
    expect(summary.steps[0]).not.toHaveProperty('page_changed');
    expect(summary.steps[0]).not.toHaveProperty('value_kept');
  });

  it('ends as blocked on a model 400 without retrying it', async () => {
    const { ask, state } = failingJev(Infinity, '400 {"detail":{"error_type":"max_tokens_exceeded"}}');
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^Model error: 400/);
    expect(state.calls).toBe(1);
  });

  it('retries a transient model error once and carries on', async () => {
    vi.useFakeTimers();
    const { ask, state } = failingJev(1, '503 Service Unavailable');
    const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await running).status).toBe('done');
    expect(state.calls).toBe(2);
  });

  it('retries a 499 "unexpected error" once like any transient model error', async () => {
    vi.useFakeTimers();
    const { ask, state } = failingJev(1, '499 An unexpected error occurred');
    const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await running).status).toBe('done');
    expect(state.calls).toBe(2);
  });

  it('ends as blocked when the model fails transiently twice in a row', async () => {
    vi.useFakeTimers();
    const { ask, state } = failingJev(Infinity, '503 Service Unavailable');
    const running = new BrowserTask(fakeTab().asTab, ask, { goal: 'Open' }).run();
    await vi.advanceTimersByTimeAsync(1000);
    const summary = await running;
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^Model error: 503/);
    expect(state.calls).toBe(2);
  });

  it('ends as blocked when the browser refuses an action for a reason other than a stale page', async () => {
    const { ask } = scriptedJev([click]);
    const { tab, asTab } = fakeTab();
    tab.act = async () => {
      throw new Error('Dropdown execution was not confirmed; inspect before retrying.');
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('Dropdown execution');
  });
});

describe("a summary carries the final page's text", () => {
  const TEXT_CAP = 2500;

  it('gives a done summary the final page text, so a caller can read what the page shows', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab([page({ text: 'ada\napp — Demo app\nscratch — Scratch repository' })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'List the repositories', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.page_text).toBe('ada\napp — Demo app\nscratch — Scratch repository');
  });

  it(`cuts a longer page text at ${TEXT_CAP} characters and says how much it left out`, async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const text = 'line of page text\n'.repeat(200).slice(0, 3000);
    const { asTab } = fakeTab([page({ text })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Read it', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.page_text).toBe(`${text.slice(0, TEXT_CAP)}\n…[500 more characters not shown]`);
  });

  it(`leaves a page text of ${TEXT_CAP} characters or fewer as it is, with no marker`, async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const text = 'line of page text\n'.repeat(200).slice(0, TEXT_CAP);
    const { asTab } = fakeTab([page({ text })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Read it', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.page_text).toBe(text);
  });

  it('puts the page text on a blocked summary at the top level, not inside stuck', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { tab, asTab } = fakeTab([page({ text: 'Danger zone\nDelete this repository' })]);
    tab.unreachable = 10;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.page_text).toBe('Danger zone\nDelete this repository');
    expect(summary.stuck).toMatchObject({ operation: 'CLICK', candidates: expect.any(Array) });
    expect(summary.stuck).toHaveProperty('element');
    expect(summary.stuck).not.toHaveProperty('page_text');
  });
});

describe('page dialogs', () => {
  /** A CDP connection that records calls and lets a test emit protocol events on the tab's session. */
  const fakeCdp = (handlers: Record<string, () => unknown> = {}) => {
    const calls: string[] = [];
    const answered: { accept: boolean }[] = [];
    const listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
    const cdp = {
      send: async (method: string, params: any = {}) => {
        calls.push(method);
        if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
        if (method === 'Page.handleJavaScriptDialog') answered.push({ accept: params.accept });
        return handlers[method]?.() ?? {};
      },
      onEvent: (listener: (method: string, params: any, sessionId?: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emit = (method: string, params: object) => listeners.forEach((listener) => listener(method, params, 'S1'));
    return { cdp: cdp as unknown as CdpConnection, calls, answered, emit };
  };

  const opening = (type: string, message = '') => ({ type, message, url: 'http://fixture/', hasBrowserHandler: true });

  it('answers every dialog at once with the choice that changes nothing: OK only for an alert', async () => {
    const { cdp, answered, emit } = fakeCdp();
    const tab = await Tab.attach(cdp, 'T1');
    for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) emit('Page.javascriptDialogOpening', opening(type, `${type} text`));
    expect(answered).toEqual([{ accept: true }, { accept: false }, { accept: false }, { accept: false }]);
    expect(tab.takeDialogs()).toEqual([
      { type: 'alert', message: 'alert text', accepted: true },
      { type: 'confirm', message: 'confirm text', accepted: false },
      { type: 'prompt', message: 'prompt text', accepted: false },
      { type: 'beforeunload', message: 'beforeunload text', accepted: false },
    ]);
    expect(tab.takeDialogs()).toEqual([]);
  });

  it('keeps going when the browser refuses the answer', async () => {
    const { cdp, emit } = fakeCdp({
      'Page.handleJavaScriptDialog': () => {
        throw new CdpError('No dialog is showing');
      },
    });
    const tab = await Tab.attach(cdp, 'T1');
    emit('Page.javascriptDialogOpening', opening('confirm', 'Sure?'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tab.takeDialogs()).toHaveLength(1);
  });

  describe('a page that stops answering', () => {
    const settled = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error) => ({ error }));

    it('ends observe() with the browser error at once instead of retrying every timeout as a stale page', async () => {
      let evaluates = 0;
      const { cdp, calls } = fakeCdp({
        'Runtime.evaluate': () => {
          evaluates++;
          throw new CdpError('Runtime.evaluate timed out after 30000 ms');
        },
      });
      const tab = await Tab.attach(cdp, 'T1');
      const before = calls.length;
      evaluates = 0;
      const outcome: any = await settled(tab.observe());
      expect(outcome.error).toBeInstanceOf(CdpError);
      expect(outcome.error).not.toBeInstanceOf(StalePage);
      expect(outcome.error.message).toBe('Runtime.evaluate timed out after 30000 ms');
      expect(evaluates).toBe(1);
      expect(calls.length).toBeGreaterThan(before);
    });

    it('still retries a protocol error that really means the page is changing', async () => {
      let evaluates = 0;
      const { cdp } = fakeCdp({
        'Runtime.evaluate': () => {
          evaluates++;
          throw new CdpError('Cannot find context with specified id');
        },
      });
      const tab = await Tab.attach(cdp, 'T1');
      evaluates = 0;
      const outcome: any = await settled(tab.observe());
      expect(outcome.error).toBeInstanceOf(StalePage);
      expect(evaluates).toBeGreaterThan(1);
    });

    it('gives up on navigate() at its deadline even when one evaluate never answers', async () => {
      vi.useFakeTimers();
      try {
        let hung = false;
        const { cdp } = fakeCdp({
          'Runtime.evaluate': () => (hung ? new Promise(() => undefined) : {}),
        });
        const tab = await Tab.attach(cdp, 'T1');
        hung = true;
        let returned = false;
        void tab.navigate('http://fixture/').then(() => (returned = true));
        await vi.advanceTimersByTimeAsync(16_000);
        expect(returned).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('in a run', () => {
    const confirmAfterEachClick = (tab: ReturnType<typeof fakeTab>['tab'], message = 'Discard the draft?', type = 'confirm') => {
      const act = tab.act;
      tab.act = async (...args: Parameters<typeof act>) => {
        await act(...args);
        tab.dialogs.push({ type, message, accepted: type === 'alert' });
      };
    };
    const fourPages = ['a', 'b', 'c', 'd'].map((fingerprint) => page({ fingerprint }));

    it("tells Jev about a dialog the page opened after a step, and how it was answered", async () => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      confirmAfterEachClick(tab);
      const summary = await new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.status).toBe('done');
      expect(summary.steps[0].element).toBe('Open Full name (the page then asked "Discard the draft?" in a confirm dialog; answered Cancel)');
      expect(JSON.stringify(requests.at(-1))).toContain('answered Cancel');
    });

    it('describes an alert and a leave-the-page prompt in their own words', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'CLICK', click_target: '4', commit_risk: 0 }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      const dialogs = [
        { type: 'alert', message: 'Saved', accepted: true },
        { type: 'beforeunload', message: '', accepted: false },
      ];
      const act = tab.act;
      tab.act = async (...args: Parameters<typeof act>) => {
        await act(...args);
        tab.dialogs.push(dialogs.shift()!);
      };
      const summary = await new BrowserTask(asTab, ask, { goal: 'Save', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.steps[0].element).toContain('(the page then showed an alert "Saved"; answered OK)');
      expect(summary.steps[1].element).toContain('(the page then asked whether to leave the page; stayed on it)');
    });

    it('reports a dialog that was already open when the call started on the first step it takes', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      tab.dialogs.push({ type: 'confirm', message: 'Leave the page?', accepted: false });
      const summary = await new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.steps[0].element).toContain('the page then asked "Leave the page?" in a confirm dialog; answered Cancel');
    });

    it('hands back when the page keeps asking the same confirm: it is only ever answered Cancel', async () => {
      const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
      const { tab, asTab, acted } = fakeTab(fourPages);
      confirmAfterEachClick(tab);
      const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
      expect(summary.status).toBe('blocked');
      expect(summary.reason).toBe(
        'The page keeps asking "Discard the draft?" (confirm dialog). jev-browse only answers Cancel to these; ask the user how to proceed.',
      );
      expect(acted).toHaveLength(2);
      expect(requests).toHaveLength(2);
    });

    it('does not count a repeated alert as a loop: OK is its only button and changes nothing', async () => {
      const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'CLICK', click_target: '1' }, { operation: 'DONE', done_check: 0.9 }]);
      const { tab, asTab } = fakeTab(fourPages);
      confirmAfterEachClick(tab, 'Saved', 'alert');
      const summary = await new BrowserTask(asTab, ask, { goal: 'Save', doneWhen: 'x', changeWaitMs: 0 }).run();
      expect(summary.status).toBe('done');
    });

    describe('a click the page asks about before leaving', () => {
      const link = (label: string, node: number): PageAction => ({ id: `e${node}`, kind: 'click', node, role: 'link', label });
      // Repository settings: a description, two links away and Save. Every page differs, so no step looks like a no-op.
      const settingsPages = () =>
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((fingerprint) =>
          page({
            fingerprint,
            actions: [
              { id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Description', value: '' },
              link('Wiki', 2),
              link('Issues', 3),
              { id: 'e4', kind: 'click', node: 4, role: 'button', label: 'Save settings' },
            ],
          }),
        );
      // The page's own guard: leaving by these links raises a leave-the-page prompt, answered Stay.
      const guardLinks = (tab: ReturnType<typeof fakeTab>['tab'], ...labels: string[]) => {
        const act = tab.act;
        tab.act = async (...args: Parameters<typeof act>) => {
          await act(...args);
          if (labels.includes(args[0].label)) tab.dialogs.push({ type: 'beforeunload', message: '', accepted: false });
        };
      };
      const typeDescription = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'description' };
      const wiki = { operation: 'CLICK', click_target: '2' };
      const issues = { operation: 'CLICK', click_target: '3' };
      const save = { operation: 'CLICK', click_target: '4', commit_risk: 0.1 };
      const options = { goal: 'Update the settings', values: { description: 'Battle-tested demo' }, changeWaitMs: 0 };
      const SAVE_FIRST = (what: string, unsaved: string) =>
        `${what} would leave the page with ${unsaved}; save it first (a Save or Update button), or answer BLOCKED`;
      const DESCRIPTION = 'unsaved text in "Description"';

      it('feeds a click back as "save first" naming the field typed, and goes on', async () => {
        const { ask, requests } = scriptedJev([typeDescription, wiki, save]);
        const { tab, asTab, acted } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki');
        const summary = await new BrowserTask(asTab, ask, { ...options, maxSteps: 3 }).run();
        expect(summary.status).not.toBe('blocked');
        expect(summary.steps[1]).toMatchObject({ operation: 'CLICK', not_executed: SAVE_FIRST('this link', DESCRIPTION) });
        expect(summary.steps[1].element).toContain('(the page then asked whether to leave the page; stayed on it)');
        expect(JSON.stringify(requests[2])).toContain('save it first');
        expect(acted.map((a) => a.label)).toEqual(['Description', 'Wiki', 'Save settings']);
      });

      it('names a ticked box when that is the unsaved change', async () => {
        const boxPages = ['a', 'b', 'c', 'd'].map((fingerprint) =>
          page({
            fingerprint,
            actions: [{ id: 'e1', kind: 'click', node: 1, role: 'checkbox', label: 'Enable repository wiki', checked: 'false' }, link('Issues', 2)],
          }),
        );
        const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'CLICK', click_target: '2' }]);
        const { tab, asTab } = fakeTab(boxPages);
        guardLinks(tab, 'Issues');
        const summary = await new BrowserTask(asTab, ask, { goal: 'Turn the wiki off', changeWaitMs: 0, maxSteps: 2 }).run();
        expect(summary.steps[1]).toMatchObject({ not_executed: SAVE_FIRST('this link', 'unsaved changes to "Enable repository wiki"') });
      });

      it('hands back naming the field when the same click raises the prompt again', async () => {
        const { ask } = scriptedJev([typeDescription, wiki]);
        const { tab, asTab } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki');
        const summary = await new BrowserTask(asTab, ask, options).run();
        expect(summary.status).toBe('blocked');
        expect(summary.reason).toBe(
          'Leaving the page would discard the unsaved text in "Description" (the page asked before leaving); save it first, or ask the user whether to discard it.',
        );
      });

      it('gives each link its own "save first" before handing back', async () => {
        const { ask } = scriptedJev([typeDescription, wiki, issues, issues]);
        const { tab, asTab } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki', 'Issues');
        const summary = await new BrowserTask(asTab, ask, options).run();
        expect(summary.steps[1].not_executed).toBe(SAVE_FIRST('this link', DESCRIPTION));
        expect(summary.steps[2].not_executed).toBe(SAVE_FIRST('this link', DESCRIPTION));
        expect(summary.status).toBe('blocked');
        expect(summary.reason).toContain('Leaving the page would discard the unsaved text in "Description"');
      });

      it('keeps the generic reply when nothing was typed or ticked', async () => {
        const { ask } = scriptedJev([wiki]);
        const { tab, asTab } = fakeTab(settingsPages());
        guardLinks(tab, 'Wiki');
        const summary = await new BrowserTask(asTab, ask, options).run();
        expect(summary.steps[0].not_executed).toBeUndefined();
        expect(summary.status).toBe('blocked');
        expect(summary.reason).toBe(
          'The page keeps asking (beforeunload dialog). jev-browse only answers Cancel to these; ask the user how to proceed.',
        );
      });
    });
  });
});

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

describe('a scroll that moved nothing says so', () => {
  const SCROLL: PageAction = { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 };
  const scrolling = (fingerprint: string) => page({ actions: [...bookingActions, SCROLL], fingerprint });
  const lastAction = (request: any) => request.state.recent_actions.at(-1);

  it('tells Jev a scroll moved nothing, so it stops repeating it', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'SCROLL_DOWN' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([scrolling('a'), scrolling('b')]);
    tab.scrolled = 0;
    await new BrowserTask(asTab, ask, { goal: 'Find the row', changeWaitMs: 0 }).run();
    expect(lastAction(requests[1])).toMatchObject({
      operation: 'SCROLL_DOWN',
      element: 'Scroll down (nothing moved: there is no more to scroll this way)',
    });
  });

  it('keeps the plain label for a scroll that moved', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'SCROLL_DOWN' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([scrolling('a'), scrolling('b')]);
    tab.scrolled = 448;
    await new BrowserTask(asTab, ask, { goal: 'Find the row', changeWaitMs: 0 }).run();
    expect(lastAction(requests[1])).toMatchObject({ operation: 'SCROLL_DOWN', element: 'Scroll down', page_changed: true });
  });
});

describe('a tab the run\'s tab opens is followed', () => {
  const DOCS_LINK: PageAction = { id: 'docs', kind: 'click', node: 50, role: 'link', label: 'API documentation' };
  const BACK: PageAction = { id: 'close', kind: 'click', node: 60, role: 'button', label: 'Close this window' };
  const dashboard = (fingerprint: string) => page({ url: 'http://fixture/dashboard', title: 'Dashboard', actions: [DOCS_LINK], fingerprint });
  const docs = (fingerprint: string) => page({ url: 'http://fixture/docs', title: 'Docs', text: 'Getting started', actions: [BACK], fingerprint });
  const openingDocs = () => {
    const opener = fakeTab([dashboard('d1')]);
    const popup = fakeTab([docs('p1'), docs('p2')]);
    opener.tab.opensTabOn = DOCS_LINK.label;
    opener.tab.next = popup.asTab;
    return { opener, popup };
  };
  const recent = (request: any) => request.state.recent_actions;

  it('continues on the new tab and says so in history', async () => {
    const { opener, popup } = openingDocs();
    const { ask, requests } = scriptedJev([{ operation: 'CLICK' }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Open the docs', changeWaitMs: 0 });
    const summary = await task.run();
    expect(requests[1].state.page.url).toBe('http://fixture/docs');
    expect(recent(requests[1]).at(-1)).toMatchObject({
      operation: 'CLICK',
      element: 'API documentation (new tab opened: http://fixture/docs)',
      page_changed: true,
    });
    expect(summary).toMatchObject({ status: 'done', url: 'http://fixture/docs' });
    expect(task.tab).toBe(popup.asTab);
    expect(task.tabs).toEqual([opener.asTab, popup.asTab]);
  });

  it('goes back to the tab that opened it when it closes', async () => {
    const { opener, popup } = openingDocs();
    const { ask, requests } = scriptedJev([{ operation: 'CLICK' }, { operation: 'CLICK' }, { operation: 'DONE' }]);
    const closeOnClick = popup.tab.act;
    popup.tab.act = async (...args: Parameters<typeof closeOnClick>) => {
      await closeOnClick(...args);
      popup.tab.closed = true;
    };
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Read the docs, then close them', changeWaitMs: 0 });
    await task.run();
    expect(requests[2].state.page.url).toBe('http://fixture/dashboard');
    expect(recent(requests[2]).at(-1).element).toBe('Close this window (the tab closed; back on http://fixture/dashboard)');
    expect(task.tab).toBe(opener.asTab);
  });

  it('closes the tabs it followed when the session ends, and the first one only when asked', async () => {
    const { opener, popup } = openingDocs();
    const { ask } = scriptedJev([{ operation: 'CLICK' }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Open the docs', changeWaitMs: 0 });
    await task.run();
    await task.closeTabs({ keepFirst: true });
    expect([opener.tab.closes, popup.tab.closes]).toEqual([0, 1]);
    await task.closeTabs({ keepFirst: false });
    expect(opener.tab.closes).toBe(1);
  });

  it('leaves no confirm arm on the tab it switched away from', async () => {
    const PAY_THERE: PageAction = { id: 'pay', kind: 'click', node: 51, role: 'link', label: 'Pay in a new tab' };
    const opener = fakeTab([page({ url: 'http://fixture/stays', title: 'Staylist', actions: [PAY_THERE], fingerprint: 'o1' })]);
    const popup = fakeTab([docs('p1'), docs('p2')]);
    opener.tab.opensTabOn = PAY_THERE.label;
    opener.tab.next = popup.asTab;
    const { ask } = scriptedJev([{ operation: 'CLICK', commit_risk: 0.9 }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Pay for the Staylist booking', changeWaitMs: 0 });
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    await task.run();
    expect(opener.tab.armedAtAct).toEqual([[STAYLIST, PAY_THERE.label]]);
    expect(opener.tab.armed).toBeUndefined();
    expect(popup.tab.armed).toBeUndefined();
  });

  it('hands back blocked with a browser error when the new tab never answers', async () => {
    const { opener } = openingDocs();
    opener.tab.follow = async () => {
      throw new CdpError('The new tab did not answer within 5 s: it may be showing a dialog it raised before jev-browse could answer it');
    };
    const { ask } = scriptedJev([{ operation: 'CLICK' }, { operation: 'DONE' }]);
    const summary = await new BrowserTask(opener.asTab, ask, { goal: 'Open the docs', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^Browser error: The new tab did not answer within 5 s/);
    expect(summary.steps.map((step) => step.element)).toEqual(['API documentation']);
  });

  it('keeps a confirmation given before the switch for the new tab', async () => {
    const PAY: PageAction = { id: 'pay', kind: 'click', node: 70, role: 'button', label: 'Pay €412' };
    const opener = fakeTab([dashboard('d1')]);
    const popup = fakeTab([page({ url: 'http://fixture/pay', title: 'Staylist payment', actions: [PAY], fingerprint: 'p1' }), page({ fingerprint: 'p2' })]);
    opener.tab.opensTabOn = DOCS_LINK.label;
    opener.tab.next = popup.asTab;
    const { ask } = scriptedJev([{ operation: 'CLICK' }, { operation: 'CLICK', commit_risk: 0.9 }, { operation: 'DONE' }]);
    const task = new BrowserTask(opener.asTab, ask, { goal: 'Pay for the Staylist booking', changeWaitMs: 0 });
    task.update({ confirmIrreversible: true, confirmTarget: STAYLIST });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(popup.acted.map((a) => a.label)).toEqual(['Pay €412']);
  });
});

describe('an upload uses a file the caller declared', () => {
  const AVATAR = new URL('../verify/fixture/capabilities/avatar.png', import.meta.url).pathname;
  const PICKER: PageAction = { id: 'e9', kind: 'upload', node: 80, role: 'file', label: 'Upload a profile picture (file field)', value: '' };
  const CHOOSE: PageAction = { id: 'e10', kind: 'click', node: 81, role: 'button', label: 'Upload a profile picture' };
  const profile = (fingerprint: string) => page({ url: 'http://fixture/profile', title: 'Profile', actions: [CHOOSE, PICKER], fingerprint });
  const upload = { operation: 'UPLOAD', file_for_2: 'avatar' };

  it('offers UPLOAD with file heads over the declared keys, sending each file\'s name and never its path', () => {
    const space = buildActionSpace(profile('a').actions);
    const request = buildRequest({ page: profile('a'), goal: 'Set my picture', history: [], checkCommitRisk: true, values: {}, files: { avatar: 'avatar.png' } }, space);
    expect(Object.keys((request.questions.operation as any).criteria)).toContain('UPLOAD');
    expect(Object.keys((request.questions.file_for_2 as any).criteria)).toEqual(['avatar', NO_SUPPLIED_FILE]);
    expect((request.state as any).supplied_files).toEqual({ avatar: 'avatar.png' });
  });

  it('sets the declared path on the chosen field and says which key it used', async () => {
    const { ask, requests } = scriptedJev([upload, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([profile('a'), profile('b')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Set my picture', files: { avatar: AVATAR }, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(tab.wantedFiles).toBe(true);
    expect(tab.uploads).toEqual([{ label: PICKER.label, path: AVATAR }]);
    expect(summary.steps[0]).toMatchObject({ operation: 'UPLOAD', element: PICKER.label, file_key: 'avatar' });
    for (const request of requests) expect(JSON.stringify(request)).not.toContain(AVATAR);
  });

  it('feeds back a field no declared file fits once, then asks the caller', async () => {
    const noFile = { operation: 'UPLOAD', file_for_2: NO_SUPPLIED_FILE };
    const { ask, requests } = scriptedJev([noFile, noFile]);
    const { tab, asTab } = fakeTab([profile('a'), profile('b'), profile('c')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Attach my CV', files: { avatar: AVATAR }, changeWaitMs: 0 }).run();
    expect(requests[1].state.recent_actions.at(-1).not_executed).toMatch(/^no supplied file fits this field/);
    expect(summary).toMatchObject({ status: 'needs_input', reason: `No supplied file fits the file field "${PICKER.label}"` });
    expect(tab.uploads).toEqual([]);
  });

  it('never uploads a value: a key from values is not a file', async () => {
    const { ask } = scriptedJev([{ operation: 'UPLOAD', file_for_2: 'secret' }]);
    const { tab, asTab } = fakeTab([profile('a')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Set my picture', values: { secret: '/etc/passwd' }, files: { avatar: AVATAR }, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(tab.uploads).toEqual([]);
  });

  it('lists no file fields and offers no UPLOAD when no files are declared', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page()]);
    await new BrowserTask(asTab, ask, { goal: 'Book it', changeWaitMs: 0 }).run();
    expect(tab.wantedFiles).toBe(false);
    expect(Object.keys((requests[0].questions.operation as any).criteria)).not.toContain('UPLOAD');
    expect(requests[0].state).not.toHaveProperty('supplied_files');
  });
});

describe('a run stops when the caller cancels or the time budget passes, never mid-input', () => {
  const CANCELLED = 'Cancelled by the caller';
  const click = { operation: 'CLICK', click_target: '1' };
  const changingPages = () => 'abcdefghijklmnop'.split('').map((fingerprint) => page({ fingerprint }));

  afterEach(() => vi.useRealTimers());

  it('stops before the first decision when the caller already cancelled', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab, acted } = fakeTab(changingPages());
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 0 }).run({ signal: AbortSignal.abort() });
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED, steps: [] });
    expect(requests).toHaveLength(0);
    expect(acted).toEqual([]);
  });

  it('stops inside a wait instead of waiting it out', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'WAIT' }]);
    const { asTab } = fakeTab([page({ fingerprint: 'same' })]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 30_000 }).run({ signal: controller.signal });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED });
    expect(requests).toHaveLength(1);
  });

  it('cancels a Jev request in flight and never reports it as a model error', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    // A request that never answers, whatever its signal does: the run must not wait for it.
    const ask: Ask = (_request, options) => {
      signals.push(options?.signal);
      return new Promise(() => undefined);
    };
    const { asTab, acted } = fakeTab();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 0 }).run({ signal: controller.signal });
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(acted).toEqual([]);
  });

  it('ends step_budget, naming the time budget, when max_seconds passes mid-run', async () => {
    vi.useFakeTimers();
    const scripted = scriptedJev([click]);
    // Each decision takes a second.
    const ask: Ask = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return scripted.ask(request);
    };
    const { asTab, acted } = fakeTab(changingPages());
    const running = new BrowserTask(asTab, ask, { goal: 'Open', maxSeconds: 2.5, changeWaitMs: 0 }).run();
    await vi.advanceTimersByTimeAsync(5000);
    const summary = await running;
    expect(summary.status).toBe('step_budget');
    expect(summary.reason).toBe('Reached the time budget of 2.5 s (max_seconds) after 2 actions without finishing');
    expect(acted).toHaveLength(2);
  });

  it('lets an input in flight finish, reports it, and runs nothing after it', async () => {
    const { ask } = scriptedJev([click]);
    const { tab, asTab, acted } = fakeTab(changingPages());
    const controller = new AbortController();
    const act = tab.act;
    tab.act = async (...args) => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return act(...args);
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', changeWaitMs: 30_000 }).run({ signal: controller.signal });
    expect(summary).toMatchObject({ status: 'blocked', reason: CANCELLED });
    expect(acted).toEqual([{ label: 'Open Full name' }]);
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]).toMatchObject({ operation: 'CLICK', element: 'Open Full name', page_changed: true });
  });

  it('runs the session normally on the next call after a cancel', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const { asTab } = fakeTab();
    const task = new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'Open', changeWaitMs: 0 });
    expect((await task.run({ signal: AbortSignal.abort() })).reason).toBe(CANCELLED);
    expect((await task.run()).status).toBe('done');
  });
});

describe('a run stays on the allowed hosts and off the blocked ones', () => {
  const click = { operation: 'CLICK', click_target: '1' };
  const ON_SITE = { allowed: ['fixture'], blocked: [] };
  const offSite = (url: string) => page({ url, fingerprint: url });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('ends blocked, naming the host, when a click lands on another host, and decides nothing there', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab, acted } = fakeTab([page(), offSite('https://partner.example/offer')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Claim the offer', hosts: ON_SITE, changeWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toBe(
      "After \"Open Full name\" the page is outside this run's hosts: partner.example is outside the allowed hosts (fixture); the run stopped without going back",
    );
    expect(summary.url).toBe('https://partner.example/offer');
    expect(acted).toEqual([{ label: 'Open Full name' }]);
    expect(requests).toHaveLength(1);
  });

  it('ends blocked before any request when the page is already outside (an open tab, a redirect)', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab, acted } = fakeTab([offSite('https://sso.example/login')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', hosts: ON_SITE, changeWaitMs: 0 }).run();
    expect(summary).toMatchObject({
      status: 'blocked',
      reason: "The page is outside this run's hosts: sso.example is outside the allowed hosts (fixture); the run stopped without going back",
    });
    expect(requests).toHaveLength(0);
    expect(acted).toEqual([]);
  });

  it('ends blocked on a blocked host matched by a wildcard', async () => {
    const { ask } = scriptedJev([click]);
    const { asTab } = fakeTab([page(), offSite('https://ads.tracker.io/r')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', hosts: { blocked: ['*.tracker.io'] }, changeWaitMs: 0 }).run();
    expect(summary.reason).toBe(
      "After \"Open Full name\" the page is outside this run's hosts: ads.tracker.io is a blocked host (*.tracker.io); the run stopped without going back",
    );
  });

  it('carries on across hosts when no lists are set', async () => {
    const { ask } = scriptedJev([click, { operation: 'DONE', done_check: 0.95 }]);
    const { asTab } = fakeTab([page(), offSite('https://partner.example/offer')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open', doneWhen: 'Open', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
  });

  it('lets a later call narrow the lists, and refuses one that widens them', async () => {
    const { ask, requests } = scriptedJev([click]);
    const { asTab } = fakeTab([page()]);
    const task = new BrowserTask(asTab, ask, { goal: 'Open', hosts: { allowed: ['fixture', 'other.example'], blocked: [] }, maxSteps: 1, changeWaitMs: 0 });
    expect(() => task.update({ allowedHosts: ['*.fixture'] })).toThrow(/a call can only narrow them/);
    task.update({ allowedHosts: ['other.example'] });
    const summary = await task.run();
    expect(summary.reason).toBe("The page is outside this run's hosts: fixture is outside the allowed hosts (other.example); the run stopped without going back");
    expect(requests).toHaveLength(0);
  });

  describe('a new session started through the runner', () => {
    const startAt = async (url: string, hosts: { allowedHosts?: string[]; blockedHosts?: string[] }) => {
      const { ask } = scriptedJev([click]);
      vi.spyOn(model, 'createAsk').mockReturnValue(ask);
      vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp: {} } as chrome.ChromeHandle);
      const open = vi.spyOn(Tab, 'open').mockResolvedValue(fakeTab([page({ url })]).asTab);
      const task = createRunner('launch-headless').start({ goal: 'Open', url, maxSteps: 1, changeWaitMs: 0, ...hosts });
      return { task, open };
    };

    it('never opens a start URL outside the allowed hosts', async () => {
      const { task, open } = await startAt('https://evil.example/', { allowedHosts: ['fixture'] });
      await expect(task).rejects.toThrow('Not opened: evil.example is outside the allowed hosts (fixture)');
      expect(open).not.toHaveBeenCalled();
    });

    it("applies the server's JEV_ALLOWED_HOSTS and JEV_BLOCKED_HOSTS, which a call can narrow but never widen", async () => {
      vi.stubEnv('JEV_ALLOWED_HOSTS', '*.example.com');
      vi.stubEnv('JEV_BLOCKED_HOSTS', 'ads.example.com');
      await expect((await startAt('https://evil.example/', {})).task).rejects.toThrow('evil.example is outside the allowed hosts (*.example.com)');
      await expect((await startAt('https://ads.example.com/', {})).task).rejects.toThrow('ads.example.com is a blocked host (ads.example.com)');
      await expect((await startAt('https://shop.example.com/', { allowedHosts: ['evil.example'] })).task).rejects.toThrow(
        /a call can only narrow them/,
      );
      const { task, open } = await startAt('https://shop.example.com/', { allowedHosts: ['shop.example.com'] });
      await expect(task).resolves.toBeInstanceOf(BrowserTask);
      expect(open).toHaveBeenCalled();
    });
  });
});

describe('a bot wall', () => {
  // npm's Cloudflare challenge as headless Chrome saw it: nothing on it to act on but a wait.
  const wallPage = (fingerprint = 'wall') =>
    page({
      url: 'https://www.npmjs.com/',
      title: 'Just a moment...',
      text: 'www.npmjs.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.\nRay ID:\na4c627515b445548\nPerformance and Security by\nCloudflare\nPrivacy',
      actions: [{ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }],
      fingerprint,
    });
  const realPage = (fingerprint = 'real') => page({ url: 'https://www.npmjs.com/package/zod', title: 'zod - npm', text: 'zod\nTypeScript-first schema validation', fingerprint });

  it('ends the run blocked, naming the wall, without spending a decision on it', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'WAIT' }]);
    const { asTab, acted } = fakeTab([wallPage()]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('bot check (Cloudflare;');
    expect(summary.reason).toContain('jev-browse never tries to get past one');
    expect(summary.wall).toEqual({ kind: 'bot_check', origin: 'https://www.npmjs.com', name: 'cloudflare' });
    expect(summary.page_text).toContain('Performing security verification');
    expect(requests).toHaveLength(0);
    expect(acted).toEqual([]);
  });

  it('waits out a check that clears by itself, then goes on without having asked Jev about it', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab([wallPage('w1'), wallPage('w2'), realPage()]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 5000 }).run();
    expect(summary.status).toBe('done');
    expect(summary.title).toBe('zod - npm');
    expect(summary.wall).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain('Performing security verification');
  });

  it('never ends done on a page that turned into a check while Jev decided', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const { tab, asTab } = fakeTab([realPage(), wallPage()]);
    tab.fresh = async () => false;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('bot check (Cloudflare;');
    expect(summary.title).toBe('Just a moment...');
    expect(summary.wall).toMatchObject({ kind: 'bot_check', name: 'cloudflare' });
  });

  it('does not wait out a check a second time when it comes back in the same call', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { asTab } = fakeTab([wallPage('w1'), realPage(), wallPage('w2')]);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 1000 }).run();
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain('bot check (Cloudflare;');
    expect(requests).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('stops waiting out a check as soon as the caller cancels, and reports the cancel', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'WAIT' }]);
    const { asTab } = fakeTab([wallPage()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open zod', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 30_000 }).run({
      signal: controller.signal,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(summary).toMatchObject({ status: 'blocked', reason: 'Cancelled by the caller' });
    expect(requests).toHaveLength(0);
  });

  it('runs a page that only discusses captchas as any other page', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const thread = page({
      title: 'Ask HN: Are captchas still worth it? | Hacker News',
      text: 'Ask HN: Are captchas still worth it?\nWe dropped Google Captcha v3. The "I am not a robot" checkbox costs more signups than the bots it stops; verify you are human pages punish VPN users.',
    });
    const { asTab } = fakeTab([thread]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open the thread', doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.wall).toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});

describe('values the caller marks secret', () => {
  // A token with a space and a slash, so its URL encodings differ from it.
  const TOKEN = 'tok Zq/81x';
  const ENCODINGS = [TOKEN, encodeURIComponent(TOKEN), encodeURIComponent(TOKEN).replace(/%20/g, '+')].map((form) => form.toLowerCase());
  const MARKER = '[secret:token]';
  const tokenField: PageAction = { id: 't1', kind: 'fill', node: 7, role: 'textbox', label: 'API token', value: '' };
  const copyButton: PageAction = { id: 't2', kind: 'click', node: 8, role: 'button', label: 'Copy the new token' };
  const blank = page({ url: 'http://fixture/settings/tokens', title: 'Tokens', text: 'Paste your token for Ada', actions: [tokenField, copyButton], fingerprint: 'a' });
  // The page echoes the token everywhere it can: address, title, text (upper-cased too), the field, a button.
  const echoing = (fingerprint: string) =>
    page({
      url: `http://fixture/settings/tokens?last=${encodeURIComponent(TOKEN)}`,
      title: `Token ${TOKEN}`,
      text: `Saved token ${TOKEN} for Ada\nCOPY ${TOKEN.toUpperCase()}`,
      actions: [
        { ...tokenField, value: TOKEN, current_value: TOKEN },
        { ...copyButton, label: `Copy ${TOKEN}` },
      ],
      fingerprint,
    });
  const leaks = (anything: unknown) => {
    const text = (typeof anything === 'string' ? anything : JSON.stringify(anything)).toLowerCase();
    return ENCODINGS.filter((form) => text.includes(form));
  };
  const typeToken = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'token' };
  const copyIt = { operation: 'CLICK', click_target: '2', commit_risk: 0.9 };

  it('shows Jev the key in place of the value, in the supplied values and the value question', () => {
    const space = buildActionSpace(blank.actions);
    const request = buildRequest({ page: blank, goal: 'Save the token', history: [], checkCommitRisk: true, values: { token: TOKEN, name: 'Ada' }, secretKeys: ['token'] }, space) as any;
    expect(request.state.supplied_values).toEqual({ token: MARKER, name: 'Ada' });
    expect(request.questions.value_for_1.criteria.token).toBe(`token: ${MARKER}`);
    expect(request.questions.value_for_1.criteria.name).toBe('name: Ada');
    expect(leaks(request)).toEqual([]);
  });

  it('leaves Jev\'s request exactly as it was when no key is marked', () => {
    const space = buildActionSpace(echoing('b').actions);
    const input = { page: echoing('b'), goal: 'Save the token', history: [], checkCommitRisk: true, values: { token: TOKEN } };
    expect(buildRequest({ ...input, secretKeys: [] }, space)).toEqual(buildRequest(input, space));
    expect(buildRequest({ ...input, secretKeys: ['otp'] }, space)).toEqual(buildRequest(input, space));
  });

  it('scrubs a secret the page echoes from the request, but not from the screenshot', () => {
    const space = buildActionSpace(echoing('b').actions);
    const screenshot = Buffer.from(TOKEN).toString('base64');
    const request = buildRequest(
      { page: echoing('b'), goal: `Save the token ${TOKEN}`, history: [{ operation: 'CLICK', element: `Copy ${TOKEN}` }], checkCommitRisk: true, values: { token: TOKEN }, secretKeys: ['token'], screenshot },
      space,
    ) as any;
    expect(leaks(request.state[1])).toEqual([]);
    expect(leaks(request.questions)).toEqual([]);
    expect(JSON.stringify(request.state[1])).toContain(`Saved token ${MARKER} for Ada`);
    expect(request.state[0].image_url.url).toBe(`data:image/jpeg;base64,${screenshot}`);
  });

  it('keeps a secret typed into a field out of every request Jev gets, with screenshots each step', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '2', risk_2: 0.1 }]);
    const { asTab } = fakeTab([echoing('b'), echoing('c')]);
    await new BrowserTask(asTab, ask, {
      goal: 'Copy it',
      values: { token: TOKEN },
      secretKeys: ['token'],
      screenshots: 'always',
      elementRisk: true,
      maxSteps: 1,
      changeWaitMs: 0,
    }).run();
    expect(requests.length).toBeGreaterThan(1);
    expect(leaks(requests)).toEqual([]);
    expect(JSON.stringify(requests[0])).toContain(`"current_value":"${MARKER}"`);
    expect(requests[0].state[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SCREENSHOT' } });
  });

  it('scrubs it from follow-up questions too', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '2', risk_2: 0.1 }]);
    await decide(ask, { page: echoing('b'), goal: 'Copy it', history: [], checkCommitRisk: true, values: { token: TOKEN }, secretKeys: ['token'], elementRisk: 'chosen' });
    expect(requests).toHaveLength(2);
    expect(leaks(requests)).toEqual([]);
  });

  it('types the real value, and keeps it out of every request, summary, trace and recording', async () => {
    const { ask, requests } = scriptedJev([typeToken, copyIt]);
    const { tab, asTab, acted } = fakeTab([blank, echoing('b'), echoing('c'), echoing('d')]);
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-secret-'));
    const task = new BrowserTask(asTab, ask, { goal: 'Save the token', values: { token: TOKEN, name: 'Ada' }, secretKeys: ['token'], changeWaitMs: 0, recordDir });
    const summary = await task.run();

    expect(acted).toEqual([{ label: 'API token', text: TOKEN }]);
    expect(summary.status).toBe('needs_confirmation');
    expect(summary.reason).toMatch(/^Clicking "Copy \[secret:token\]" on "Token \[secret:token\]"/);
    expect(summary.page_text).toContain(`Saved token ${MARKER} for Ada`);
    expect(summary.url).toBe('http://fixture/settings/tokens?last=[secret:token]');
    for (const output of [requests, summary, task.trace]) expect(leaks(output)).toEqual([]);
    for (const file of ['summary.json', 'index.html']) {
      const written = readFileSync(join(recordDir, file), 'utf8');
      expect(leaks(written)).toEqual([]);
      expect(written).toContain(MARKER);
    }
    // The page's scripts never get the secret to look for: only unmarked values are wanted.
    expect(tab.wanted).toEqual(['Ada']);
  });

  it('keeps every key marked on an earlier call secret, and adds the new ones', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED' }]);
    const { asTab } = fakeTab([echoing('b')]);
    const task = new BrowserTask(asTab, ask, { goal: 'Save it', values: { token: TOKEN }, secretKeys: ['token'], changeWaitMs: 0 });
    await task.run();
    task.update({ values: { otp: '918273' }, secretKeys: ['otp'] });
    const summary = await task.run();
    expect(JSON.stringify(requests.at(-1).state.supplied_values)).toBe(JSON.stringify({ token: MARKER, otp: '[secret:otp]' }));
    expect(leaks(summary)).toEqual([]);
  });

  it('passes the marked keys from a new session started through the runner', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED' }]);
    const { asTab } = fakeTab([echoing('b')]);
    vi.spyOn(model, 'createAsk').mockReturnValue(ask);
    vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp: {} } as chrome.ChromeHandle);
    vi.spyOn(Tab, 'open').mockResolvedValue(asTab);
    const task = await createRunner('launch-headless').start({ goal: 'Save it', url: 'http://fixture/settings/tokens', values: { token: TOKEN }, secretKeys: ['token'], changeWaitMs: 0 });
    const summary = await task.run();
    vi.restoreAllMocks();
    expect(leaks([requests, summary])).toEqual([]);
  });
});

describe('a needs_input names the fields it wants', () => {
  it('names the field Jev chose when no supplied value fits it', async () => {
    const { ask } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Book', values: { name: 'Ada' }, changeWaitMs: 0 }).run();
    expect(summary.reason).toBe('No supplied value fits the field "Email address"');
    expect(summary.missing).toEqual([{ label: 'Email address', role: 'textbox', path: '/stays' }]);
  });

  it('names every empty field a BLOCKED has no value for, in page order', async () => {
    const { ask } = scriptedJev([{ operation: 'BLOCKED' }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Book', changeWaitMs: 0 }).run();
    expect(summary.reason).toBe('Blocked: no supplied value for "Full name", "Email address"');
    expect(summary.missing).toEqual([
      { label: 'Full name', role: 'textbox', path: '/stays' },
      { label: 'Email address', role: 'textbox', path: '/stays' },
    ]);
  });

  it('leaves it out of any other hand-back', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
    const summary = await new BrowserTask(fakeTab().asTab, ask, { goal: 'Pay', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('needs_confirmation');
    expect(summary).not.toHaveProperty('missing');
  });
});

describe("the caller's checks on the final page", () => {
  const confirmed = { type: 'text_contains', text: 'Booking confirmed' } as const;
  const onStays = { type: 'url_contains', text: '/stays' } as const;
  const showsDetails = { type: 'text_contains', text: 'your details' } as const;

  it('turns a done whose check fails into uncertain, naming the failed check', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [confirmed, onStays], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('uncertain');
    expect(summary.reason).toMatch(/^Jev reported done, but 1 of 2 checks failed on the final page: text_contains "Booking confirmed"/);
    expect(summary.checks).toEqual([
      expect.objectContaining({ type: 'text_contains', text: 'Booking confirmed', pass: false }),
      expect.objectContaining({ type: 'url_contains', text: '/stays', pass: true }),
    ]);
  });

  it('keeps a done whose checks all pass, and returns each result', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays, showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.checks?.map((check) => check.pass)).toEqual([true, true]);
  });

  it('turns an unsure hand-back into done when every check passes and done_when scored 0.5+ on that page', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.6 }]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'The details form shows', checks: [onStays, showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.reason).toMatch(/^All 2 checks passed on the final page and "The details form shows" scored 0\.6 there \(the run had ended uncertain: /);
    expect(summary).not.toHaveProperty('stuck');
    expect(acted).toEqual([]);
  });

  it('turns a blocked run into done the same way', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { tab, asTab } = fakeTab(['a', 'b', 'c', 'd'].map((fingerprint) => page({ fingerprint })));
    tab.unreachable = 10;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary.reason).toMatch(/the run had ended blocked: "Open Full name" could not be reached 3 times/);
  });

  it('never turns a hand-back into done without done_when', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', checks: [onStays, showsDetails], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('uncertain');
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
  });

  it('never turns a hand-back into done when done_when scored under 0.5', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.3 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('uncertain');
  });

  it('never counts a done_when score made before the last action ran', async () => {
    // Three clicks change nothing; the last look scores 0.3, so the guard stops on the third click's decision (0.6, made before it ran).
    const { ask } = scriptedJev([
      { operation: 'CLICK', click_target: '1', done_check: 0.6 },
      { operation: 'CLICK', click_target: '1', done_check: 0.6 },
      { operation: 'CLICK', click_target: '1', done_check: 0.6 },
      { operation: 'CLICK', click_target: '1', done_check: 0.3 },
    ]);
    const { asTab, acted } = fakeTab(['a', 'a', 'a', 'a', 'a'].map((fingerprint) => page({ fingerprint })));
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    expect(acted).toHaveLength(3);
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toBe('The last 3 actions did not change the page');
  });

  it('needs the done_when score at 0.75 while an edit is unsaved', async () => {
    const run = async (doneCheck: number) => {
      const { ask } = scriptedJev([
        { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'name' },
        { operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: doneCheck },
      ]);
      const { asTab } = fakeTab(['a', 'b', 'c'].map((fingerprint) => page({ fingerprint })));
      return new BrowserTask(asTab, ask, { goal: 'Name', values: { name: 'Ada' }, doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    };
    expect((await run(0.6)).status).toBe('uncertain');
    expect((await run(0.8)).status).toBe('done');
  });

  it('never turns a stop that is not a judgment of progress into done, whatever the checks say', async () => {
    // The page re-renders under every click: a browser-level stop, decided on the final page with done_when at 0.6.
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { tab, asTab, acted } = fakeTab(Array.from({ length: 8 }, (_, i) => page({ fingerprint: String(i) })));
    tab.stale = 100;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays, showsDetails], maxSteps: 1, changeWaitMs: 0 }).run();
    expect(acted).toEqual([]);
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toMatch(/^The page kept changing under the click/);
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
  });

  it('leaves a question for the caller as it is, whatever the checks say', async () => {
    const { ask } = scriptedJev([{ operation: 'BLOCKED', done_check: 0.6 }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [onStays], changeWaitMs: 0 }).run();
    expect(summary.status).toBe('needs_input');
    expect(summary.checks?.[0].pass).toBe(true);
  });

  it("never sends the checks to Jev", async () => {
    const { ask, requests, evidenceRequests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [{ type: 'text_absent', text: 'zebra-crossing' }], changeWaitMs: 0 }).run();
    expect(evidenceRequests).toHaveLength(1);
    expect(JSON.stringify([...requests, ...evidenceRequests])).not.toContain('zebra-crossing');
  });

  it('keeps the checks for the session until a call replaces them', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab();
    const task = new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [confirmed], changeWaitMs: 0 });
    expect((await task.run()).status).toBe('uncertain');
    task.update({ goal: 'Book again' });
    expect((await task.run()).status).toBe('uncertain');
    task.update({ checks: [] });
    const cleared = await task.run();
    expect(cleared.status).toBe('done');
    expect(cleared).not.toHaveProperty('checks');
  });
});

describe('a done carries the page quote that proves it', () => {
  const CONFIRMATION = 'Staylist\nBooking confirmed\nReference JV-1042. A receipt is on its way.';
  const confirmedPage = (fingerprint = 'confirmed') => page({ text: CONFIRMATION, url: 'http://fixture/stays#booking', fingerprint });
  /** Answers the evidence question as given, and every other question as the script says. */
  const withEvidence =
    (ask: Ask, evidence: { choice: string; confidence: number } | Error): Ask =>
    async (request) => {
      const question: any = request.questions.evidence;
      if (!question) return ask(request);
      if (evidence instanceof Error) throw evidence;
      const ids = Object.keys(question.criteria);
      return { answers: { evidence: answer(evidence.choice, ids, evidence.confidence) }, usage: { input_tokens: 40 } };
    };

  it('asks Jev once which span shows done_when, offering the spans and absent last', async () => {
    const { ask, requests, evidenceRequests } = scriptedJev([{ operation: 'DONE', done_check: 0.9, evidence: '3' }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, { goal: 'Book', doneWhen: 'A booking reference is showing', changeWaitMs: 0 }).run();
    expect(requests).toHaveLength(1);
    expect(evidenceRequests).toHaveLength(1);
    const question: any = evidenceRequests[0].questions.evidence;
    expect(Object.keys(evidenceRequests[0].questions)).toEqual(['evidence']);
    expect(evidenceRequests[0].state).toEqual({ page: { url: 'http://fixture/stays#booking', title: 'Staylist' } });
    expect(question.criteria).toMatchObject({ '1': 'Staylist', '2': 'Booking confirmed', '3': 'Reference JV-1042.', '4': 'A receipt is on its way.' });
    expect(Object.keys(question.criteria).at(-1)).toBe('absent');
    expect(JSON.stringify(question.instructions)).toContain('A booking reference is showing');
    expect(summary.status).toBe('done');
    expect(summary.evidence).toEqual({
      quote: 'Reference JV-1042.',
      url: 'http://fixture/stays#booking',
      deep_link: 'http://fixture/stays#booking:~:text=Reference%20JV%2D1042.',
      confidence: 0.95,
    });
    expect(summary.jev.requests).toBe(2);
    expect(summary.jev.input_tokens).toBe(200);
  });

  it('copies the chosen span word for word, never text Jev wrote', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9, evidence: '2' }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.evidence?.quote).toBe('Booking confirmed');
    expect(CONFIRMATION).toContain(summary.evidence!.quote);
  });

  it.each([
    ['absent', { choice: 'absent', confidence: 0.95 }],
    ['an unsure answer', { choice: '2', confidence: 0.2 }],
    ['a failed request', new Error('503 upstream')],
  ])('leaves the evidence out on %s, and the run stays done', async (_case, evidence) => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, withEvidence(ask, evidence), { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(summary.status).toBe('done');
    expect(summary).not.toHaveProperty('evidence');
  });

  it('asks nothing more without done_when, or when the run hands back', async () => {
    const plain = scriptedJev([{ operation: 'DONE' }]);
    const noDoneWhen = await new BrowserTask(fakeTab([confirmedPage()]).asTab, plain.ask, { goal: 'Book', changeWaitMs: 0 }).run();
    expect(noDoneWhen.status).toBe('done');
    expect(plain.evidenceRequests).toHaveLength(0);

    const unsure = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.2 }]);
    const handedBack = await new BrowserTask(fakeTab([confirmedPage()]).asTab, unsure.ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run();
    expect(handedBack.status).toBe('uncertain');
    expect(unsure.evidenceRequests).toHaveLength(0);
    expect(handedBack).not.toHaveProperty('evidence');
  });

  it("quotes a done the caller's checks reached too", async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', confidence: 0.1, done_check: 0.6, evidence: '2' }]);
    const summary = await new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, {
      goal: 'Book',
      doneWhen: 'x',
      checks: [{ type: 'text_contains', text: 'Booking confirmed' }],
      changeWaitMs: 0,
    }).run();
    expect(summary.status).toBe('done');
    expect(summary.evidence?.quote).toBe('Booking confirmed');
  });

  it('records the evidence request in the trace with its cost', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9, evidence: '2' }]);
    const task = new BrowserTask(fakeTab([confirmedPage()]).asTab, ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 });
    await task.run();
    expect(task.trace.at(-1)).toMatchObject({ decision: { operation: 'EVIDENCE', confidence: 0.95, inputTokens: 100, requests: 1 }, executed: false });
  });
});

describe('stops that are final stay final, whatever the caller checks say', () => {
  // Every check passes and done_when scored 0.6 on the page the run stopped on: enough to finish a progress guard's stop.
  const passing = [{ type: 'url_contains', text: '/' }] as const;

  it('keeps a cancel that came between the decision and its input blocked', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { tab, asTab } = fakeTab();
    const controller = new AbortController();
    // The cancel lands while the click is refused as covered: the run stops at the check before the popup is closed.
    tab.act = async () => {
      controller.abort();
      throw new TargetUnreachable('covered', true, []);
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [...passing], changeWaitMs: 0 }).run({ signal: controller.signal });
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
    expect(summary).toMatchObject({ status: 'blocked', reason: 'Cancelled by the caller' });
  });

  it('keeps a stop for leaving the hosts blocked', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1', done_check: 0.6 }]);
    const { asTab } = fakeTab([page(), page({ url: 'https://partner.example/offer', fingerprint: 'partner' })]);
    const hosts = { allowed: ['fixture'], blocked: [] };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [...passing], hosts, changeWaitMs: 0 }).run();
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toContain("outside this run's hosts");
  });

  it('keeps a bot wall blocked', async () => {
    const wall = page({
      url: 'https://www.npmjs.com/',
      title: 'Just a moment...',
      text: 'www.npmjs.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots.\nRay ID:\na4c627515b445548\nPerformance and Security by\nCloudflare',
      actions: [{ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }],
      fingerprint: 'wall',
    });
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const { tab, asTab } = fakeTab([page(), wall]);
    tab.fresh = async () => false;
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', doneWhen: 'x', checks: [...passing], changeWaitMs: 0, wallWaitMs: 0 }).run();
    expect(summary.checks?.every((check) => check.pass)).toBe(true);
    expect(summary.status).toBe('blocked');
    expect(summary.wall).toMatchObject({ kind: 'bot_check' });
  });
});

describe("the done's evidence request", () => {
  const TOKEN = 'tok Zq/81x';
  const tokenPage = page({ text: `Staylist\nBooking confirmed with token ${TOKEN}\nReference JV-1042.`, url: 'http://fixture/stays#booking' });

  it('never carries a secret, and neither does the evidence, the checks or the trace it returns', async () => {
    const { ask, evidenceRequests } = scriptedJev([{ operation: 'DONE', done_check: 0.95, evidence: '2' }]);
    const task = new BrowserTask(fakeTab([tokenPage]).asTab, ask, {
      goal: 'Book',
      doneWhen: 'Booking confirmed',
      values: { token: TOKEN },
      secretKeys: ['token'],
      checks: [{ type: 'text_contains', text: TOKEN }],
      changeWaitMs: 0,
    });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(evidenceRequests).toHaveLength(1);
    expect(summary.evidence?.quote).toContain('[secret:token]');
    for (const output of [evidenceRequests, summary, task.trace]) expect(JSON.stringify(output).toLowerCase()).not.toContain('zq/81x');
  });

  it('is cancelled with the run, and the run stays done without evidence', async () => {
    const scripted = scriptedJev([{ operation: 'DONE', done_check: 0.95 }]);
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    // The evidence request never answers, whatever its signal does: the run must not wait for it.
    const ask: Ask = (request, options) => {
      if (!request.questions.evidence) return scripted.ask(request);
      signals.push(options?.signal);
      setTimeout(() => controller.abort(), 50);
      return new Promise(() => undefined);
    };
    const started = performance.now();
    const summary = await new BrowserTask(fakeTab([tokenPage]).asTab, ask, { goal: 'Book', doneWhen: 'x', changeWaitMs: 0 }).run({ signal: controller.signal });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(summary.status).toBe('done');
    expect(summary).not.toHaveProperty('evidence');
    expect(signals[0]?.aborted).toBe(true);
  });
});
