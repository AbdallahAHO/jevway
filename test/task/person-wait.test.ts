import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as chrome from '../../src/browser/chrome.ts';
import { Tab, type PageAction } from '../../src/browser/tab.ts';
import * as model from '../../src/jev/model.ts';
import { createSessionService, type SessionEvent } from '../../src/session/session-service.ts';
import { BrowserTask, type TaskOptions } from '../../src/task/run-task.ts';
import { ssoProviderOf, stillSigningIn } from '../../src/task/person-wait.ts';
import { createRunner, personWaitSeconds } from '../../src/task/start-task.ts';
import { cliWith } from '../cli/harness.ts';
import { fakeRunner, fakeTab, page, scriptedJev } from '../fakes.ts';
import { connect, fakeService, summaryFor } from '../mcp/connect.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// npm's Cloudflare challenge as headless Chrome saw it: nothing on it to act on but a wait.
const wallPage = (fingerprint = 'wall') =>
  page({
    url: 'https://www.npmjs.com/',
    title: 'Just a moment...',
    text: 'www.npmjs.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.\nRay ID:\na4c627515b445548\nPerformance and Security by\nCloudflare\nPrivacy',
    actions: [{ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }],
    fingerprint,
  });
const realPage = (fingerprint = 'real') => page({ url: 'https://www.npmjs.com/package/zod', title: 'zod - npm', text: 'zod\nTypeScript-first schema validation', fingerprint });

const SIGN_IN = 'http://fixture/user/login?redirect_to=%2Frepo%2Fnew';
const loginField = (label: string, node: number, value = ''): PageAction => ({ id: `l${node}`, kind: 'fill', node, role: 'textbox', label, value });
const loginPage = (username = '', password = false, url = SIGN_IN) =>
  page({
    url,
    fingerprint: `login-${url}-${username}-${password}`,
    text: 'Sign in',
    actions: [loginField('Username or email address', 5, username), { id: 's', kind: 'click', node: 9, role: 'button', label: 'Sign in' }],
    passwordFields: [{ name: 'Password', filled: password }],
  });
const dashboard = (fingerprint = 'in') => page({ url: 'http://fixture/repo/new', title: 'New repository', text: 'Create a new repository', fingerprint });

const GOOGLE_AUTH =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&response_type=code&scope=openid';
const chooser = (fingerprint = 'chooser') =>
  page({
    url: GOOGLE_AUTH,
    title: 'Sign in - Google Accounts',
    text: 'Choose an account\nto continue to App',
    actions: [{ id: 'acc', kind: 'click', node: 40, role: 'link', label: 'Ada Lovelace ada@gmail.com' }],
    fingerprint,
  });
const appHome = (fingerprint = 'app') => page({ url: 'https://app.example/home', title: 'App', text: 'Welcome back, Ada', fingerprint });

/** A visible browser whose notifications and fronting the test hears, with waits measured in milliseconds. */
const visible = () => {
  const notify = vi.fn((_message: string) => undefined);
  return { notify, person: { visible: true, notify, pollMs: 5, tickMs: 40 } };
};
const base: Partial<TaskOptions> = { doneWhen: 'x', changeWaitMs: 0, wallWaitMs: 0 };

describe('waiting for a person at a bot check', () => {
  it('goes on in the same call once a person passed it, having told them once and brought the tab forward', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { tab, asTab, acted } = fakeTab([wallPage('w1'), wallPage('w2'), wallPage('w3'), realPage()]);
    const send = vi.fn(async (..._args: unknown[]) => ({}));
    tab.send = send;
    const { notify, person } = visible();
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Open zod', waitForPersonSeconds: 5, person }).run();
    expect(summary.status).toBe('done');
    expect(summary.title).toBe('zod - npm');
    expect(summary.wall).toBeUndefined();
    expect(summary.steps).toEqual([{ operation: 'WAIT_FOR_PERSON', element: 'A person passed the Cloudflare check', page_changed: true, confidence: 1 }]);
    expect(notify.mock.calls).toEqual([['Pass the Cloudflare check in the Chrome window']]);
    expect(send).toHaveBeenCalledWith('Page.bringToFront', {});
    // Waiting and observing only: no Jev request on the challenge, nothing typed or clicked.
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain('Performing security verification');
    expect(acted).toEqual([]);
  });

  it('ends blocked with the wall when nobody passes it, saying the wait ran out', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'WAIT' }]);
    const { asTab } = fakeTab([wallPage()]);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Open zod', waitForPersonSeconds: 1, person: visible().person }).run();
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    expect(summary.status).toBe('blocked');
    expect(summary.reason).toBe(
      'The page is a bot check (Cloudflare; seen: title "just a moment...", "ray id:", "performance and security by cloudflare", "performing security verification") that did not clear by itself, and nobody passed it in the 1 s jevway waited with the tab in front; jevway never tries to get past one. A person can pass it in this tab, then continue the session.',
    );
    expect(summary.wall).toEqual({ kind: 'bot_check', origin: 'https://www.npmjs.com', name: 'cloudflare', person_can_act: true, waited_seconds: 1 });
    expect(summary.steps).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('never waits in a headless browser or with a wait of 0, and hands back exactly as before', async () => {
    const runOnce = async (options: Partial<TaskOptions>) => {
      const { tab, asTab } = fakeTab([wallPage()]);
      tab.send = vi.fn(async () => ({}));
      const started = performance.now();
      const summary = await new BrowserTask(asTab, scriptedJev([{ operation: 'WAIT' }]).ask, { ...base, goal: 'Open zod', ...options }).run();
      return { summary, ms: performance.now() - started, send: tab.send };
    };
    const before = await runOnce({});
    const headless = visible();
    const hidden = await runOnce({ waitForPersonSeconds: 120, person: { ...headless.person, visible: false } });
    const off = visible();
    const zero = await runOnce({ waitForPersonSeconds: 0, person: off.person });
    for (const run of [hidden, zero]) {
      expect(run.ms).toBeLessThan(500);
      expect(run.send).not.toHaveBeenCalledWith('Page.bringToFront', expect.anything());
    }
    expect(zero.summary.reason).toBe(before.summary.reason);
    expect(zero.summary.wall).toEqual({ kind: 'bot_check', origin: 'https://www.npmjs.com', name: 'cloudflare', person_can_act: true });
    // Nobody can pass a check in a headless browser: the result says so, for the agent's question to the user.
    expect(hidden.summary.reason).toBe(
      before.summary.reason.replace(
        'A person can pass it in this tab, then continue the session.',
        'This browser is headless, so nobody can pass it here: a visible browser is needed (JEVWAY_BROWSER=auto or launch).',
      ),
    );
    expect(hidden.summary.wall).toEqual({ kind: 'bot_check', origin: 'https://www.npmjs.com', name: 'cloudflare', person_can_act: false });
    expect(headless.notify).not.toHaveBeenCalled();
    expect(off.notify).not.toHaveBeenCalled();
  });

  it('tells a waiting note at once and then every tick, counting down', async () => {
    const { asTab } = fakeTab([wallPage()]);
    const notes: { message: string; seconds_left: number; url: string }[] = [];
    await new BrowserTask(asTab, scriptedJev([{ operation: 'WAIT' }]).ask, { ...base, goal: 'Open zod', waitForPersonSeconds: 0.25, person: visible().person }).run({
      onWait: (note, url) => notes.push({ ...note, url }),
    });
    expect(notes[0]).toEqual({ message: 'Waiting for you to pass the Cloudflare check in the Chrome window (1 s left)', seconds_left: 1, url: 'https://www.npmjs.com/' });
    // 250 ms at a 40 ms tick: the first at once, then about six more.
    expect(notes.length).toBeGreaterThanOrEqual(4);
    expect(notes.length).toBeLessThanOrEqual(8);
  });

  it('stops waiting as soon as the caller cancels, and reports the cancel', async () => {
    const { asTab } = fakeTab([wallPage()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    const summary = await new BrowserTask(asTab, scriptedJev([{ operation: 'WAIT' }]).ask, { ...base, goal: 'Open zod', waitForPersonSeconds: 30, person: visible().person }).run({
      signal: controller.signal,
    });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(summary).toMatchObject({ status: 'blocked', reason: 'Cancelled by the caller' });
  });

  it('stops waiting when the time budget runs out', async () => {
    const { asTab } = fakeTab([wallPage()]);
    const summary = await new BrowserTask(asTab, scriptedJev([{ operation: 'WAIT' }]).ask, {
      ...base,
      goal: 'Open zod',
      maxSeconds: 0.3,
      waitForPersonSeconds: 30,
      person: visible().person,
    }).run();
    expect(summary.status).toBe('step_budget');
  });

  it('does not wait a second time when the check comes back in the same call', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }]);
    const { asTab } = fakeTab([wallPage('w1'), realPage(), wallPage('w2')]);
    const { notify, person } = visible();
    const started = performance.now();
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Open zod', waitForPersonSeconds: 30, person }).run();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(summary.status).toBe('blocked');
    expect(summary.wall).toMatchObject({ kind: 'bot_check' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('never follows a tab the page opened while a person was at it', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { tab, asTab } = fakeTab([wallPage('w1'), wallPage('w2'), realPage()]);
    const observe = tab.observe;
    tab.observe = async () => {
      const read = await observe();
      if (read.fingerprint === 'w2') tab.opened.push('POPUP');
      return read;
    };
    const follow = vi.fn(tab.follow);
    tab.follow = follow;
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Open zod', waitForPersonSeconds: 5, person: visible().person }).run();
    expect(summary.status).toBe('done');
    expect(follow).not.toHaveBeenCalled();
  });

  it('keeps a headless session at no wait whatever a later call asks', async () => {
    const { asTab } = fakeTab([wallPage()]);
    const { notify, person } = visible();
    const task = new BrowserTask(asTab, scriptedJev([{ operation: 'WAIT' }]).ask, { ...base, goal: 'Open zod', person: { ...person, visible: false } });
    task.update({ waitForPersonSeconds: 120 });
    const started = performance.now();
    expect((await task.run()).status).toBe('blocked');
    expect(performance.now() - started).toBeLessThan(500);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('waiting for a person at a sign-in wall', () => {
  const SIGN_IN_WALL = 0.9;

  it('goes on once the person signed in and the page left the sign-in form', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'BLOCKED', sign_in_wall: SIGN_IN_WALL }, { operation: 'DONE', done_check: 0.95 }]);
    // Typing, then a password typed but not sent, then the page behind it, read twice before it counts.
    const { asTab } = fakeTab([loginPage(), loginPage('ada'), loginPage('ada', true), dashboard('in1'), dashboard('in2')]);
    const { notify, person } = visible();
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Create a repository', waitForPersonSeconds: 5, person }).run();
    expect(summary.status).toBe('done');
    expect(summary.steps.map((step) => step.element)).toContain('A person signed in to fixture');
    expect(notify.mock.calls).toEqual([['Sign in to fixture in Chrome']]);
    expect(requests).toHaveLength(2);
  });

  it('ends blocked with the wall when nobody signs in, saying the wait ran out', async () => {
    const { ask } = scriptedJev([{ operation: 'BLOCKED', sign_in_wall: SIGN_IN_WALL }]);
    const { asTab } = fakeTab([loginPage()]);
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Create a repository', waitForPersonSeconds: 1, person: visible().person }).run();
    expect(summary).toMatchObject({
      status: 'blocked',
      reason:
        'The page asks to sign in at http://fixture and no supplied value fits its fields, and nobody signed in during the 1 s jevway waited with the tab in front; sign in there (or pass the values), then call again.',
      wall: { kind: 'sign_in', origin: 'http://fixture', person_can_act: true, waited_seconds: 1 },
    });
  });

  it('hands back as before without a wait, and says when the browser is headless', async () => {
    const handBack = async (person: { visible: boolean }) => {
      const { asTab } = fakeTab([loginPage()]);
      const ask = scriptedJev([{ operation: 'BLOCKED', sign_in_wall: SIGN_IN_WALL }]).ask;
      return new BrowserTask(asTab, ask, { ...base, goal: 'Create a repository', waitForPersonSeconds: 0, person }).run();
    };
    expect(await handBack({ visible: true })).toMatchObject({
      reason: 'The page asks to sign in at http://fixture and no supplied value fits its fields; sign in there (or pass the values), then call again.',
      wall: { kind: 'sign_in', origin: 'http://fixture', person_can_act: true },
    });
    expect(await handBack({ visible: false })).toMatchObject({
      reason:
        'The page asks to sign in at http://fixture and no supplied value fits its fields; pass the values, or sign in with a visible browser (JEVWAY_BROWSER=auto or launch; this one is headless), then call again.',
      wall: { kind: 'sign_in', origin: 'http://fixture', person_can_act: false },
    });
  });
});

describe('a sign-in wall counts as passed only when the page is clearly past it', () => {
  const wall = loginPage();
  it('is still the wall while the form is there, a password shows, or the path is a sign-in step', () => {
    expect(stillSigningIn(loginPage('ada'), wall)).toBe(true);
    expect(stillSigningIn(page({ url: 'http://fixture/account', passwordFields: [{ name: 'Password', filled: true }] }), wall)).toBe(true);
    expect(stillSigningIn(page({ url: 'http://fixture/sessions/two-factor', actions: [] }), wall)).toBe(true);
    expect(stillSigningIn(page({ url: 'https://app.example/auth/callback', actions: [] }), wall)).toBe(true);
    expect(stillSigningIn(chooser(), wall)).toBe(true);
  });

  it('is passed on another page with no sign-in form, or the same page once its form is gone', () => {
    expect(stillSigningIn(dashboard(), wall)).toBe(false);
    const inline = loginPage('', false, 'http://fixture/repo/new');
    expect(stillSigningIn(page({ url: 'http://fixture/repo/new', actions: [], text: 'Create a new repository' }), inline)).toBe(false);
    // On a sign-in path the page is still the sign-in, whatever it shows ("Signed in, redirecting…").
    expect(stillSigningIn(page({ url: SIGN_IN, actions: [], text: 'Signed in' }), wall)).toBe(true);
  });
});

describe('an SSO page', () => {
  it("is an identity provider's sign-in for another site", () => {
    expect(ssoProviderOf(GOOGLE_AUTH)).toBe('Google');
    expect(
      ssoProviderOf(
        'https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Faccounts.google.com%2Fsignin%2Foauth%2Fconsent%3Fclient_id%3D1%26redirect_uri%3Dhttps%253A%252F%252Fapp.example',
      ),
    ).toBe('Google');
    expect(ssoProviderOf('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&redirect_uri=https%3A%2F%2Fapp.example')).toBe('Microsoft');
    expect(ssoProviderOf('https://login.microsoftonline.com/tenant/saml2?SAMLRequest=abc')).toBe('Microsoft');
    expect(ssoProviderOf('https://appleid.apple.com/auth/authorize?client_id=com.app&redirect_uri=https%3A%2F%2Fapp.example')).toBe('Apple');
  });

  it("is never the provider's own pages, another host, or a URL that only mentions one", () => {
    expect(ssoProviderOf('https://accounts.google.com/signup')).toBeUndefined();
    expect(ssoProviderOf('https://accounts.google.com/o/oauth2/v2/auth?client_id=1')).toBeUndefined();
    expect(ssoProviderOf('https://myaccount.google.com/?client_id=x&redirect_uri=y')).toBeUndefined();
    expect(ssoProviderOf('https://app.example/login?client_id=x&redirect_uri=y')).toBeUndefined();
    expect(ssoProviderOf('https://evil.example/?u=https://accounts.google.com/o/oauth2/auth?client_id=x%26redirect_uri=y')).toBeUndefined();
    expect(ssoProviderOf('')).toBeUndefined();
  });

  it('waits for the person to finish, without asking Jev about it, then goes on', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab, acted } = fakeTab([chooser('c1'), chooser('c2'), appHome('a1'), appHome('a2')]);
    const { notify, person } = visible();
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Sign in to App with Google', waitForPersonSeconds: 5, person }).run();
    expect(summary.status).toBe('done');
    expect(summary.steps.map((step) => step.element)).toEqual(['A person finished signing in with Google']);
    expect(notify.mock.calls).toEqual([['Finish signing in with Google in Chrome']]);
    expect(requests).toHaveLength(1);
    expect(acted).toEqual([]);
  });

  it('ends blocked with a sign-in wall at the provider when nobody finishes', async () => {
    const { asTab } = fakeTab([chooser()]);
    const summary = await new BrowserTask(asTab, scriptedJev([{ operation: 'WAIT' }]).ask, { ...base, goal: 'Sign in to App with Google', waitForPersonSeconds: 1, person: visible().person }).run();
    expect(summary).toMatchObject({
      status: 'blocked',
      reason:
        'The page asks to sign in with Google at https://accounts.google.com for another site, and nobody finished it during the 1 s jevway waited with the tab in front; sign in there, then call again.',
      wall: { kind: 'sign_in', origin: 'https://accounts.google.com', name: 'google', person_can_act: true, waited_seconds: 1 },
    });
  });

  it('is left to Jev as before when there is no wait', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'DONE', done_check: 0.9 }]);
    const { asTab } = fakeTab([chooser()]);
    const summary = await new BrowserTask(asTab, ask, { ...base, goal: 'Sign in to App with Google', person: { ...visible().person, visible: false }, waitForPersonSeconds: 120 }).run();
    expect(summary.status).toBe('done');
    expect(requests).toHaveLength(1);
  });
});

describe('the runner decides whether a person can be waited for', () => {
  const startWith = async (source: string, userAgent: string, options: Partial<TaskOptions> = {}) => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubEnv('JEVWAY_NOTIFY', 'off');
    vi.spyOn(model, 'createAsk').mockReturnValue(scriptedJev([{ operation: 'WAIT' }]).ask);
    const cdp = { send: vi.fn(async () => ({ userAgent })) };
    vi.spyOn(chrome, 'connectChrome').mockResolvedValue({ cdp } as unknown as chrome.ChromeHandle);
    vi.spyOn(Tab, 'open').mockResolvedValue(fakeTab([wallPage()]).asTab);
    const task = await createRunner(source).start({ goal: 'Open zod', url: 'https://www.npmjs.com/', ...base, ...options });
    const started = performance.now();
    const summary = await task.run();
    return { summary, ms: performance.now() - started };
  };

  it('never waits in launch-headless or a headless Chrome behind a port', async () => {
    for (const [source, agent] of [
      ['launch-headless', 'Mozilla/5.0 Chrome/141.0.0.0'],
      ['http://127.0.0.1:9222', 'Mozilla/5.0 HeadlessChrome/141.0.0.0'],
    ]) {
      const { summary, ms } = await startWith(source, agent, { waitForPersonSeconds: 2 });
      expect(summary.status, source).toBe('blocked');
      expect(ms, source).toBeLessThan(500);
    }
  });

  it('waits in a visible Chrome', async () => {
    const { summary, ms } = await startWith('http://127.0.0.1:9222', 'Mozilla/5.0 Chrome/141.0.0.0', { waitForPersonSeconds: 1 });
    expect(summary.reason).toContain('nobody passed it in the 1 s');
    expect(ms).toBeGreaterThanOrEqual(950);
  });

  it('takes the call, then JEVWAY_PERSON_WAIT_SECONDS, then 120 s', () => {
    expect(personWaitSeconds(30, { JEVWAY_PERSON_WAIT_SECONDS: '60' })).toBe(30);
    expect(personWaitSeconds(undefined, { JEVWAY_PERSON_WAIT_SECONDS: '60' })).toBe(60);
    expect(personWaitSeconds(undefined, { JEVWAY_PERSON_WAIT_SECONDS: '0' })).toBe(0);
    expect(personWaitSeconds(undefined, {})).toBe(120);
    expect(personWaitSeconds(undefined, { JEVWAY_PERSON_WAIT_SECONDS: 'soon' })).toBe(120);
  });
});

describe('the wait reaches the caller', () => {
  it('as session events, and the story says who passed the check', async () => {
    const { runner } = fakeRunner({ ask: scriptedJev([{ operation: 'DONE', done_check: 0.9 }]).ask, pages: [wallPage('w1'), wallPage('w2'), realPage()] });
    const service = createSessionService(runner, { outDir: join(mkdtempSync(join(tmpdir(), 'jevway-wait-')), '.jevway'), env: {} });
    const events: SessionEvent[] = [];
    await service.task(
      { goal: 'Open zod', url: 'https://www.npmjs.com/', ...base, waitForPersonSeconds: 5, person: visible().person },
      { onEvent: (event) => events.push(event) },
    );
    expect(events.find((event) => event.type === 'waiting')).toMatchObject({
      type: 'waiting',
      message: 'Waiting for you to pass the Cloudflare check in the Chrome window (5 s left)',
      seconds_left: 5,
      url: 'https://www.npmjs.com/',
    });
    expect(events.find((event) => event.type === 'step')).toMatchObject({ story: 'A person passed the Cloudflare check.' });
  });

  it('as MCP progress that keeps rising between steps, and the parameter reaches the task on every call', async () => {
    const { service, runs, started, updates } = fakeService();
    const client = await connect({ service });
    runs.push(async (context) => {
      const { onStep, onWait } = context as typeof context & { onWait: (note: object, url: string) => void };
      onWait({ message: 'Waiting for you to pass the Cloudflare check in the Chrome window (120 s left)', seconds_left: 120 }, 'https://www.npmjs.com/');
      onWait({ message: 'Waiting for you to pass the Cloudflare check in the Chrome window (110 s left)', seconds_left: 110 }, 'https://www.npmjs.com/');
      onStep?.({ operation: 'WAIT_FOR_PERSON', element: 'A person passed the Cloudflare check', page_changed: true, confidence: 1 }, 1, 'https://www.npmjs.com/');
      return summaryFor('done');
    });
    const heard: { progress: number; message?: string }[] = [];
    const call = (args: object) =>
      client.callTool({ name: 'jevway_task', arguments: { goal: 'Open zod', ...args } }, { onprogress: (progress) => heard.push(progress) });
    const first = (await call({ url: 'https://www.npmjs.com/', wait_for_person_seconds: 45 })).structuredContent as { session: string };
    expect(heard.map((p) => p.message)).toEqual([
      'Waiting for you to pass the Cloudflare check in the Chrome window (120 s left)',
      'Waiting for you to pass the Cloudflare check in the Chrome window (110 s left)',
      'Step 1: A person passed the Cloudflare check.',
    ]);
    const progress = heard.map((p) => p.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(new Set(progress).size).toBe(3);
    expect(progress[2]).toBe(1);
    expect(started[0]).toMatchObject({ waitForPersonSeconds: 45 });
    await call({ session: first.session, wait_for_person_seconds: 0 });
    expect(updates.at(-1)).toMatchObject({ waitForPersonSeconds: 0 });
  });

  it('as a CLI flag', async () => {
    const fake = fakeRunner();
    const { cli } = cliWith({ createRunner: () => fake.runner });
    await cli(['run', '--url', 'http://fixture/stays', '--goal', 'Book', '--wait-for-person', '30']);
    expect(fake.started[0]).toMatchObject({ waitForPersonSeconds: 30 });
    const bad = await cli(['run', '--url', 'http://fixture/stays', '--goal', 'Book', '--wait-for-person', 'soon']);
    expect(bad.code).toBe(2);
    expect(bad.json).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
  });
});
