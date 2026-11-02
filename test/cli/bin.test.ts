import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from './harness.ts';

const ENTRY = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const home = tempDir('jvb-');
// Nothing from this machine's setup: no env file, no real key (a stub passes the key check), a state dir of its own.
const ENV = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  JEVWAY_STATE_DIR: join(home, 'state'),
  JEVWAY_OUT_DIR: join(home, 'out'),
  TYPESAFE_API_KEY: 'stub-key-for-tests-0000',
};

const jevway = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [ENTRY, ...args], { env: ENV, cwd: home, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

afterAll(async () => {
  await jevway(['stop']);
});

describe('the jevway command', () => {
  it('prints its version', async () => {
    expect(await jevway(['--version'])).toMatchObject({ code: 0, stdout: `${version}\n` });
  });

  it('answers a mistyped flag with one JSON error and exit 2, never a stack trace', async () => {
    const { code, stdout, stderr } = await jevway(['run', '--vales', '{}']);
    expect(code).toBe(2);
    expect(JSON.parse(stdout).error).toMatchObject({ code: 'unknown_flag', hint: 'Did you mean --values? See jevway run --help' });
    expect(stderr).toBe('');
  });

  it('starts the daemon in the background for a new session, lists it, and stops it', async () => {
    // Nothing listens on port 9, so the run fails at the browser, after the daemon started.
    const run = await jevway(['run', '--session', 'new', '--browser', 'http://127.0.0.1:9', '--url', 'http://example.test/', '--goal', 'Open it']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, error: { code: 'failed' } });
    const events = run.stderr.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'daemon', event: 'started', log: join(home, 'state', 'daemon.log') });

    const listed = await jevway(['sessions']);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, daemon: { pid: events[0].pid, version }, sessions: [] });
    expect(JSON.parse((await jevway(['stop'])).stdout)).toMatchObject({ ok: true, stopped: true });
    expect(JSON.parse((await jevway(['sessions'])).stdout)).toMatchObject({ daemon: null });
  });
});
