import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageAction } from '../../src/browser/tab.ts';
import { NO_SUPPLIED_VALUE, type Ask } from '../../src/jev/decide.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { STAYLIST, bookingActions, page, foldedPage, clickTargetOf, overflowChip, overflowPage, scriptedJev, fakeTab } from '../fakes.ts';

const SOURCE_LINK: PageAction = { id: 'source', kind: 'click', node: 40, role: 'link', label: 'View source observation' };

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
