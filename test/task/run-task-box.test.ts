import { describe, expect, it } from 'vitest';
import type { PageState } from '../../src/browser/tab.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { bookingActions, boxAt, fakeTab, NAME_RECT, page, PAY_RECT, scriptedJev, STAYLIST } from '../fakes.ts';

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
