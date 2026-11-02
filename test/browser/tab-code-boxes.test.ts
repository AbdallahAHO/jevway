import { describe, expect, it } from 'vitest';
import type { CdpConnection } from '../../src/browser/cdp.ts';
import { StalePage, Tab, type PageAction, type PageState } from '../../src/browser/tab.ts';

const CODE = '739214';

/**
 * A page with six one-character boxes (nodes 11–16) and a Verify button, as the reader reports it, driven over a fake
 * protocol connection: a press focuses the box it lands on, a typed key sets the focused box (when `keeps` allows), and
 * `autoAdvance` moves the focus on as pages' scripts do. Every key typed is recorded with the box it went into.
 */
const codePage = ({ autoAdvance = false, keeps = (_box: number, _char: string) => true, prefilled = {} as Record<number, string> } = {}) => {
  const nodes = [11, 12, 13, 14, 15, 16];
  const values = nodes.map((_, i) => prefilled[i] ?? '');
  let focused = -1;
  let presses = 0;
  /** Bumped when the page re-renders its boxes as new elements (new node ids). */
  let generation = 0;
  const typed: [box: number, char: string][] = [];
  const idOf = (i: number) => nodes[i] + generation * 100;
  const state = () => ({
    url: 'http://fixture/verify',
    title: 'Verify your email',
    text: 'Enter the 6-digit code we sent you',
    w: 1120,
    h: 780,
    actions: [
      ...nodes.flatMap((_, i) => {
        const base = { node: idOf(i), role: 'textbox', label: `Digit ${i + 1}`, value: values[i], rect: { x: 100 + i * 52, y: 200, w: 44, h: 52 } };
        const box = { max: 1, mode: 'numeric', otp: i === 0, type: 'text', form: 0, within: [60, 61], name: 'Verification code' };
        return [
          { ...base, id: '', kind: 'fill', box },
          { ...base, id: '', kind: 'click', label: `Open ${base.label}` },
        ];
      }),
      { id: '', kind: 'click', node: 30, role: 'button', label: 'Verify', rect: { x: 100, y: 280, w: 120, h: 40 } },
      { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
    ].map((action, i) => (action.node === undefined ? action : { ...action, id: `e${i + 1}` })),
    marker: ['M', ...values],
    page_key: ['K', generation, ...values],
    guards: Object.fromEntries([...nodes.map((_, i) => [idOf(i), ['G', idOf(i), values[i]]]), [30, ['G', 30]]]),
    omitted_actions: 0,
  });
  const nodeIn = (expression: string) => Number(/nodes\.get\((\d+)\)/.exec(expression)?.[1]);
  const send = async (method: string, params: any = {}) => {
    if (method === 'Target.attachToTarget') return { sessionId: 'S-T1' };
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') presses++;
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.text) {
      typed.push([focused, params.text]);
      if (focused >= 0 && keeps(focused, params.text)) values[focused] = params.text;
      if (autoAdvance && focused < nodes.length - 1) focused++;
    }
    if (method !== 'Runtime.evaluate') return {};
    const expression = String(params.expression);
    if (expression.includes('__jevWanted')) return { result: { value: state() } };
    if (expression.includes('c.pageKey()')) {
      const node = nodeIn(expression);
      return { result: { value: [state().page_key, state().guards[node] ?? null] } };
    }
    // The target resolves to its box's centre; the press that follows focuses it.
    const resolve = /\)\((\{.*\})\)$/s.exec(expression);
    if (resolve && expression.includes('clickRect')) {
      const action = JSON.parse(resolve[1]);
      const i = nodes.findIndex((_, index) => idOf(index) === action.node);
      if (i < 0) return { result: { value: null } };
      if (action.kind === 'fill') focused = i;
      return { result: { value: { x: 122 + i * 52, y: 226 } } };
    }
    if (expression.includes('__jevInput === undefined')) return { result: { value: `T:${presses}` } };
    if (expression.includes('jevBoxValues')) {
      const ids: number[] = JSON.parse(/\[(\d[\d,]*)\]/.exec(expression)![0]);
      return { result: { value: ids.map((id) => (nodes.some((_, i) => idOf(i) === id) ? values[nodes.findIndex((_, i) => idOf(i) === id)] : null)) } };
    }
    if (expression.includes('getAnimations')) return { result: { value: 0 } };
    return { result: {} };
  };
  const cdp = { send, onEvent: () => () => true } as unknown as CdpConnection;
  return {
    cdp,
    typed,
    values,
    presses: () => presses,
    rerender: () => {
      generation++;
    },
  };
};

const groupOf = (page: PageState) => page.actions.find((action) => action.kind === 'fill' && action.boxes) as PageAction;

describe('typing a code into a group of one-character boxes', () => {
  it('reads the six boxes as one target, and types one character into each box in turn', async () => {
    const fake = codePage();
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    const fields = page.actions.filter((action) => action.kind === 'fill');
    expect(fields).toEqual([expect.objectContaining({ node: 11, label: 'Verification code (6 boxes)', boxes: [11, 12, 13, 14, 15, 16] })]);
    const outcome = await tab.act(groupOf(page), page, CODE);
    expect(fake.typed).toEqual([...CODE].map((char, i) => [i, char]));
    expect(fake.values.join('')).toBe(CODE);
    expect(fake.presses()).toBe(6);
    expect(outcome).toEqual({ kept: true });
  });

  it('types each character once on a page that moves the focus on by itself', async () => {
    const fake = codePage({ autoAdvance: true });
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    await tab.act(groupOf(page), page, CODE);
    expect(fake.typed.map(([, char]) => char).join('')).toBe(CODE);
    expect(fake.values.join('')).toBe(CODE);
  });

  it('skips a box that already holds its character, and types nothing twice', async () => {
    const fake = codePage({ prefilled: { 0: '7', 3: '2' } });
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    await tab.act(groupOf(page), page, CODE);
    expect(fake.typed).toEqual([
      [1, '3'],
      [2, '9'],
      [4, '1'],
      [5, '4'],
    ]);
    expect(fake.values.join('')).toBe(CODE);
  });

  it('takes spaces out of a code that fits the boxes only without them', async () => {
    const fake = codePage();
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    await tab.act(groupOf(page), page, '739 214');
    expect(fake.values.join('')).toBe(CODE);
  });

  it('reports kept: false when the boxes do not end up holding the code', async () => {
    const fake = codePage({ keeps: (box) => box !== 3 });
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    expect(await tab.act(groupOf(page), page, CODE)).toEqual({ kept: false });
  });

  it('types nothing into a code that does not fit the boxes', async () => {
    const fake = codePage();
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    await expect(tab.act(groupOf(page), page, '73921')).rejects.toThrow(/5 characters.*6 boxes/);
    expect(fake.typed).toEqual([]);
  });

  it('stops as a changed page when the boxes are replaced while it types', async () => {
    const fake = codePage({ keeps: (box) => (box === 1 ? (fake.rerender(), true) : true) });
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    await expect(tab.act(groupOf(page), page, CODE)).rejects.toThrow(StalePage);
    expect(fake.typed.map(([box]) => box)).toEqual([0, 1]);
  });

  it('types nothing on a page that changed since the decision', async () => {
    const fake = codePage();
    const tab = await Tab.attach(fake.cdp, 'T1');
    const page = await tab.observe();
    fake.values[5] = '0';
    await expect(tab.act(groupOf(page), page, CODE)).rejects.toThrow(StalePage);
    expect(fake.typed).toEqual([]);
  });
});
