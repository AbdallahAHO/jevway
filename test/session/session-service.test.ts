import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PageState } from '../../src/browser/tab.ts';
import { createSessionService, type SessionEvent } from '../../src/session/session-service.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import type { Runner, StartOptions } from '../../src/task/start-task.ts';
import { fakeTab, page, scriptedJev } from '../fakes.ts';

const AT = new Date(2026, 10, 2, 9, 5);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A runner whose tasks are real `BrowserTask`s on fake tabs, driven by a scripted Jev. */
const fakeRunner = (script: Record<string, any>[] = [{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }], pages?: PageState[]) => {
  const { ask } = scriptedJev(script);
  const tabs: ReturnType<typeof fakeTab>['tab'][] = [];
  const started: StartOptions[] = [];
  const runner = {
    start: vi.fn(async (options: StartOptions) => {
      started.push(options);
      const { url, tab: _tab, confirmIrreversible, confirmTarget, allowedHosts: _allowed, blockedHosts: _blocked, ...taskOptions } = options;
      if (url?.includes('blocked.example')) throw new Error('Not opened: blocked.example is in JEVWAY_BLOCKED_HOSTS');
      const fake = fakeTab(pages ?? [page({ fingerprint: 'a' }), page({ fingerprint: 'b', url: 'http://fixture/stays/2' })]);
      tabs.push(fake.tab);
      const task = new BrowserTask(fake.asTab, ask, { changeWaitMs: 0, ...taskOptions });
      task.update({ confirmIrreversible, confirmTarget });
      return task;
    }),
    look: vi.fn(async ({ url, tab }: { url?: string; tab?: string }) => page({ url: url ?? `http://fixture/${tab}`, text: 'Looked at' })),
    startJourney: vi.fn(async (options: { outDir: string; startUrl: string }) => ({
      outDir: options.outDir,
      report: () => ({ screen: { id: 's01', url: options.startUrl } }),
      preview: async () => 'PREVIEW',
      step: async () => ({ screen: { id: 's02' } }),
      autopilot: async () => ({ stopped: 'checkpoint', screen: { id: 's03' } }),
      annotate: vi.fn(),
      finish: vi.fn(async () => ({ screens: 3 })),
    })),
    close: vi.fn(async () => undefined),
  };
  return { runner: runner as unknown as Runner & typeof runner, tabs, started };
};

const outDir = () => join(mkdtempSync(join(tmpdir(), 'jev-service-')), '.jevway');
const service = (runner: Runner, options: Parameters<typeof createSessionService>[1] = {}) =>
  createSessionService(runner, { outDir: outDir(), now: () => AT, env: {}, ...options });

describe('a task session', () => {
  it('starts with an opaque id and a run folder named for its goal, holding the end page', async () => {
    const { runner } = fakeRunner();
    const root = outDir();
    const sessions = createSessionService(runner, { outDir: root, now: () => AT, env: {} });
    const result = await sessions.task({ goal: 'Book a stay in Lisbon', url: 'http://fixture/stays' });

    expect(result.session).toMatch(UUID);
    expect(result.summary.status).toBe('done');
    const runDir = join(root, 'runs', `2026-11-02_0905_book-a-stay-in-lisbon_${result.session.slice(0, 4)}`);
    expect(result.files).toEqual({ run_dir: runDir, screenshot: join(runDir, 'final.jpg'), manifest: join(runDir, 'manifest.json') });
    expect(result.screenshot?.toString()).toBe('final page');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('continues a session on the same tab with the new values, and numbers the call', async () => {
    const { runner } = fakeRunner([{ operation: 'BLOCKED' }, { operation: 'DONE' }]);
    const sessions = service(runner);
    const first = await sessions.task({ goal: 'Book', url: 'http://fixture/stays' });
    expect(first.summary.status).toBe('needs_input');
    const next = await sessions.task({ goal: 'Book', session: first.session, values: { email: 'ada@example.com' } });
    expect(next.session).toBe(first.session);
    expect(next.summary.status).toBe('done');
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(next.files!.run_dir, 'calls')).sort()).toEqual(['01-needs-input.jpg', '02-done.jpg']);
  });

  it('says why a session is unknown and what to do instead', async () => {
    const { runner } = fakeRunner();
    const sessions = service(runner, { idleMs: 60 * 60 * 1000 });
    const unknown = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const message = `Unknown session "${unknown}". Sessions end when the server restarts or after 1 h idle; start a new one with \`url\` (or \`tab\`).`;
    await expect(sessions.task({ goal: 'Open', session: unknown })).rejects.toMatchObject({ code: 'unknown_session', message });
    await expect(sessions.end(unknown)).rejects.toThrow(message);
    await expect(sessions.look({ session: unknown })).rejects.toThrow(message);
    await expect(service(runner).end(unknown)).rejects.toThrow('Sessions end when the server restarts; start a new one');
  });

  it('runs a session\'s next call only after a cancelled one has finished its input', async () => {
    const events: string[] = [];
    let calls = 0;
    const slowTask = {
      update: vi.fn(),
      lastCall: undefined,
      run: async ({ signal }: { signal?: AbortSignal } = {}) => {
        const index = calls++;
        events.push(`start ${index}`);
        await new Promise((resolve) => {
          if (index !== 1) return setTimeout(resolve, 20);
          signal?.addEventListener('abort', () => setTimeout(resolve, 50), { once: true });
        });
        events.push(`end ${index}`);
        return { status: signal?.aborted ? 'blocked' : 'done', reason: 'ok', steps: [] };
      },
    };
    const { runner } = fakeRunner();
    runner.start.mockResolvedValue(slowTask as unknown as BrowserTask);
    const sessions = service(runner);
    const { session } = await sessions.task({ goal: 'Open', url: 'http://fixture/' });
    const controller = new AbortController();
    const cancelled = sessions.task({ goal: 'Open', session }, { signal: controller.signal });
    await vi.waitFor(() => expect(events).toContain('start 1'));
    controller.abort();
    const next = sessions.task({ goal: 'Open', session });
    expect((await cancelled).summary.status).toBe('blocked');
    expect((await next).summary.status).toBe('done');
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('ends a session by closing the tabs it opened, and only those', async () => {
    const { runner, tabs } = fakeRunner();
    const sessions = service(runner);
    const opened = await sessions.task({ goal: 'Open', url: 'http://fixture/' });
    const pointed = await sessions.task({ goal: 'Open', tab: 'fixture' });
    const kept = await sessions.task({ goal: 'Open', url: 'http://fixture/' });

    expect(await sessions.end(opened.session)).toEqual({ session: opened.session, run_dir: opened.files!.run_dir });
    await sessions.end(pointed.session);
    await sessions.end(kept.session, { keepTab: true });
    expect(tabs.map((tab) => tab.closes)).toEqual([1, 0, 0]);
    await expect(sessions.task({ goal: 'Open', session: opened.session })).rejects.toMatchObject({ code: 'unknown_session' });
  });

  it('tells the caller when the call starts, each step as a sentence, and how it ended', async () => {
    const { runner } = fakeRunner([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'CLICK', click_target: '1' },
      { operation: 'DONE' },
    ], [page({ fingerprint: 'a' }), page({ fingerprint: 'b', url: 'http://fixture/stays/2' }), page({ fingerprint: 'c', url: 'http://fixture/stays/3' })]);
    const events: SessionEvent[] = [];
    const { session } = await service(runner).task(
      { goal: 'Book', url: 'http://fixture/stays', values: { email: 'ada@example.com' } },
      { onEvent: (event) => events.push(event) },
    );
    expect(events).toEqual([
      { type: 'started', session },
      // The fake page never shows what was typed, and the story says so.
      { type: 'step', session, n: 1, story: 'Typed the "email" value into "Email address"; the field did not keep the text.', url: 'http://fixture/stays/2' },
      { type: 'step', session, n: 2, story: 'Clicked "Open Full name".', url: 'http://fixture/stays/3' },
      { type: 'finished', session, status: 'done' },
    ]);
  });

  it('keeps the recording in the run folder with `record`, or in `recordDir` when one is named', async () => {
    const { runner, started } = fakeRunner();
    const sessions = service(runner);
    const recorded = await sessions.task({ goal: 'Open', url: 'http://fixture/', record: true });
    expect(recorded.files?.page).toBe(join(recorded.files!.run_dir, 'index.html'));
    expect(started[0].output).toEqual({ dir: recorded.files!.run_dir, record: true });

    const elsewhere = mkdtempSync(join(tmpdir(), 'jev-record-'));
    const named = await sessions.task({ goal: 'Open', url: 'http://fixture/', recordDir: elsewhere });
    expect(named.files?.run_dir).toBe(elsewhere);
    expect(existsSync(join(elsewhere, 'index.html'))).toBe(true);

    const plain = await sessions.task({ goal: 'Open', url: 'http://fixture/' });
    expect(plain.files?.page).toBeUndefined();
  });

  it('never names a run folder, or lists a goal, with a secret value in it', async () => {
    const { runner } = fakeRunner();
    const sessions = service(runner);
    const result = await sessions.task({ goal: 'Paste ghp_Q9xLm2 into Settings', url: 'http://fixture/', values: { token: 'ghp_Q9xLm2' }, secretKeys: ['token'] });
    expect(result.files?.run_dir).toMatch(/_paste-secret-token-into-settings_/);
    expect(sessions.listSessions()).toEqual([
      expect.objectContaining({ session: result.session, kind: 'task', goal: 'Paste [secret:token] into Settings' }),
    ]);
  });

  it('lists open sessions with what they are doing and where their files are', async () => {
    const { runner } = fakeRunner();
    const sessions = service(runner);
    const { session, files } = await sessions.task({ goal: 'Open', url: 'http://fixture/' });
    expect(sessions.listSessions()).toEqual([
      {
        session,
        kind: 'task',
        goal: 'Open',
        status: 'done',
        url: 'http://fixture/stays/2',
        running: false,
        started_at: AT.toISOString(),
        last_used_at: AT.toISOString(),
        run_dir: files!.run_dir,
      },
    ]);
  });

  it('refuses a start page outside the hosts with the runner\'s own message', async () => {
    const { runner } = fakeRunner();
    await expect(service(runner).task({ goal: 'Open', url: 'http://blocked.example/' })).rejects.toThrow('Not opened: blocked.example');
  });
});

describe('look', () => {
  it('reads exactly one of a session, a tab or a url, with nothing the caller could act on', async () => {
    const { runner } = fakeRunner();
    const sessions = service(runner);
    await expect(sessions.look({})).rejects.toThrow('Pass exactly one of session, tab or url.');
    await expect(sessions.look({ tab: 'a', url: 'http://b/' })).rejects.toThrow('Pass exactly one of session, tab or url.');
    expect(await sessions.look({ url: 'http://fixture/x' })).toMatchObject({ url: 'http://fixture/x', page_text: 'Looked at' });

    const { session } = await sessions.task({ goal: 'Open', url: 'http://fixture/' });
    const look = await sessions.look({ session });
    expect(look.url).toBe('http://fixture/stays/2');
    expect(JSON.stringify(look)).not.toMatch(/"(node|id|rect)"/);
  });
});

describe('a look with a PDF of the page', () => {
  it("saves a session tab's PDF in its run folder, and a URL's in a look folder of its own", async () => {
    const { runner } = fakeRunner();
    runner.look.mockImplementation(async ({ url, pdf }: { url?: string; pdf?: boolean }) => ({
      ...page({ url: url!, title: 'Pricing', text: 'Looked at' }),
      ...(pdf && { pdf: Buffer.from('%PDF-1.4 url') }),
    }));
    const root = outDir();
    const sessions = createSessionService(runner, { outDir: root, now: () => AT, env: {}, newId: () => 'ab12cd34-0000-4000-8000-000000000000' });

    const byUrl = await sessions.look({ url: 'https://stays.example/pricing', pdf: true });
    expect(runner.look).toHaveBeenLastCalledWith({ url: 'https://stays.example/pricing', tab: undefined, pdf: true });
    expect(byUrl.pdf).toBe(join(root, 'looks', '2026-11-02_0905_stays.example_ab12', 'page.pdf'));
    expect(readFileSync(byUrl.pdf!, 'utf8')).toBe('%PDF-1.4 url');
    expect(await sessions.look({ url: 'https://stays.example/pricing' })).not.toHaveProperty('pdf');

    const { session, files } = await sessions.task({ goal: 'Open', url: 'http://fixture/' });
    const bySession = await sessions.look({ session, pdf: true });
    expect(bySession.pdf).toBe(join(files!.run_dir, 'looks', '01-staylist.pdf'));
    expect(readFileSync(bySession.pdf!, 'utf8')).toBe('%PDF-1.4 fake');
    const manifest = JSON.parse(readFileSync(join(files!.run_dir, 'manifest.json'), 'utf8'));
    expect(manifest.files.find((file: { path: string }) => file.path === 'looks/01-staylist.pdf')?.kind).toBe('pdf');
  });
});

describe('journeys', () => {
  it('maps a journey into a folder named for its host, and steps it by id', async () => {
    const { runner } = fakeRunner();
    const root = outDir();
    const sessions = createSessionService(runner, { outDir: root, now: () => AT, env: {} });
    const started = await sessions.journeyStart({ url: 'https://stays.example:8443/home' });
    expect(started.journey).toMatch(UUID);
    expect(started.preview).toBe('PREVIEW');
    expect(started.report).toEqual({ screen: { id: 's01', url: 'https://stays.example:8443/home' } });
    expect(runner.startJourney.mock.calls[0][0].outDir).toBe(join(root, 'journeys', `2026-11-02_0905_stays.example-8443_${started.journey.slice(0, 4)}`));

    expect((await sessions.journeyStep(started.journey, { next: 4 })).report).toEqual({ screen: { id: 's02' } });
    expect((await sessions.journeyAutopilot(started.journey, { screens: 2 })).report).toMatchObject({ stopped: 'checkpoint' });
    sessions.journeyAnnotate(started.journey, 's02', { description: 'Results' });
    expect(sessions.listSessions()).toEqual([expect.objectContaining({ session: started.journey, kind: 'journey', url: 'https://stays.example:8443/home' })]);
    expect(await sessions.journeyFinish(started.journey)).toMatchObject({ screens: 3 });
    await expect(sessions.journeyStep(started.journey, { next: 1 })).rejects.toMatchObject({ code: 'unknown_session' });
  });

  it('keeps JEVWAY_JOURNEYS_DIR as the journeys root and `outDir` as the exact folder', async () => {
    const { runner } = fakeRunner();
    const base = mkdtempSync(join(tmpdir(), 'jev-journeys-'));
    const sessions = createSessionService(runner, { outDir: outDir(), now: () => AT, env: { JEVWAY_JOURNEYS_DIR: base } });
    const { journey } = await sessions.journeyStart({ url: 'https://stays.example/' });
    expect(runner.startJourney.mock.calls[0][0].outDir).toBe(join(base, `2026-11-02_0905_stays.example_${journey.slice(0, 4)}`));
    await sessions.journeyStart({ url: 'https://stays.example/', outDir: join(base, 'mine') });
    expect(runner.startJourney.mock.calls[1][0].outDir).toBe(join(base, 'mine'));
  });
});
