import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageAction } from '../../src/browser/tab.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { storyOf } from '../../src/task/present.ts';
import { parseTotpSecret, totpCode } from '../../src/task/totp.ts';
import { fakeTab, page, scriptedJev } from '../fakes.ts';

const CODE = '739214';
const MARKER = '[secret:otp]';
const BOXES = [11, 12, 13, 14, 15, 16];
const UNION = { x: 100, y: 200, w: 304, h: 52 };

// The six boxes as the reader lists them: one target on the first box, holding every box and their joined value.
const group = (value = ''): PageAction[] => [
  { id: 'e1', kind: 'fill', node: 11, role: 'textbox', label: 'Verification code (6 boxes)', value, boxes: BOXES, rect: UNION },
  { id: 'e2', kind: 'click', node: 11, role: 'textbox', label: 'Open Verification code (6 boxes)', value, boxes: BOXES, rect: UNION },
];
const verify: PageAction = { id: 'e3', kind: 'click', node: 30, role: 'button', label: 'Verify' };
const promo: PageAction = { id: 'e4', kind: 'fill', node: 40, role: 'textbox', label: 'Seats', value: '4' };
const codePage = (fingerprint: string, value = '') =>
  page({ url: 'http://fixture/verify', title: 'Verify your email', text: 'Enter the 6-digit code', actions: [...group(value), verify], fingerprint });
// After typing, the page broke the group up: it lists each box on its own, the last one cleared, beside a field holding a 4.
const brokenUp = (fingerprint: string) =>
  page({
    url: 'http://fixture/verify',
    title: 'Verify your email',
    text: 'Enter the 6-digit code\nStep 2 of 3',
    actions: [
      ...BOXES.map((node, i): PageAction => ({ id: `b${i}`, kind: 'fill', node, role: 'textbox', label: `Digit ${i + 1}`, value: i < 5 ? CODE[i] : '' })),
      verify,
      promo,
    ],
    fingerprint,
  });
const typeCode = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'otp' };

const folderText = (dir: string) => {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return [...files, ...files.filter((file) => !/\.(jpg|mp4)$/.test(file)).map((file) => readFileSync(file, 'utf8'))].join('\n');
};
// Every value an element of a request carries, by node.
const valuesIn = (request: any) => Object.fromEntries((request.state.elements as any[]).map((element) => [element.label, element.value]));

afterEach(() => {
  vi.useRealTimers();
});

describe('a code split into boxes', () => {
  it('is typed in one step, told as one sentence', async () => {
    const { ask } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const { asTab, acted } = fakeTab([codePage('a'), codePage('b', CODE)]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Verify the email', values: { otp: CODE }, changeWaitMs: 0 }).run();
    expect(acted).toEqual([{ label: 'Verification code (6 boxes)', text: CODE }]);
    expect(summary.steps[0]).toMatchObject({ operation: 'TYPE_TEXT', element: 'Verification code (6 boxes)', value_key: 'otp', value_kept: true });
    expect(storyOf(summary.steps)[0]).toBe('Typed the "otp" value into "Verification code (6 boxes)".');
  });

  it('reports value_kept: false when the typing found the boxes not holding the code', async () => {
    const { ask } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const { tab, asTab } = fakeTab([codePage('a'), codePage('b', CODE)]);
    const act = tab.act;
    tab.act = async (...args: Parameters<typeof act>) => {
      await act(...args);
      return { kept: false } as any;
    };
    const summary = await new BrowserTask(asTab, ask, { goal: 'Verify the email', values: { otp: CODE }, changeWaitMs: 0 }).run();
    expect(summary.steps[0]).toMatchObject({ value_key: 'otp', value_kept: false });
  });

  it('feeds a code of the wrong length back once, then asks for the value naming the field; nothing is typed', async () => {
    const { ask, requests } = scriptedJev([typeCode, typeCode, { operation: 'BLOCKED' }]);
    const { asTab, acted } = fakeTab([codePage('a'), codePage('b'), codePage('c')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Verify the email', values: { otp: '73921' }, changeWaitMs: 0 }).run();
    expect(acted).toEqual([]);
    expect(summary.steps[0]).toMatchObject({
      operation: 'TYPE_TEXT',
      element: 'Verification code (6 boxes)',
      not_executed: expect.stringContaining('the "otp" value has 5 characters but this field has 6 boxes'),
    });
    expect(JSON.stringify(requests[1])).toContain('has 5 characters but this field has 6 boxes');
    expect(summary.status).toBe('needs_input');
    expect(summary.reason).toMatch(/"Verification code \(6 boxes\)" has 6 boxes.*"otp".*5 characters/);
    expect(summary.missing).toEqual([{ label: 'Verification code (6 boxes)', role: 'textbox', path: '/verify' }]);
  });

  it('masks a secret typed across the boxes in every later read, joined or box by box; other digits stay', async () => {
    const { ask, requests } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const { asTab } = fakeTab([codePage('a'), brokenUp('b'), brokenUp('c')]);
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-boxes-'));
    const task = new BrowserTask(asTab, ask, { goal: 'Verify the email', values: { otp: CODE }, secretKeys: ['otp'], changeWaitMs: 0, recordDir });
    const summary = await task.run();
    // The next decision request: each box reads as the marker, never its digit; the Seats field keeps its 4.
    expect(valuesIn(requests[1])).toMatchObject({
      'Digit 1': MARKER,
      'Digit 2': MARKER,
      'Digit 3': MARKER,
      'Digit 4': MARKER,
      'Digit 5': MARKER,
      Seats: '4',
    });
    expect(JSON.stringify(requests[1])).toContain('Step 2 of 3');
    const outputs = JSON.stringify([requests, summary, task.trace, await task.look()]) + folderText(recordDir);
    for (const leaked of [CODE, CODE.slice(0, 5)]) expect(outputs).not.toContain(leaked);
    for (const action of (await task.look()).actions.filter((action) => BOXES.includes(action.node!) && action.value)) expect(action.value).toBe(MARKER);
  });

  it('masks only those boxes: a later document reusing their ids keeps its values', async () => {
    const { ask, requests } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    // The next page is a new document: its element ids start again, so its email field has a box's old id.
    const next = page({
      url: 'http://fixture/welcome',
      title: 'Welcome',
      text: 'Signed in',
      actions: [{ id: 'e1', kind: 'fill', node: 12, role: 'textbox', label: 'Backup email', value: 'ada@example.com' }],
      page_key: [2],
      fingerprint: 'b',
    });
    const { asTab } = fakeTab([{ ...codePage('a'), page_key: [1] }, next]);
    await new BrowserTask(asTab, ask, { goal: 'Verify the email', values: { otp: CODE }, secretKeys: ['otp'], changeWaitMs: 0 }).run();
    expect(valuesIn(requests[1])).toEqual({ 'Backup email': 'ada@example.com' });
  });

  it('types a totp code across the boxes, and only the marker leaves', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 2, 9, 0, 10));
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const code = totpCode(parseTotpSecret(secret), Date.now());
    const { ask, requests } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const { asTab, acted } = fakeTab([codePage('a'), brokenUp('b')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Sign in', totp: { otp: secret }, changeWaitMs: 0 }).run();
    expect(acted).toEqual([{ label: 'Verification code (6 boxes)', text: code }]);
    expect(storyOf(summary.steps)[0]).toBe('Typed the "otp" value into "Verification code (6 boxes)".');
    expect(JSON.stringify([requests, summary])).not.toContain(code);
    expect(valuesIn(requests[1])['Digit 1']).toBe(MARKER);
  });
});
