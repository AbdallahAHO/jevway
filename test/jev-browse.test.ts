import { describe, expect, it } from 'vitest';
import { StalePage, type PageAction, type PageState, type Tab } from '../src/browser/tab.ts';
import { buildActionSpace } from '../src/jev/action-space.ts';
import { buildRequest, NO_SUPPLIED_VALUE, validChoice, type Ask } from '../src/jev/decide.ts';
import { BrowserTask } from '../src/task/run-task.ts';

// A booking form as the snapshot reports it: two text fields, a native select, a pay button.
const bookingActions: PageAction[] = [
  { id: 'e1', kind: 'fill', node: 1, role: 'textbox', label: 'Full name', value: '' },
  { id: 'e2', kind: 'click', node: 1, role: 'textbox', label: 'Open Full name', value: '' },
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
  { id: 'e5', kind: 'click', node: 4, role: 'button', label: 'Confirm booking and pay €412', value: '' },
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

const answer = (choice: string, ids: string[], confidence = 0.95) => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
});

/** Answers every question in a request with the scripted choice for that step, or its first option. */
const scriptedJev = (steps: Record<string, string | number>[]) => {
  const requests: any[] = [];
  const ask: Ask = async (request) => {
    requests.push(request);
    const script = steps[Math.min(requests.length - 1, steps.length - 1)];
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]: [string, any]) => {
        if (question.type === 'noul') return [id, { type: 'noul', noul: script[id] ?? 0 }];
        const ids = Object.keys(question.criteria);
        return [id, answer(String(script[id] ?? ids[0]), ids)];
      }),
    );
    return { answers, usage: { input_tokens: 100 } };
  };
  return { ask, requests };
};

const fakeTab = (pages: PageState[] = [page()]) => {
  const acted: { label: string; text?: string }[] = [];
  let observed = 0;
  const tab = {
    staleOnce: false,
    observe: async () => pages[Math.min(observed++, pages.length - 1)],
    fresh: async () => true,
    act: async (action: PageAction, _page: PageState, text?: string) => {
      if (tab.staleOnce) {
        tab.staleOnce = false;
        throw new StalePage('moved');
      }
      acted.push({ label: action.label, ...(text && { text }) });
    },
  };
  return { tab, acted, asTab: tab as unknown as Tab };
};

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
      'select_target',
      'commit_risk',
    ]);
    const withValues = buildRequest({ ...input, values: { email: 'a@b.co' }, doneWhen: 'Confirmed' }, space);
    expect(withValues.questions).toHaveProperty('value_for_1');
    expect(withValues.questions).toHaveProperty('done_check');
    expect(Object.keys((withValues.questions.value_for_2 as any).criteria)).toEqual(['email', NO_SUPPLIED_VALUE]);
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
    });
    const summary = await task.run();
    expect(summary.status).toBe('done');
    expect(acted).toEqual([{ label: 'Email address', text: 'ada@example.com' }]);
  });

  it('hands back needs_input instead of inventing a value', async () => {
    const { ask } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: NO_SUPPLIED_VALUE }]);
    const { asTab, acted } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' } }).run();
    expect(summary.status).toBe('needs_input');
    expect(summary.reason).toContain('Email address');
    expect(acted).toEqual([]);
  });

  it('turns BLOCKED on empty fields without values into needs_input naming them', async () => {
    const { ask } = scriptedJev([{ operation: 'BLOCKED', value_for_1: 'name', value_for_2: NO_SUPPLIED_VALUE }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Book', values: { name: 'Ada' } }).run();
    expect(summary).toMatchObject({ status: 'needs_input', reason: 'Blocked: no supplied value for "Email address"' });
  });

  it('gates an irreversible click until the agent confirms, then allows exactly one', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '4', commit_risk: 0.9 }]);
    const { asTab, acted } = fakeTab([
      page({ fingerprint: 'a' }),
      page({ fingerprint: 'b' }),
      page({ fingerprint: 'c' }),
    ]);
    const task = new BrowserTask(asTab, ask, { goal: 'Pay', maxSteps: 2 });

    expect((await task.run()).status).toBe('needs_confirmation');
    expect(acted).toEqual([]);

    task.update({ confirmIrreversible: true });
    const summary = await task.run();
    expect(acted).toEqual([{ label: 'Confirm booking and pay €412' }]);
    expect(summary.status).toBe('needs_confirmation');
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
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run();
    expect(summary.status).toBe('done');
    expect(acted).toHaveLength(1);
    expect(summary.jev.requests).toBe(3);
  });

  it('stops as blocked when three actions change nothing', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { asTab } = fakeTab();
    const summary = await new BrowserTask(asTab, ask, { goal: 'Loop' }).run();
    expect(summary).toMatchObject({ status: 'blocked', reason: 'The last 3 actions did not change the page' });
    expect(summary.steps).toHaveLength(3);
  });
});
