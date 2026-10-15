import { afterEach, describe, expect, it, vi } from 'vitest';
import { StalePage, type PageAction, type PageState, type Tab } from '../src/browser/tab.ts';
import { buildActionSpace } from '../src/jev/action-space.ts';
import { buildRequest, decide, NO_SUPPLIED_VALUE, readDecision, validChoice, type Ask } from '../src/jev/decide.ts';
import { matchTarget, overlap, readBox, toViewportRect } from '../src/jev/box.ts';
import { resolveModel } from '../src/jev/model.ts';
import { BrowserTask } from '../src/task/run-task.ts';

const NAME_RECT = { x: 20, y: 100, w: 350, h: 40 };
const PAY_RECT = { x: 20, y: 700, w: 350, h: 48 };
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
  const ask: Ask = async (request) => {
    requests.push(request);
    const script = steps[Math.min(requests.length - 1, steps.length - 1)];
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
  return { ask, requests };
};

const fakeTab = (pages: PageState[] = [page()]) => {
  const acted: { label: string; text?: string }[] = [];
  let observed = 0;
  const tab = {
    staleOnce: false,
    screenshots: 0,
    clicksAt: [] as { x: number; y: number }[],
    clickAt: async (point: { x: number; y: number }) => {
      tab.clicksAt.push(point);
      return 'canvas';
    },
    markedScreenshot: async () => {
      tab.screenshots++;
      return 'SCREENSHOT';
    },
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

  it('scores the ranked taps for the autopilot, and a malformed score counts as risky', async () => {
    const ask: Ask = async (request) => {
      if (!('operation' in request.questions)) return { answers: { risk_1: { noul: 0.1 } }, usage: { input_tokens: 1 } };
      return scriptedJev([{ operation: 'WAIT' }]).ask(request);
    };
    const decision = await decide(ask, { ...input, elementRisk: 'ranked' });
    expect(decision.elementRisks).toEqual({ '1': 0.1, '4': 1 });
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
});

describe('Box in the task loop', () => {
  const boxed = { goal: 'Pay', screenshots: 'always' as const, imageTransport: 'assets' as const, box: true };
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
    const off = scriptedJev([canvasOnly]);
    const offTab = fakeTab([noFields()]);
    expect((await new BrowserTask(offTab.asTab, off.ask, boxed).run()).status).toBe('blocked');
    expect(offTab.tab.clicksAt).toEqual([]);

    const on = scriptedJev([canvasOnly, { operation: 'DONE' }]);
    const onTab = fakeTab([noFields({ fingerprint: 'a' }), noFields({ fingerprint: 'b' })]);
    const summary = await new BrowserTask(onTab.asTab, on.ask, { ...boxed, allowCoordinateClicks: true }).run();
    expect(onTab.tab.clicksAt).toHaveLength(1);
    expect(onTab.tab.clicksAt[0].x).toBeCloseTo(150);
    expect(onTab.tab.clicksAt[0].y).toBeCloseTo(425);
    expect(summary.steps[0]).toMatchObject({ operation: 'CLICK_AT', element: 'canvas @ 150,425' });
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
