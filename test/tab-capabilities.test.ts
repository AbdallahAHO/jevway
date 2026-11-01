import { describe, expect, it } from 'vitest';
import type { CdpConnection } from '../src/browser/cdp.ts';
import { Tab, type PageAction, type PageState } from '../src/browser/tab.ts';

/**
 * A CDP connection for one tab: `Runtime.evaluate` answers the freshness marker with 'M' and each scroll-offset read with
 * the next of `offsets` (the last one repeats); every call is recorded with its params.
 */
const fakeCdp = ({ offsets = [0] }: { offsets?: number[] } = {}) => {
  const calls: { method: string; params: any }[] = [];
  const cdp = {
    send: async (method: string, params: any = {}) => {
      calls.push({ method, params });
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params.expression);
      if (expression.includes('state?.marker')) return { result: { value: 'M' } };
      if (expression.includes('scrollTop')) return { result: { value: offsets.length > 1 ? offsets.shift() : offsets[0] } };
      return { result: {} };
    },
    onEvent: () => () => true,
  };
  return { cdp: cdp as unknown as CdpConnection, calls };
};

const PAGE = { w: 1120, h: 780, marker: 'M', actions: [] } as unknown as PageState;
const wheelsIn = (calls: { method: string; params: any }[]) =>
  calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseWheel').map((call) => call.params);

describe('a scroll aims at the area that scrolls', () => {
  it('puts the wheel on the pane the reader found, and reports how far it moved', async () => {
    const { cdp, calls } = fakeCdp({ offsets: [0, 300, 448, 448] });
    const tab = await Tab.attach(cdp, 'T1');
    const pane: PageAction = { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 448, at: { x: 700, y: 420 } };
    const outcome = await tab.act(pane, PAGE);
    expect(wheelsIn(calls)).toEqual([expect.objectContaining({ x: 700, y: 420, deltaY: 448 })]);
    expect(outcome).toEqual({ scrolled: 448 });
  });

  it('keeps the fixed point for a page whose document scrolls', async () => {
    const { cdp, calls } = fakeCdp({ offsets: [0, 560] });
    const tab = await Tab.attach(cdp, 'T1');
    await tab.act({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 }, PAGE);
    expect(wheelsIn(calls)).toEqual([expect.objectContaining({ x: 560, y: 468, deltaY: 560 })]);
  });

  it('reports 0 when the wheel moved nothing', async () => {
    const { cdp } = fakeCdp({ offsets: [120] });
    const tab = await Tab.attach(cdp, 'T1');
    const outcome = await tab.act({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 }, PAGE);
    expect(outcome).toEqual({ scrolled: 0 });
  });
});
