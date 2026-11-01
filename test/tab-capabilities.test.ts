import { describe, expect, it, vi } from 'vitest';
import type { CdpConnection } from '../src/browser/cdp.ts';
import { DEVICES } from '../src/browser/devices.ts';
import { FRAME_ID_STRIDE } from '../src/browser/frames.ts';
import { StalePage, Tab, TargetUnreachable, type PageAction, type PageState } from '../src/browser/tab.ts';

/**
 * A CDP connection for one tab: `Runtime.evaluate` answers the freshness marker with 'M' and each scroll-offset read with
 * the next of `offsets` (the last one repeats); every call is recorded with its params.
 */
const fakeCdp = ({ offsets = [0], frozen = '' }: { offsets?: number[]; frozen?: string } = {}) => {
  const calls: { method: string; params: any; sessionId?: string }[] = [];
  const listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  const cdp = {
    send: async (method: string, params: any = {}, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.attachToTarget') return { sessionId: `S-${params.targetId}` };
      // A tab frozen by a dialog nobody answered: nothing sent to it ever replies.
      if (frozen && sessionId === frozen) return new Promise(() => undefined);
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params.expression);
      if (expression.includes('state?.marker')) return { result: { value: 'M' } };
      if (expression.includes('c.pageKey()')) return { result: { value: ['K', 'G'] } };
      if (expression.includes('scrollTop')) return { result: { value: offsets.length > 1 ? offsets.shift() : offsets[0] } };
      if (expression.includes('nodes.get(80)')) return { result: { objectId: 'OBJ-80' } };
      if (expression === 'location.href') return { result: { value: 'http://fixture/docs' } };
      if (expression === 'document.readyState') return { result: { value: 'complete' } };
      return { result: {} };
    },
    onEvent: (listener: (method: string, params: any, sessionId?: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  /** A browser-level protocol event (no session), as target discovery sends them. */
  const emit = (method: string, params: object, sessionId?: string) => listeners.forEach((listener) => listener(method, params, sessionId));
  return { cdp: cdp as unknown as CdpConnection, calls, emit };
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

describe('a tab our tab opens', () => {
  const created = (targetId: string, openerId?: string) => ({
    targetInfo: { targetId, type: 'page', url: '', ...(openerId && { openerId }) },
  });

  it('takes the tabs it opened and never the user\'s own', async () => {
    const { cdp, calls, emit } = fakeCdp();
    const tab = await Tab.attach(cdp, 'T1');
    expect(calls.some((call) => call.method === 'Target.setDiscoverTargets' && call.params.discover === true)).toBe(true);
    emit('Target.targetCreated', created('USER', 'OTHER'));
    emit('Target.targetCreated', created('ALSO-USER'));
    emit('Target.targetCreated', created('T2', 'T1'));
    expect(tab.takeOpened()).toEqual(['T2']);
    expect(tab.takeOpened()).toEqual([]);
    expect(calls.filter((call) => call.method === 'Target.attachToTarget').map((call) => call.params.targetId)).toEqual(['T1']);
  });

  it('follows it with the same setup: focus emulation, the input counter, dialog answers and the opener\'s device', async () => {
    const { cdp, calls, emit } = fakeCdp();
    const opener = await Tab.attach(cdp, 'T1');
    await opener.emulate(DEVICES['iphone-15']);
    const next = await opener.follow('T2');
    expect(next.targetId).toBe('T2');
    const on = (method: string) => calls.filter((call) => call.method === method && call.sessionId === 'S-T2');
    expect(on('Emulation.setFocusEmulationEnabled')).toHaveLength(1);
    expect(on('Page.addScriptToEvaluateOnNewDocument')[0].params.source).toContain('__jevInput');
    expect(on('Emulation.setDeviceMetricsOverride')[0].params).toMatchObject({ width: 393, height: 852, mobile: true });
    expect(on('Emulation.setTouchEmulationEnabled')[0].params).toMatchObject({ enabled: true });
    // The counter is evaluated on the document the tab shows once it has loaded, too.
    expect(on('Runtime.evaluate').filter((call) => String(call.params.expression).includes('__jevInput')).length).toBeGreaterThanOrEqual(2);
    emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave?' }, 'S-T2');
    expect(next.takeDialogs()).toEqual([{ type: 'confirm', message: 'Leave?', accepted: false }]);
  });

  it('gives up on a new tab that never answers (a dialog it raised before it was followed) instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const { cdp } = fakeCdp({ frozen: 'S-T2' });
      const opener = await Tab.attach(cdp, 'T1');
      const outcome = opener.follow('T2').then(
        () => 'followed',
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatch(/^The new tab did not answer within 5 s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('knows when its tab closed, and stops reading it at once', async () => {
    const { cdp, emit } = fakeCdp();
    const tab = await Tab.attach(cdp, 'T1');
    expect(tab.closed).toBe(false);
    emit('Target.targetDestroyed', { targetId: 'OTHER' });
    expect(tab.closed).toBe(false);
    emit('Target.targetDestroyed', { targetId: 'T1' });
    expect(tab.closed).toBe(true);
    await expect(tab.observe()).rejects.toThrow(StalePage);
  });
  it('watches its own frames with the one auto-attach setting, iframes only, and stops when closed', async () => {
    const { cdp, calls } = fakeCdp();
    const opener = await Tab.attach(cdp, 'T1');
    const next = await opener.follow('T2');
    const autoAttach = calls.filter((call) => call.method === 'Target.setAutoAttach');
    expect(autoAttach.map((call) => call.sessionId)).toEqual(['S-T1', 'S-T2']);
    for (const call of autoAttach) expect(call.params).toMatchObject({ waitForDebuggerOnStart: true, filter: [{ type: 'iframe' }] });
    // Popups are found by discovery, which pauses nothing.
    expect(calls.filter((call) => call.method === 'Target.setDiscoverTargets').every((call) => call.sessionId === undefined)).toBe(true);
    await next.close();
    expect(calls.at(-1)).toMatchObject({ method: 'Target.closeTarget', params: { targetId: 'T2' } });
  });
});

describe('an upload', () => {
  it('sets the declared path on the observed file input', async () => {
    const { cdp, calls } = fakeCdp();
    const tab = await Tab.attach(cdp, 'T1');
    const field: PageAction = { id: 'e1', kind: 'upload', node: 80, role: 'file', label: 'Avatar (file field)' };
    const observed = { ...PAGE, page_key: 'K', guards: { 80: 'G' } } as unknown as PageState;
    await tab.upload(field, observed, '/Users/ada/avatar.png');
    expect(calls.find((call) => call.method === 'DOM.setFileInputFiles')?.params).toEqual({ files: ['/Users/ada/avatar.png'], objectId: 'OBJ-80' });
  });

  it('refuses a file field inside a frame by name, and sets nothing', async () => {
    const { cdp, calls } = fakeCdp();
    const tab = await Tab.attach(cdp, 'T1');
    const field: PageAction = { id: 'e1', kind: 'upload', node: FRAME_ID_STRIDE + 4, role: 'file', label: 'CV (file field)', frame: 'F1' };
    const refused = await tab.upload(field, PAGE, '/Users/ada/cv.pdf').catch((error: Error) => error);
    expect(refused).toBeInstanceOf(TargetUnreachable);
    expect((refused as Error).message).toBe('"CV (file field)" is inside a frame, and jev-browse uploads only to file fields in the page itself');
    expect(calls.some((call) => call.method === 'DOM.setFileInputFiles')).toBe(false);
  });
});

describe("the run's stop signal ends a tab's waits, never an input", () => {
  /** fakeCdp, with `answer` taking first say over each call; undefined falls through to fakeCdp. */
  const answering = (answer: (method: string, params: any) => unknown, options: { offsets?: number[] } = {}) => {
    const fake = fakeCdp(options);
    const send = fake.cdp.send.bind(fake.cdp);
    (fake.cdp as any).send = async (method: string, params: any = {}, sessionId?: string) => {
      const answered = answer(method, params);
      if (answered === undefined) return send(method, params, sessionId);
      fake.calls.push({ method, params, sessionId });
      return answered;
    };
    return fake;
  };
  const abortIn = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
  const timed = async <T>(work: () => Promise<T>) => {
    const started = performance.now();
    const value = await work();
    return { value, ms: performance.now() - started };
  };

  it("stops waiting for a followed tab's address and load", async () => {
    // A popup that stays on about:blank and never finishes loading: 3 s for its URL, then 15 s for its load.
    const { cdp } = answering((method, params) => {
      if (method !== 'Runtime.evaluate') return undefined;
      if (params.expression === 'location.href') return { result: { value: 'about:blank' } };
      if (params.expression === 'document.readyState') return { result: { value: 'loading' } };
      return undefined;
    });
    const opener = await Tab.attach(cdp, 'T1');
    opener.stopSignal = abortIn(50);
    const { value: next, ms } = await timed(() => opener.follow('T2'));
    expect(next.targetId).toBe('T2');
    expect(ms).toBeLessThan(1000);
  });

  it('stops polling a scroll that keeps moving, after the wheel went out, and says how far it got', async () => {
    const { cdp, calls } = fakeCdp({ offsets: Array.from({ length: 60 }, (_, i) => i * 10) });
    const tab = await Tab.attach(cdp, 'T1');
    tab.stopSignal = abortIn(120);
    const { value: outcome, ms } = await timed(() => tab.act({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 }, PAGE));
    expect(wheelsIn(calls)).toHaveLength(1);
    expect(ms).toBeLessThan(700);
    expect((outcome as { scrolled?: number }).scrolled).toBeGreaterThan(0);
  });

  it('stops reading a frame that does not answer', async () => {
    const state = { url: 'http://fixture/', title: 'Fixture', text: 'Hello', w: 1120, h: 780, actions: [], marker: 'M', page_key: 'K', guards: {}, omitted_actions: 0 };
    const { cdp } = answering((method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' }, childFrames: [{ frame: { id: 'F1', url: 'http://ads.example/' } }] } };
      // The frame's owner is never found: its read hangs until the frame cap.
      if (method === 'DOM.getFrameOwner') return new Promise(() => undefined);
      if (method === 'Runtime.evaluate' && String(params.expression).includes('__jevWanted')) return { result: { value: state } };
      return undefined;
    });
    const tab = await Tab.attach(cdp, 'T1');
    tab.stopSignal = abortIn(50);
    const { value: page, ms } = await timed(() => tab.observe());
    expect(page.text).toBe('Hello');
    expect(ms).toBeLessThan(1000);
  });
});
