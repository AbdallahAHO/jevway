import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as chrome from '../../src/browser/chrome.ts';
import { Tab, type PageAction } from '../../src/browser/tab.ts';
import { buildActionSpace } from '../../src/jev/action-space.ts';
import { buildRequest, decide } from '../../src/jev/decide.ts';
import * as model from '../../src/jev/model.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { createRunner } from '../../src/task/start-task.ts';
import { fakeTab, page, scriptedJev } from '../fakes.ts';

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
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
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

describe('a secret is scrubbed from the page as soon as it is read, before anything cuts it short', () => {
  // 98 characters: longer than every cut a label, value, description or page text gets.
  const LONG = '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';
  const secret = { values: { token: LONG }, secretKeys: ['token'] };
  // A cut copy is a prefix: 20 characters of it are enough to give the secret away.
  const PREFIX = LONG.slice(0, 20).toLowerCase();
  const recordingText = (dir: string) => readdirSync(dir).filter((file) => !file.endsWith('.jpg')).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
  const leaks = (...outputs: unknown[]) => outputs.map((output) => (typeof output === 'string' ? output : JSON.stringify(output)).toLowerCase().includes(PREFIX));
  const MENU: PageAction = { id: 'menu', kind: 'click', node: 31, role: 'button', label: 'Filters', expanded: 'true' };

  it('keeps it out of a link label cut at 80 characters (history) and in the recording', async () => {
    const LINK: PageAction = { id: 'copy', kind: 'click', node: 30, role: 'link', label: `Copy ${LONG}` };
    const tokens = (fingerprint: string) => page({ url: 'http://fixture/tokens', title: 'Tokens', text: 'Your tokens', actions: [LINK, MENU], fingerprint });
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'BLOCKED' }]);
    const { tab, asTab } = fakeTab([tokens('a'), tokens('b')]);
    tab.unreachable = 1;
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-secret-'));
    const task = new BrowserTask(asTab, ask, { goal: 'Copy my token', ...secret, recordDir, changeWaitMs: 0 });
    const summary = await task.run();
    // The cut happened: the popup note names the link by its first 80 characters.
    expect(summary.steps.some((step) => step.element?.startsWith('closed the open popup covering "Copy '))).toBe(true);
    expect(leaks(requests, summary, task.trace, recordingText(recordDir))).toEqual([false, false, false, false]);
  });

  // Not cut anywhere today: kept as a check that a field holding the secret is scrubbed by both locks.
  it('keeps it out of a field value it was typed into, and in the recording', async () => {
    const FIELD: PageAction = { id: 't1', kind: 'fill', node: 7, role: 'textbox', label: 'API token', value: '' };
    const tokens = (value: string, fingerprint: string) => page({ url: 'http://fixture/tokens', title: 'Tokens', text: 'Your tokens', actions: [{ ...FIELD, value }], fingerprint });
    const { ask, requests } = scriptedJev([{ operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'token' }, { operation: 'BLOCKED' }]);
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-secret-'));
    const task = new BrowserTask(fakeTab([tokens('', 'a'), tokens(LONG, 'b')]).asTab, ask, { goal: 'Paste my token', ...secret, recordDir, changeWaitMs: 0 });
    const summary = await task.run();
    expect(leaks(requests, summary, task.trace, recordingText(recordDir))).toEqual([false, false, false, false]);
  });

  it('keeps it out of the title it is echoed in, and out of page_text cut at 2500 characters', async () => {
    const echoed = page({
      url: 'http://fixture/tokens',
      title: `Token ${LONG} created`,
      // The 2500-character cut lands inside the secret as the page shows it; scrubbed, the text is still long enough to be cut.
      text: `${'Your tokens are listed below. '.repeat(82)}${LONG} is your new token.${' Keep it safe.'.repeat(20)}`,
      fingerprint: 'a',
    });
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED' }]);
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-secret-'));
    const task = new BrowserTask(fakeTab([echoed]).asTab, ask, { goal: 'Create a token', ...secret, recordDir, changeWaitMs: 0 });
    const summary = await task.run();
    // The cut happened: page_text ends inside the secret's place.
    expect(summary.page_text).toMatch(/more characters not shown\]$/);
    expect(leaks(requests, summary, task.trace, recordingText(recordDir))).toEqual([false, false, false, false]);
  });
});

describe('a page error quoted in a hand-back never carries a secret', () => {
  // 98 characters; the quote is cut at 300, so the filler puts the cut inside the secret as the page shows it.
  const LONG = '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';
  const PREFIX = LONG.slice(0, 20).toLowerCase();
  const FILLER = 'The token was checked against the registry. '.repeat(6);
  const TAIL = ' Ask your admin for a new token before you try again.';
  const ERROR_LINE = `${FILLER}Token ${LONG} was rejected.${TAIL}`;
  const secret = { values: { token: LONG }, secretKeys: ['token'] };
  const tokenField = (value: string): PageAction => ({ id: 'n', kind: 'fill', node: 1, role: 'textbox', label: 'API token', value });
  const save: PageAction = { id: 's', kind: 'click', node: 2, role: 'button', label: 'Save token' };
  const check: PageAction = { id: 'k', kind: 'click', node: 3, role: 'button', label: 'Check token' };
  const formPage = (fingerprint: string, text: string) =>
    page({ url: 'http://fixture/settings/tokens', fingerprint, text, actions: [tokenField(LONG), save, check] });
  const leaks = (...outputs: unknown[]) => outputs.map((output) => JSON.stringify(output).toLowerCase().includes(PREFIX));

  it('keeps it out of the new words the last action brought, cut at 300 characters', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '3' }, { operation: 'CLICK', click_target: '2', page_error: 0.99 }]);
    const { asTab } = fakeTab([formPage('a', 'Tokens'), formPage('b', `Tokens\n${ERROR_LINE}`)]);
    const task = new BrowserTask(asTab, ask, { goal: 'Save my token', ...secret, changeWaitMs: 0 });
    const summary = await task.run();
    expect(summary.reason).toMatch(/^The page shows an error after "Check token": "The token was checked/);
    // The cut happened: the quote stops short of the line's end, scrubbed or not.
    expect(summary.reason).not.toContain(TAIL.trim());
    expect(leaks(summary.reason, summary, requests, task.trace)).toEqual([false, false, false, false]);
  });

  it('keeps it out of the page message after a confirmed submit, cut at 300 characters', async () => {
    const { ask, requests } = scriptedJev([
      { operation: 'CLICK', click_target: '2', commit_risk: 0.9 },
      { operation: 'CLICK', click_target: '3', page_error: 0.99 },
    ]);
    const { asTab } = fakeTab([formPage('a', 'Your registry tokens'), formPage('b', `Your registry tokens\n${ERROR_LINE}`)]);
    const task = new BrowserTask(asTab, ask, { goal: 'Save my token', ...secret, changeWaitMs: 0 });
    task.update({ confirmIrreversible: true, confirmTarget: 'registry' });
    const summary = await task.run();
    expect(summary.reason).toMatch(/^The page shows an error after "Save token": "The token was checked/);
    expect(summary.reason).not.toContain(TAIL.trim());
    expect(leaks(summary.reason, summary, requests, task.trace)).toEqual([false, false, false, false]);
  });
});

describe('a dialog message is scrubbed before it is cut', () => {
  const LONG = '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';

  it('keeps a secret the page puts in an alert out of history and requests, though the note cuts it at 200', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'BLOCKED' }]);
    const { tab, asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    // The 200-character cut lands inside the secret as the alert shows it.
    tab.dialogOnAct = { type: 'alert', message: `${'Your token is ready to copy now. '.repeat(5)}${LONG}`, accepted: true };
    const task = new BrowserTask(asTab, ask, { goal: 'Show my token', values: { token: LONG }, secretKeys: ['token'], changeWaitMs: 0 });
    const summary = await task.run();
    expect(summary.steps[0].element).toContain('Your token is ready to copy now.');
    for (const output of [summary, requests, task.trace]) expect(JSON.stringify(output)).not.toContain(LONG.slice(0, 20));
  });
});
