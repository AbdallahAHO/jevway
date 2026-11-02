import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { daemonAccess } from '../../src/daemon/client.ts';
import { cliWith, daemonHarness, FINGERPRINT, tempDir, VERSION } from '../cli/harness.ts';
import { fakeRunner, gatedAsk, scriptedJev } from '../fakes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEW = ['run', '--session', 'new', '--url', 'http://fixture/stays', '--goal', 'Book a stay'];

const harnesses: ReturnType<typeof daemonHarness>[] = [];
const harness = (options: Parameters<typeof daemonHarness>[0] = {}) => {
  const made = daemonHarness(options);
  harnesses.push(made);
  return made;
};
afterEach(async () => {
  for (const { started } of harnesses.splice(0)) await Promise.all(started.map((daemon) => daemon.stop()));
});

const twoCalls = () => fakeRunner({ ask: scriptedJev([{ operation: 'BLOCKED' }, { operation: 'DONE' }]).ask });

describe('sessions through the daemon', () => {
  it('starts the daemon on the first command that needs a session, and continues that session from the next command', async () => {
    const { runner, tabs } = twoCalls();
    const { cli, started } = harness({ runner });

    const first = await cli(NEW);
    expect(first.code).toBe(1);
    expect(first.json).toMatchObject({ ok: true, status: 'needs_input', session: expect.stringMatching(UUID) });
    expect(first.json.next).toBe(
      `Ask the user the \`ask_user\` question with your ask tool (unless their request already gives these values), then add the answers to \`--values\` and run again with \`--session ${first.json.session}\`.`,
    );
    expect(first.json.ask_user.then).toBe(`Run again with \`--session ${first.json.session}\` and the answers in \`--values\` keys "full_name", "email_address".`);
    expect(first.events[0]).toMatchObject({ type: 'daemon', event: 'started', pid: process.pid });
    expect(first.events.slice(1).map((event) => event.type)).toEqual(['started', 'finished']);

    const second = await cli(['run', '--session', first.json.session, '--goal', 'Book a stay', '--values', '{"email":"ada@example.com"}']);
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ ok: true, status: 'done', session: first.json.session });
    expect(second.json.files.run_dir).toBe(first.json.files.run_dir);
    expect(readdirSync(join(second.json.files.run_dir, 'calls')).sort()).toEqual(['01-needs-input.jpg', '02-done.jpg']);
    expect(second.events.map((event) => event.type)).toEqual(['started', 'finished']);
    expect(started).toHaveLength(1);
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(tabs[0].closes).toBe(0);
  });

  it('writes runs under the caller\'s working directory, whichever directory started the daemon', async () => {
    const { cli } = harness();
    const [one, two] = [tempDir(), tempDir()];
    const first = await cli(NEW, { cwd: one });
    const second = await cli(NEW, { cwd: two });
    expect(first.json.files.run_dir.startsWith(join(one, '.jevway', 'runs'))).toBe(true);
    expect(second.json.files.run_dir.startsWith(join(two, '.jevway', 'runs'))).toBe(true);
    expect(JSON.parse(readFileSync(join(one, '.jevway', 'sessions.json'), 'utf8')).sessions).toEqual([
      expect.objectContaining({ session: first.json.session, kind: 'task', goal: 'Book a stay', status: 'done' }),
    ]);
  });

  it('lists the open sessions, ends one, and then no longer knows it', async () => {
    const { cli } = harness();
    const cwd = tempDir();
    const run = await cli(NEW, { cwd });

    const listed = await cli(['sessions']);
    expect(listed.code).toBe(0);
    expect(listed.json).toMatchObject({ ok: true, daemon: { pid: process.pid, version: VERSION, idle_timeout_s: 3600 } });
    expect(listed.json.sessions).toEqual([
      expect.objectContaining({ session: run.json.session, kind: 'task', goal: 'Book a stay', status: 'done', url: 'http://fixture/stays/2', running: false, run_dir: run.json.files.run_dir }),
    ]);

    const looked = await cli(['look', '--session', run.json.session]);
    expect(looked).toMatchObject({ code: 0, json: { ok: true, session: run.json.session, url: expect.any(String) } });

    expect(await cli(['end', run.json.session])).toMatchObject({ code: 0, json: { ok: true, session: run.json.session, run_dir: run.json.files.run_dir } });
    expect((await cli(['sessions'])).json.sessions).toEqual([]);
    expect(JSON.parse(readFileSync(join(cwd, '.jevway', 'sessions.json'), 'utf8')).sessions).toEqual([]);
    const again = await cli(['run', '--session', run.json.session, '--goal', 'Book a stay']);
    expect(again.code).toBe(1);
    expect(again.json.error).toMatchObject({ code: 'unknown_session', message: expect.stringMatching(/after 1 h idle/) });
  });

  it('closes the tab a session opened when it ends, unless --keep-tab', async () => {
    const { runner, tabs } = fakeRunner();
    const { cli } = harness({ runner });
    const kept = await cli(NEW);
    const closed = await cli(NEW);
    await cli(['end', kept.json.session, '--keep-tab']);
    await cli(['end', closed.json.session]);
    expect(tabs.map((tab) => tab.closes)).toEqual([0, 1]);
  });

  it('stops: ends every session, closes the browser and removes the socket', async () => {
    const { runner, tabs } = fakeRunner();
    const { cli, started, socket } = harness({ runner });
    await cli(NEW);
    expect(await cli(['stop'])).toMatchObject({ code: 0, json: { ok: true, stopped: true, ended: 1 } });
    await started[0].closed;
    expect(tabs[0].closes).toBe(1);
    expect(runner.close).toHaveBeenCalled();
    expect(existsSync(socket)).toBe(false);
    expect((await cli(['sessions'])).json.daemon).toBeNull();
  });

  it('maps a journey through the daemon, giving the screenshot path instead of an inline image', async () => {
    const { cli } = harness();
    const cwd = tempDir();
    const start = await cli(['journey', 'start', '--url', 'http://fixture/', '--device', 'iphone-15'], { cwd });
    expect(start.code).toBe(0);
    expect(start.json).toMatchObject({ ok: true, journey: expect.stringMatching(UUID), screen: { id: 's01', screenshot: expect.stringMatching(/^\/.*screens\/s01-home\.png$/) } });
    expect(start.json.preview).toBeUndefined();
    expect(start.json.screen.screenshot.startsWith(join(cwd, '.jevway', 'journeys'))).toBe(true);
    const id = start.json.journey;
    expect((await cli(['journey', 'step', id, '--next', '3', '--flow', 'Search'])).json).toMatchObject({ ok: true, journey: id, screen: { id: 's02' } });
    expect((await cli(['journey', 'autopilot', id, '--screens', '2'])).json).toMatchObject({ ok: true, stopped: 'checkpoint' });
    expect((await cli(['journey', 'annotate', id, '--screen', 's02', '--description', 'Results'])).json).toMatchObject({ ok: true, journey: id, screen: 's02' });
    expect((await cli(['sessions'])).json.sessions).toEqual([expect.objectContaining({ session: id, kind: 'journey' })]);
    const finish = await cli(['journey', 'finish', id]);
    expect(finish.json).toMatchObject({ ok: true, screens: 3, manifest: expect.stringMatching(/manifest\.json$/) });
    expect((await cli(['journey', 'step', id, '--next', '1'])).json.error.code).toBe('unknown_session');
  });
});

describe('the daemon process', () => {
  it('reuses a running daemon instead of starting another', async () => {
    const { cli, started, serve } = harness();
    await serve();
    const run = await cli(NEW);
    expect(run.json.status).toBe('done');
    expect(run.events.some((event) => event.type === 'daemon')).toBe(false);
    expect(started).toHaveLength(1);
  });

  it('replaces a socket file nothing answers on', async () => {
    const { cli, socket, started } = harness();
    writeFileSync(socket, '');
    const run = await cli(NEW);
    expect(run.json.status).toBe('done');
    expect(started).toHaveLength(1);
  });

  it('restarts a daemon of another version that holds no sessions', async () => {
    const { cli, started, serve } = harness();
    const old = await serve('1.0.0');
    const run = await cli(NEW);
    expect(run.json.status).toBe('done');
    await old.closed;
    expect(started).toHaveLength(2);
    expect(run.events[0]).toMatchObject({ type: 'daemon', event: 'restarted', reason: `the running daemon is version 1.0.0, this jevway is ${VERSION}` });
  });

  it('refuses to restart a daemon of another version while it holds sessions', async () => {
    const stateDir = tempDir('jvd-');
    const older = harness({ stateDir, daemonVersion: '1.0.0' });
    const old = await older.serve();
    const oldCli = cliWith({ createRunner: () => older.runner, daemon: daemonAccess({ socket: older.socket, log: 'log', version: '1.0.0', fingerprint: FINGERPRINT, start: () => undefined }) }).cli;
    await oldCli(NEW);

    const { cli } = harness({ stateDir });
    const run = await cli(NEW);
    expect(run.code).toBe(1);
    expect(run.json.error).toMatchObject({
      code: 'daemon_busy',
      message: `the running daemon is version 1.0.0, this jevway is ${VERSION}, and it holds 1 session`,
      hint: 'List them with jevway sessions; jevway stop ends them and the next command starts a new daemon',
    });
    expect((await cli(['sessions'])).json.sessions).toHaveLength(1);
    await old.stop();
  });

  it('ends idle sessions, then exits once nothing is left', async () => {
    const { runner, tabs } = fakeRunner();
    const { cli, started, logged } = harness({ runner, idleMs: 150 });
    await cli(NEW);
    await started[0].closed;
    expect(tabs[0].closes).toBe(1);
    expect(runner.close).toHaveBeenCalled();
    expect(logged.map((entry) => entry.event)).toEqual(expect.arrayContaining(['idle_end', 'stopped']));
  });

  it('never writes a request\'s values to its log', async () => {
    const { cli, logged } = harness();
    await cli([...NEW, '--values', '{"token":"tok-123-secret"}', '--secret-keys', 'token']);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain('tok-123-secret');
    expect(logged).toContainEqual(expect.objectContaining({ event: 'request', method: 'task' }));
  });
});

describe('a call that loses the daemon', () => {
  it('cancels on Ctrl-C and still prints one result; the session stays usable', async () => {
    const gated = gatedAsk(scriptedJev([{ operation: 'DONE' }]).ask);
    const { runner } = fakeRunner({ ask: gated.ask });
    const { cli, interrupts } = harness({ runner });
    const running = cli(NEW);
    await vi.waitFor(() => expect(gated.asked.length).toBeGreaterThan(0));
    interrupts.forEach((press) => press());
    const { code, json } = await running;
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: true, status: 'blocked', reason: expect.stringMatching(/Cancelled by the caller/) });
    gated.release();
    expect((await cli(['run', '--session', json.session, '--goal', 'Book a stay'])).json.status).toBe('done');
  });

  it('is outcome_unknown when the connection drops mid-run, pointing at jevway look', async () => {
    const stateDir = tempDir('jvd-');
    const socket = join(stateDir, 'daemon.sock');
    const session = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    // A daemon that starts the call, tells its first event, then goes away.
    const server = createServer((connection: Socket) => {
      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const { id, method } = JSON.parse(line);
          if (method === 'hello') connection.write(`${JSON.stringify({ id, result: { version: VERSION, fingerprint: FINGERPRINT, pid: 1, sessions: 0, idle_timeout_s: 3600 } })}\n`);
          if (method === 'task') {
            connection.write(`${JSON.stringify({ id, event: { type: 'started', session } })}\n`);
            setTimeout(() => connection.destroy(), 20);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const { cli } = cliWith({ createRunner: () => fakeRunner().runner, daemon: daemonAccess({ socket, log: 'log', version: VERSION, fingerprint: FINGERPRINT, start: () => undefined }) });
    const { code, json, out } = await cli(NEW);
    server.close();
    expect(code).toBe(1);
    expect(json).toEqual({
      ok: false,
      error: {
        code: 'outcome_unknown',
        message: 'The daemon stopped answering while the call was running; it may already have clicked or typed.',
        hint: `Check the page with jevway look --session ${session} before repeating the call.`,
      },
    });
    expect(out.trim().split('\n').filter((line) => line.startsWith('{')).length).toBe(1);
  });
});
