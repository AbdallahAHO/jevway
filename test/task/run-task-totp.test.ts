import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageAction } from '../../src/browser/tab.ts';
import { createSessionService } from '../../src/session/session-service.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { parseTotpSecret, totpCode } from '../../src/task/totp.ts';
import { fakeRunner, fakeTab, page, scriptedJev } from '../fakes.ts';

// The person's authenticator secret for their own account, as an otpauth URI with 8 digits (a 6-digit code could
// match a number in a timestamp by chance; 8 digits keep the leak checks honest).
const BASE32 = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Forge:ada?secret=${BASE32}&issuer=Forge&digits=8`;
const OTHER = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const MARKER = '[secret:otp]';
// 09:00:10 UTC: 20 s are left in the 30 s period, so the code is typed without waiting.
const NOW = Date.UTC(2026, 10, 2, 9, 0, 10);

const codeAt = (secret: string, at: number) => totpCode(parseTotpSecret(secret), at);

const codeField: PageAction = { id: 'c1', kind: 'fill', node: 7, role: 'textbox', label: 'Authentication code', value: '' };
const verify: PageAction = { id: 'c2', kind: 'click', node: 8, role: 'button', label: 'Verify' };
const twoFactor = (fingerprint: string) =>
  page({ url: 'http://fixture/sessions/two-factor', title: 'Two-factor authentication', text: 'Open your authenticator app', actions: [codeField, verify], fingerprint });
// The page echoes the code everywhere it can once it is typed: the field, the address, the title, the text, a button.
const echoing = (code: string, fingerprint: string) =>
  page({
    url: `http://fixture/sessions/two-factor?code=${code}`,
    title: `Code ${code}`,
    text: `Code ${code} entered\nVERIFY ${code}`,
    actions: [{ ...codeField, value: code, current_value: code }, { ...verify, label: `Verify ${code}` }],
    fingerprint,
  });
const typeCode = { operation: 'TYPE_TEXT', type_text_target: '1', value_for_1: 'otp' };

// Every text file the run folder holds, and every file's name.
const folderText = (dir: string) => {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return [...files, ...files.filter((file) => !/\.(jpg|mp4)$/.test(file)).map((file) => readFileSync(file, 'utf8'))].join('\n');
};
const leaksOf = (secrets: string[]) => (anything: unknown) => {
  const text = (typeof anything === 'string' ? anything : JSON.stringify(anything)).toLowerCase();
  return secrets.filter((secret) => text.includes(secret.toLowerCase()));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('an authenticator secret the caller passes as totp', () => {
  it('types the current code for the key Jev picks, and only the marker leaves: requests, summary, trace, run folder', async () => {
    const code = codeAt(URI, NOW);
    const leaks = leaksOf([code, BASE32, URI]);
    const { ask, requests } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const { tab, asTab, acted } = fakeTab([twoFactor('a'), echoing(code, 'b'), echoing(code, 'c')]);
    const recordDir = mkdtempSync(join(tmpdir(), 'jev-totp-'));
    // No secret_keys: a totp key is secret on its own.
    const task = new BrowserTask(asTab, ask, { goal: `Sign in to Forge`, values: { email: 'ada@example.com' }, totp: { otp: URI }, changeWaitMs: 0, recordDir });
    const summary = await task.run();

    expect(acted).toEqual([{ label: 'Authentication code', text: code }]);
    expect(code).toMatch(/^\d{8}$/);
    // Jev sees the key and can choose it, never the secret.
    expect(requests[0].state.supplied_values).toEqual({ email: 'ada@example.com', otp: MARKER });
    expect(requests[0].questions.value_for_1.criteria.otp).toBe(`otp: ${MARKER}`);
    // The page that echoes the code is scrubbed as it is read, so the field still reads as kept.
    expect(summary.page_text).toContain(`Code ${MARKER} entered`);
    expect(summary.url).toBe(`http://fixture/sessions/two-factor?code=${MARKER}`);
    expect(summary.steps[0]).toMatchObject({ operation: 'TYPE_TEXT', value_key: 'otp', value_kept: true });
    for (const output of [requests, summary, task.trace, folderText(recordDir)]) expect(leaks(output)).toEqual([]);
    expect(readFileSync(join(recordDir, 'summary.json'), 'utf8')).toContain(MARKER);
    // The page's scripts never get the secret to look for.
    expect(tab.wanted).toEqual(['ada@example.com']);
  });

  it('keeps a session look at the page masked too', async () => {
    const code = codeAt(URI, NOW);
    const { ask } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const task = new BrowserTask(fakeTab([twoFactor('a'), echoing(code, 'b')]).asTab, ask, { goal: 'Sign in', totp: { otp: URI }, changeWaitMs: 0 });
    await task.run();
    expect(leaksOf([code])(await task.look())).toEqual([]);
  });

  it('types a 6-digit SHA1 code from a bare base32 secret', async () => {
    const { ask } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const { asTab, acted } = fakeTab([twoFactor('a'), twoFactor('b')]);
    await new BrowserTask(asTab, ask, { goal: 'Sign in', totp: { otp: BASE32.toLowerCase() }, changeWaitMs: 0 }).run();
    expect(acted).toEqual([{ label: 'Authentication code', text: codeAt(BASE32, NOW) }]);
    expect(acted[0].text).toMatch(/^\d{6}$/);
  });

  it('waits for the next code when the period is about to end, and types that one', async () => {
    // 0.5 s left in the period.
    vi.setSystemTime(Date.UTC(2026, 10, 2, 9, 0, 29, 500));
    const { ask } = scriptedJev([typeCode, { operation: 'BLOCKED' }]);
    const { asTab, acted } = fakeTab([twoFactor('a'), twoFactor('b')]);
    await new BrowserTask(asTab, ask, { goal: 'Sign in', totp: { otp: URI }, changeWaitMs: 0 }).run();
    expect(acted[0].text).toBe(codeAt(URI, Date.UTC(2026, 10, 2, 9, 0, 30)));
    expect(acted[0].text).not.toBe(codeAt(URI, Date.UTC(2026, 10, 2, 9, 0, 29)));
  });

  it('keeps the key for the session; a later call replaces it, by a new secret or a plain value that stays secret', async () => {
    const first = codeAt(URI, NOW);
    const second = codeAt(OTHER, NOW);
    const { ask, requests } = scriptedJev([typeCode, { operation: 'BLOCKED' }, typeCode, { operation: 'BLOCKED' }, typeCode, { operation: 'BLOCKED' }]);
    const { asTab, acted } = fakeTab([twoFactor('a'), echoing(first, 'b'), twoFactor('c'), echoing(second, 'd'), twoFactor('e'), echoing('55501234', 'f')]);
    const task = new BrowserTask(asTab, ask, { goal: 'Sign in', totp: { otp: URI }, changeWaitMs: 0 });
    await task.run();
    task.update({ totp: { otp: OTHER } });
    const replaced = await task.run();
    task.update({ values: { otp: '55501234' } });
    const plain = await task.run();
    expect(acted.map((action) => action.text)).toEqual([first, second, '55501234']);
    expect(requests.at(-1).state.supplied_values).toEqual({ otp: MARKER });
    // An earlier call's code and secret stay masked for the rest of the session.
    expect(leaksOf([first, second, '55501234', BASE32, OTHER])([requests, replaced, plain, task.trace])).toEqual([]);
  });

  it('refuses a bad secret, or a key also given in values, with an input error naming the key before anything runs', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED' }]);
    const { asTab } = fakeTab([twoFactor('a')]);
    expect(() => new BrowserTask(asTab, ask, { goal: 'Sign in', totp: { otp: 'JBSW0Y3DP!' } })).toThrow(/^totp\.otp: /);
    expect(() => new BrowserTask(asTab, ask, { goal: 'Sign in', values: { otp: '123456' }, totp: { otp: URI } })).toThrow(/^totp\.otp: .*values/);
    const task = new BrowserTask(asTab, ask, { goal: 'Sign in', totp: { otp: URI }, changeWaitMs: 0 });
    expect(() => task.update({ totp: { otp: 'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP' } })).toThrow(/^totp\.otp: /);
    expect(() => task.update({ totp: { backup: '123456' } })).toThrow(/^totp\.backup: /);
    // A refused update changes nothing: the first secret still stands.
    await task.run();
    expect(requests[0].state.supplied_values).toEqual({ otp: MARKER });
  });
});

describe('totp through the session service', () => {
  const service = (runner: ReturnType<typeof fakeRunner>['runner']) =>
    createSessionService(runner, { outDir: mkdtempSync(join(tmpdir(), 'jev-totp-out-')), env: {} });

  it('refuses a bad secret before a tab opens', async () => {
    const { runner } = fakeRunner();
    await expect(service(runner).task({ goal: 'Sign in', url: 'http://fixture/', totp: { otp: 'nope' } })).rejects.toThrow(/^totp\.otp: /);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('hands the secret to a new session and to a later call, and masks it in the listed goal', async () => {
    const code = codeAt(OTHER, NOW);
    const { ask } = scriptedJev([{ operation: 'BLOCKED' }, typeCode, { operation: 'BLOCKED' }]);
    const { runner, tabs } = fakeRunner({ ask, pages: [twoFactor('a'), twoFactor('b'), echoing(code, 'c')] });
    const sessions = service(runner);
    const first = await sessions.task({ goal: `Sign in with ${BASE32}`, url: 'http://fixture/', totp: { otp: URI } });
    expect(sessions.listSessions()[0].goal).toBe(`Sign in with ${MARKER}`);
    const next = await sessions.task({ goal: 'Sign in', session: first.session, totp: { otp: OTHER } });
    expect(tabs[0]).toBeDefined();
    expect(next.summary.steps[0]).toMatchObject({ value_key: 'otp' });
    expect(leaksOf([code, OTHER])(next.summary)).toEqual([]);
  });
});
