import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMail, verificationEmail } from '../inbox/fake-mail.ts';
import { fakeRunner } from '../fakes.ts';
import { cliWith, daemonHarness, tempDir } from './harness.ts';

// `jevway inbox`: one JSON document per command, the password in the daemon's memory when one runs and otherwise in
// a mode-600 env file under .jevway/, never on stdout or stderr.

let mail: ReturnType<typeof fakeMail>;
beforeEach(() => {
  mail = fakeMail();
  vi.stubGlobal('fetch', mail.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const oneShot = () => {
  const cwd = tempDir();
  const { cli } = cliWith({ createRunner: () => fakeRunner().runner, cwd });
  return { cli, cwd };
};

const expectNoCredentials = (...texts: string[]) => {
  for (const secret of [...mail.passwords(), ...mail.tokens()]) for (const text of texts) expect(text).not.toContain(secret);
};

describe('jevway inbox without a daemon', () => {
  it('create prints the address and keeps the password in .jevway/inboxes/<address>.env, mode 600', async () => {
    const { cli, cwd } = oneShot();
    const { code, json, out, err } = await cli(['inbox', 'create']);
    expect(code).toBe(0);
    const file = join(cwd, '.jevway', 'inboxes', `${json.address}.env`);
    expect(json).toEqual({ ok: true, address: expect.stringMatching(/^test-[0-9a-f]{10}@tm-domain\.example$/), provider: 'mail.tm', kept_by: 'env_file', env_file: file, next: expect.stringContaining(`jevway inbox wait ${json.address}`) });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expectNoCredentials(out, err);
  });

  it('wait reads the env file and prints the code and links, exit 0', async () => {
    const { cli } = oneShot();
    const { address } = (await cli(['inbox', 'create'])).json;
    mail.arrive(address, verificationEmail());
    const { code, json, out, err } = await cli(['inbox', 'wait', address, '--from', 'staylist', '--subject', 'verify', '--timeout', '30']);
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, status: 'received', address, code: '482913', links: ['https://staylist.example/verify?token=abc&user=7'], text_excerpt: expect.stringContaining('482913') });
    expect(json.next).toMatch(/--secret-keys code/);
    expect(json.next).toMatch(/jevway run --url/);
    expectNoCredentials(out, err);
  });

  it('a wait that times out prints status timeout with progress on stderr, exit 1', async () => {
    const { cli } = oneShot();
    const { address } = (await cli(['inbox', 'create'])).json;
    const { code, json, events } = await cli(['inbox', 'wait', address, '--timeout', '1']);
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: true, status: 'timeout', address, next: expect.stringMatching(/1 s/) });
    expect(events[0]).toEqual({ type: 'inbox_wait', address, elapsed_s: 0, timeout_s: 1 });
  });

  it('list and read print the messages and one in full', async () => {
    const { cli } = oneShot();
    const { address } = (await cli(['inbox', 'create'])).json;
    mail.arrive(address, verificationEmail());
    expect((await cli(['inbox', 'list', address])).json).toEqual({
      ok: true,
      address,
      messages: [{ id: 'msg-1', from: 'no-reply@staylist.example', subject: 'Verify your Staylist account', received_at: '2026-11-02T09:05:00+00:00' }],
    });
    const read = await cli(['inbox', 'read', address, 'msg-1']);
    expect(read).toMatchObject({ code: 0, json: { ok: true, address, id: 'msg-1', code: '482913', text: expect.stringContaining('expires in 10 minutes') } });
  });

  it('an address with no inbox is unknown_inbox, exit 1; a missing argument is a usage error, exit 2', async () => {
    const { cli } = oneShot();
    expect(await cli(['inbox', 'wait', 'test-ffffffffff@tm-domain.example'])).toMatchObject({
      code: 1,
      json: { ok: false, error: { code: 'unknown_inbox', hint: expect.stringContaining('jevway inbox create') } },
    });
    expect(await cli(['inbox', 'wait'])).toMatchObject({ code: 2, json: { ok: false, error: { code: 'missing_flag' } } });
    expect(await cli(['inbox', 'wiat'])).toMatchObject({ code: 2, json: { ok: false, error: { code: 'unknown_command', hint: expect.stringContaining('jevway inbox wait') } } });
    expect(await cli(['inbox', 'wait', 'x@y.example', '--timeout', '0'])).toMatchObject({ code: 2, json: { ok: false, error: { code: 'invalid_value' } } });
  });

  it('starts with examples in its help', async () => {
    const { cli } = oneShot();
    for (const argv of [['inbox', '--help'], ['help', 'inbox'], ['inbox', 'wait', '--help']]) {
      const { code, out } = await cli(argv);
      expect(code, argv.join(' ')).toBe(0);
      expect(out, argv.join(' ')).toMatch(/^Examples:\n {2}jevway inbox /);
    }
    expect((await cli(['--help'])).out).toMatch(/\n {2}inbox {2,}/);
  });
});

describe('jevway inbox with the daemon running', () => {
  it('keeps the inbox in the daemon (no file) and waits through it, telling progress on stderr', async () => {
    const harness = daemonHarness();
    const daemon = await harness.serve();
    const cwd = tempDir();
    try {
      const created = await harness.cli(['inbox', 'create'], { cwd });
      expect(created).toMatchObject({ code: 0, json: { ok: true, kept_by: 'daemon', provider: 'mail.tm' } });
      expect(created.json.env_file).toBeUndefined();
      expect(existsSync(join(cwd, '.jevway', 'inboxes')) && readdirSync(join(cwd, '.jevway', 'inboxes'))).toBeFalsy();
      const { address } = created.json;
      mail.arrive(address, verificationEmail(), 1);
      const waited = await harness.cli(['inbox', 'wait', address, '--timeout', '30'], { cwd });
      expect(waited).toMatchObject({ code: 0, json: { ok: true, status: 'received', code: '482913' } });
      expect(waited.events[0]).toMatchObject({ type: 'inbox_wait', address, elapsed_s: 0 });
      expect((await harness.cli(['inbox', 'list', address], { cwd })).json.messages).toHaveLength(1);
      expectNoCredentials(created.out, waited.out, waited.err, JSON.stringify(harness.logged));
      expect(harness.logged.filter((entry) => entry.event === 'request').map((entry) => entry.method)).toEqual(
        expect.arrayContaining(['inbox.create', 'inbox.wait', 'inbox.list']),
      );
    } finally {
      await daemon.stop();
    }
  });

  it('falls back to the env file for an inbox made before the daemon started', async () => {
    const cwd = tempDir();
    const { cli } = cliWith({ createRunner: () => fakeRunner().runner, cwd });
    const { address } = (await cli(['inbox', 'create'])).json;
    const harness = daemonHarness();
    const daemon = await harness.serve();
    try {
      mail.arrive(address, verificationEmail());
      expect(await harness.cli(['inbox', 'wait', address], { cwd })).toMatchObject({ code: 0, json: { status: 'received' } });
    } finally {
      await daemon.stop();
    }
  });
});
