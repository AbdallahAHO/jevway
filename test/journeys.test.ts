import { describe, expect, it } from 'vitest';
import type { PageAction, PageState } from '../src/browser/tab.ts';
import { buildActionSpace } from '../src/jev/action-space.ts';
import type { Decision } from '../src/jev/decide.ts';
import { buildFlows, hotspotOf, type JourneyStep } from '../src/journeys/journey-doc.ts';
import { pickNextMove } from '../src/journeys/pick-next-move.ts';
import { qaFindings, readScreenJudgments, type ScreenJudgments } from '../src/journeys/screen-judgments.ts';

const actions: PageAction[] = [
  { id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Where to?', rect: { x: 16, y: 80, w: 361, h: 52 } },
  { id: 'e2', kind: 'click', node: 2, role: 'button', label: 'button', rect: { x: 340, y: 150, w: 22, h: 22 } },
  { id: 'e3', kind: 'click', node: 3, role: 'link', label: 'Casa Flora', rect: { x: 16, y: 400, w: 361, h: 44 } },
  { id: 'e4', kind: 'click', node: 4, role: 'button', label: 'Reserve', rect: { x: 16, y: 700, w: 361, h: 52 } },
  { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
];

const page: PageState = {
  url: 'https://nestly.test/#/',
  title: 'Nestly',
  text: 'Popular this week',
  w: 393,
  h: 852,
  actions,
  marker: 1,
  page_key: 1,
  guards: {},
  omitted_actions: 0,
  fingerprint: 'x',
};

const judgments = (overrides: Partial<ScreenJudgments> = {}): ScreenJudgments => ({
  type: 'home',
  typeConfidence: 0.9,
  patterns: [],
  sameAs: null,
  authWall: 0.02,
  errorState: 0.01,
  emptyState: 0.01,
  deadEnd: 0.01,
  ...overrides,
});

const decision = (clickProbabilities: Record<string, number>, overrides: Partial<Decision> = {}): Decision => ({
  operation: 'CLICK',
  confidence: 0.9,
  candidates: [],
  fieldsWithoutValue: [],
  answers: { click_target: { probabilities: clickProbabilities } },
  requests: 1,
  inputTokens: 1,
  latencyMs: 1,
  ...overrides,
});

const step = (from: string, to: string, flow: string, label: string): JourneyStep => ({
  from,
  to,
  flow,
  action: { operation: 'CLICK', label },
  hotspot: null,
  by: 'agent',
});

describe('journey document', () => {
  it('normalizes the tapped element into a 0–1 hotspot', () => {
    expect(hotspotOf(actions[0], page)).toEqual({ x: 16 / 393, y: 80 / 852, width: 361 / 393, height: 52 / 852 });
  });

  it('chains steps into flows and nests "Parent/Child" names', () => {
    const flows = buildFlows([
      step('s01', 's02', 'Homes/Searching homes', 'Where to?'),
      step('s02', 's03', 'Homes/Searching homes', 'Search'),
      step('s03', 's04', 'Homes/Home details', 'Casa Flora'),
    ]);
    expect(flows.map((flow) => [flow.name, flow.parent, flow.screens.map((s) => s.screen)])).toEqual([
      ['Homes/Searching homes', 'Homes', ['s01', 's02', 's03']],
      ['Homes/Home details', 'Homes', ['s03', 's04']],
      ['Homes', null, []],
    ]);
    expect(flows[0].screens[0].action).toBe('Tap "Where to?"');
    expect(flows[0].screens[2].action).toBeUndefined();
  });
});

it('merges in-place interactions into one screen card', () => {
  const [flow] = buildFlows([
    step('s01', 's02', 'Search', 'Where to?'),
    {
      ...step('s02', 's02', 'Search', 'Destination'),
      action: { operation: 'TYPE_TEXT', label: 'Destination', value: 'Lis' },
    },
    step('s02', 's02', 'Search', 'Lisbon, Portugal'),
    step('s02', 's03', 'Search', 'Search'),
  ]);
  expect(flow.screens).toEqual([
    { screen: 's01', action: 'Tap "Where to?"' },
    { screen: 's02', action: 'Type into "Destination" → "Lis", then Tap "Lisbon, Portugal", then Tap "Search"' },
    { screen: 's03' },
  ]);
});

describe('autopilot policy', () => {
  const space = buildActionSpace(actions);

  it("follows Jev's ranking and skips taps already tried on this screen", () => {
    const ranked = decision({ '1': 0.6, '3': 0.3, '2': 0.05, '4': 0.05 }, { action: actions[0] });
    const move = pickNextMove({
      decision: ranked,
      judgments: judgments(),
      space,
      tried: new Set(['CLICK:Where to?']),
      hasIntent: false,
    });
    expect(move).toMatchObject({ move: 'act', key: 'CLICK:Casa Flora' });
  });

  it('skips an irreversible top tap while exploring, but stops an intent run on it', () => {
    const risky = decision({ '4': 0.8, '1': 0.2, '2': 0, '3': 0 }, { action: actions[3], commitRisk: 0.9 });
    const input = { decision: risky, judgments: judgments(), space, tried: new Set<string>() };
    expect(pickNextMove({ ...input, hasIntent: false })).toEqual({
      move: 'skip_risky',
      key: 'CLICK:Reserve',
      label: 'Reserve',
    });
    expect(pickNextMove({ ...input, hasIntent: true })).toEqual({ stop: 'irreversible_action', detail: 'Reserve' });
  });

  it('stops at auth walls, scrolls once when taps run out, then backs out', () => {
    const exhausted = decision({ '1': 1, '2': 0, '3': 0, '4': 0 });
    const allTried = new Set(['CLICK:Where to?', 'CLICK:button', 'CLICK:Casa Flora', 'CLICK:Reserve']);
    expect(
      pickNextMove({
        decision: exhausted,
        judgments: judgments({ type: 'auth' }),
        space,
        tried: allTried,
        hasIntent: false,
      }),
    ).toEqual({ stop: 'auth_wall' });
    expect(
      pickNextMove({ decision: exhausted, judgments: judgments(), space, tried: allTried, hasIntent: false }),
    ).toMatchObject({ move: 'act', key: 'SCROLL_DOWN' });
    allTried.add('SCROLL_DOWN');
    expect(
      pickNextMove({ decision: exhausted, judgments: judgments(), space, tried: allTried, hasIntent: false }),
    ).toEqual({ move: 'back' });
  });
});

describe('screen QA', () => {
  it('reports diagnostics, overflow, small and unlabeled controls, and confident Jev states', () => {
    const findings = qaFindings(
      page,
      {
        consoleErrors: ['TypeError: reviews is undefined'],
        failedRequests: [{ url: 'https://nestly.test/missing.jpg', status: 404 }],
      },
      judgments({ emptyState: 0.8, deadEnd: 0.3 }),
      127,
      true,
    );
    expect(findings.map((finding) => [finding.kind, finding.severity])).toEqual([
      ['console_error', 'medium'],
      ['failed_request', 'low'],
      ['horizontal_overflow', 'high'],
      ['small_tap_target', 'medium'],
      ['unlabeled_control', 'medium'],
      ['empty_state', 'low'],
    ]);
    expect(findings[3].detail).toContain('"button" 22×22');
  });

  it('reads screen judgments and only trusts a confident duplicate match', () => {
    const base = {
      screen_type: { choice: 'results', confidence: 0.8 },
      pattern_card_list: { noul: 0.9 },
      pattern_map_view: { noul: 0.2 },
      auth_wall: { noul: 0.1 },
      error_state: { noul: 0 },
      empty_state: { noul: 0 },
      dead_end: { noul: 0 },
    };
    const weak = readScreenJudgments({
      ...base,
      same_screen: { choice: 's02', probabilities: { s02: 0.55, NEW_SCREEN: 0.45 } },
    });
    expect(weak).toMatchObject({ type: 'results', patterns: ['card_list'], sameAs: null });
    const strong = readScreenJudgments({
      ...base,
      same_screen: { choice: 's02', probabilities: { s02: 0.92, NEW_SCREEN: 0.08 } },
    });
    expect(strong.sameAs).toBe('s02');
  });
});
