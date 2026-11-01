import { describe, expect, it } from 'vitest';
import {
  FRAME_ID_STRIDE,
  framePlacement,
  idBaseFor,
  idBaseOf,
  mergeFrames,
  placeFrameActions,
  type FrameSnapshot,
} from '../src/browser/frames.ts';
import type { PageAction } from '../src/browser/tab.ts';

const click = (node: number, label: string, rect = { x: 10, y: 10, w: 80, h: 20 }): PageAction => ({
  id: `e${node}`,
  kind: 'click',
  role: 'button',
  node,
  label,
  rect,
});
const pageControls: PageAction[] = [
  { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
];
const mainState = (overrides: Record<string, unknown> = {}) => ({
  url: 'http://shop.test/checkout',
  title: 'Checkout',
  w: 1000,
  h: 800,
  text: 'Checkout\nPay with card',
  passwordFields: [] as { name: string; filled: boolean }[],
  actions: [click(1, 'Back to cart'), click(2, 'Place order'), ...pageControls],
  marker: ['main'],
  page_key: ['main-key'],
  guards: { 1: ['g1'], 2: ['g2'] } as Record<string, unknown>,
  omitted_actions: 0,
  ...overrides,
});
const frameSnapshot = (overrides: Partial<FrameSnapshot> = {}): FrameSnapshot => ({
  id: 'FRAME-A',
  label: 'Card details',
  actions: [click(FRAME_ID_STRIDE + 1, 'Card number'), click(FRAME_ID_STRIDE + 2, 'Pay')],
  text: 'Card number\nPay',
  passwordFields: [],
  page_key: ['frame-key'],
  identity: [123, 'https://pay.test/card'],
  guards: { [FRAME_ID_STRIDE + 1]: ['f1'], [FRAME_ID_STRIDE + 2]: ['f2'] },
  omitted_actions: 0,
  ...overrides,
});

describe('frame ids', () => {
  it('gives each frame its own id range, the main frame keeping today ids', () => {
    expect(idBaseFor(0)).toBe(0);
    expect(idBaseFor(3)).toBe(3 * FRAME_ID_STRIDE);
    expect(idBaseOf(42)).toBe(0);
    expect(idBaseOf(2 * FRAME_ID_STRIDE + 42)).toBe(2 * FRAME_ID_STRIDE);
  });
});

describe('frame placement', () => {
  it('adds a frame offset to the viewport, compounding through a nested frame', () => {
    const placement = framePlacement(
      [
        { origin: { x: 100, y: 50 }, clip: { x: 100, y: 50, w: 600, h: 400 } },
        { origin: { x: 20, y: 30 }, clip: { x: 20, y: 30, w: 300, h: 200 } },
      ],
      { w: 1000, h: 800 },
    );
    expect(placement.offset).toEqual({ x: 120, y: 80 });
    expect(placement.region).toEqual({ x: 120, y: 80, w: 300, h: 200 });
  });

  it('clips a frame by its parent and the viewport, so a frame half below the fold shows only its top half', () => {
    const placement = framePlacement([{ origin: { x: 0, y: 600 }, clip: { x: 0, y: 600, w: 500, h: 200 } }], { w: 1000, h: 800 });
    const nested = framePlacement(
      [
        { origin: { x: 0, y: 600 }, clip: { x: 0, y: 600, w: 500, h: 200 } },
        { origin: { x: 0, y: 150 }, clip: { x: 0, y: 150, w: 400, h: 300 } },
      ],
      { w: 1000, h: 800 },
    );
    expect(placement.region).toEqual({ x: 0, y: 600, w: 500, h: 200 });
    // The inner frame starts 750 px down: only 50 px of it are inside the outer frame's visible part.
    expect(nested.region).toEqual({ x: 0, y: 750, w: 400, h: 50 });
  });

  it('moves frame actions into viewport coordinates and records the frame', () => {
    const placed = placeFrameActions(
      [click(FRAME_ID_STRIDE + 1, 'Pay', { x: 10, y: 20, w: 80, h: 30 })],
      { w: 600, h: 400 },
      { offset: { x: 100, y: 50 }, region: { x: 100, y: 50, w: 600, h: 400 } },
      'FRAME-A',
    );
    expect(placed).toEqual([expect.objectContaining({ label: 'Pay', frame: 'FRAME-A', rect: { x: 110, y: 70, w: 80, h: 30 } })]);
  });

  it('drops frame controls hidden by the parent, keeps ones listed off-screen inside the frame, and drops the frame page controls', () => {
    const placed = placeFrameActions(
      [
        click(FRAME_ID_STRIDE + 1, 'Visible', { x: 10, y: 10, w: 80, h: 20 }),
        // Inside the frame's own viewport, but below the fold of the page.
        click(FRAME_ID_STRIDE + 2, 'Below the fold', { x: 10, y: 300, w: 80, h: 20 }),
        // Off-screen inside the frame: listed by the reader only as a wanted value, kept for a click that scrolls it in.
        click(FRAME_ID_STRIDE + 3, 'Wanted row', { x: 10, y: 900, w: 80, h: 20 }),
        ...pageControls,
      ],
      { w: 600, h: 400 },
      { offset: { x: 0, y: 600 }, region: { x: 0, y: 600, w: 600, h: 200 } },
      'FRAME-A',
    );
    expect(placed.map((action) => action.label)).toEqual(['Visible', 'Wanted row']);
  });
});

describe('merging frames into the page', () => {
  it('continues the element ids across frames and keeps the page controls last', () => {
    const merged = mergeFrames(mainState(), [frameSnapshot()]);
    expect(merged.actions.map((action) => [action.id, action.label])).toEqual([
      ['e1', 'Back to cart'],
      ['e2', 'Place order'],
      ['e3', 'Card number'],
      ['e4', 'Pay'],
      ['scroll_down', 'Scroll down'],
      ['wait', 'Wait for the page to update'],
    ]);
    expect(merged.guards).toEqual({ 1: ['g1'], 2: ['g2'], [FRAME_ID_STRIDE + 1]: ['f1'], [FRAME_ID_STRIDE + 2]: ['f2'] });
    expect(merged.frames).toEqual([{ id: 'FRAME-A', page_key: ['frame-key'], identity: [123, 'https://pay.test/card'] }]);
  });

  it('counts frame actions against the 250 cap', () => {
    const many = Array.from({ length: 249 }, (_, i) => click(i + 1, `Item ${i + 1}`));
    const merged = mergeFrames(mainState({ actions: [...many, ...pageControls] }), [frameSnapshot()]);
    expect(merged.actions.filter((action) => action.node !== undefined)).toHaveLength(250);
    expect(merged.actions.at(-3)?.label).toBe('Card number');
    expect(merged.omitted_actions).toBe(1);
  });

  it('appends each frame text under a header naming the frame', () => {
    const merged = mergeFrames(mainState(), [frameSnapshot()]);
    expect(merged.text).toBe('Checkout\nPay with card\n[Frame: Card details]\nCard number\nPay');
  });

  it('keeps the text within 6000 characters, leaving frames at least 1000', () => {
    const long = 'x'.repeat(5990);
    const frameText = 'y'.repeat(3000);
    const merged = mergeFrames(mainState({ text: long }), [frameSnapshot({ text: frameText })]);
    expect(merged.text.length).toBe(6000);
    expect(merged.text).toContain('[Frame: Card details]\n' + 'y'.repeat(900));
    expect(merged.text.startsWith('x'.repeat(4900))).toBe(true);
  });

  it('leaves the main text untouched when no frame has text', () => {
    const state = mainState({ text: 'z'.repeat(6000) });
    expect(mergeFrames(state, [frameSnapshot({ text: '' })]).text).toBe(state.text);
  });

  it('puts a frame password field first, as filled or empty only', () => {
    const merged = mergeFrames(
      mainState({
        text: 'Password field "Account password": empty (passwords are typed by the user, not by you)\nCheckout',
        passwordFields: [{ name: 'Account password', filled: false }],
      }),
      [
        frameSnapshot({
          text: 'Password field "Card PIN": filled (passwords are typed by the user, not by you)\nCard number',
          passwordFields: [{ name: 'Card PIN', filled: true }],
        }),
      ],
    );
    expect(merged.passwordFields).toEqual([
      { name: 'Account password', filled: false },
      { name: 'Card PIN', filled: true },
    ]);
    expect(merged.text.split('\n').slice(0, 4)).toEqual([
      'Password field "Account password": empty (passwords are typed by the user, not by you)',
      'Password field "Card PIN": filled',
      'Checkout',
      '[Frame: Card details]',
    ]);
  });

  it('describes at most 5 password fields in all', () => {
    const fields = (prefix: string) => Array.from({ length: 4 }, (_, i) => ({ name: `${prefix} ${i}`, filled: false }));
    const lines = (list: { name: string }[]) => list.map((field) => `Password field "${field.name}": empty`).join('\n');
    const merged = mergeFrames(mainState({ text: lines(fields('Main')), passwordFields: fields('Main') }), [
      frameSnapshot({ text: lines(fields('Frame')), passwordFields: fields('Frame') }),
    ]);
    expect(merged.passwordFields).toHaveLength(5);
    expect(merged.text.split('\n').filter((line) => line.startsWith('Password field'))).toHaveLength(5);
  });
});
