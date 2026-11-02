import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cliNext } from '../../src/cli/run-command.ts';
import { nextFor } from '../../src/task/present.ts';
import type { TaskStatus } from '../../src/task/run-task.ts';
import { fakeRunner, gatedAsk, scriptedJev } from '../fakes.ts';
import { cliWith, tempDir, VERSION } from './harness.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GOAL = ['--url', 'http://fixture/stays', '--goal', 'Book a stay in Lisbon'];

const setup = (options: Parameters<typeof fakeRunner>[0] = {}) => {
  const fake = fakeRunner(options);
  const created: { browser: string; choice: object }[] = [];
  const harness = cliWith({
    createRunner: (browser, choice) => {
      created.push({ browser, choice });
      return fake.runner;
    },
  });
  return { ...fake, ...harness, created };
};

const expectNoStackTrace = (text: string) => expect(text).not.toMatch(/\n\s+at |node:internal/);

describe('help and version', () => {
  it('starts every help with examples, then the flags', async () => {
    const { cli } = setup();
    for (const argv of [['--help'], ['help'], ['help', 'run'], ['run', '--help'], ['look', '-h'], ['journey', '--help'], ['journey', 'step', '--help'], ['help', 'sessions'], ['end', '--help'], ['serve', '--help'], ['stop', '--help'], ['help', 'doctor'], ['help', 'setup'], ['help', 'skill'], ['doctor', '--help'], ['skill', '-h']]) {
      const { code, out, err } = await cli(argv);
      expect(code, argv.join(' ')).toBe(0);
      expect(out, argv.join(' ')).toMatch(/^Examples:\n {2}jevway /);
      expect(err).toBe('');
    }
    const { out } = await cli(['run', '--help']);
    expect(out.indexOf('Examples:')).toBeLessThan(out.indexOf('--values <json>'));
    expect(out).toMatch(/--session <id\|new>/);
  });

  it('prints the version alone', async () => {
    const { cli } = setup();
    expect(await cli(['--version'])).toMatchObject({ code: 0, out: `${VERSION}\n`, err: '' });
  });
});

describe('usage errors', () => {
  it('names a mistyped flag and the one meant, as one JSON document, exit 2', async () => {
    const { cli, runner } = setup();
    const { code, json, err } = await cli(['run', ...GOAL, '--vales', '{}']);
    expect(code).toBe(2);
    expect(json).toEqual({ ok: false, error: { code: 'unknown_flag', message: 'Unknown flag --vales', hint: 'Did you mean --values? See jevway run --help' } });
    expect(err).toBe('');
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('suggests the command meant, and lists the commands when nothing is given', async () => {
    const { cli } = setup();
    expect(await cli(['rn'])).toMatchObject({ code: 2, json: { ok: false, error: { code: 'unknown_command', message: 'Unknown command "rn"', hint: 'Did you mean jevway run? See jevway --help' } } });
    const bare = await cli([]);
    expect(bare.code).toBe(2);
    expect(bare.json.error).toMatchObject({ code: 'missing_command' });
    expect(bare.json.error.hint).toMatch(/jevway run --url/);
    expect((await cli(['journey', 'strat'])).json.error).toMatchObject({ code: 'unknown_command', hint: 'Did you mean jevway journey start? See jevway journey --help' });
  });

  it('asks for the flags a run needs', async () => {
    const { cli } = setup();
    expect((await cli(['run', '--url', 'http://fixture/'])).json.error).toMatchObject({ code: 'missing_flag', message: 'jevway run needs --goal' });
    const noPage = await cli(['run', '--goal', 'Open it']);
    expect(noPage.code).toBe(2);
    expect(noPage.json.error).toMatchObject({ code: 'missing_flag', message: 'jevway run needs --url or --tab (or --session to continue)' });
  });

  it('names a JSON flag that does not parse, with an example', async () => {
    const { cli } = setup();
    const { code, json } = await cli(['run', ...GOAL, '--values', "{city:'Lisbon'}"]);
    expect(code).toBe(2);
    expect(json.error.code).toBe('invalid_value');
    expect(json.error.message).toMatch(/^--values: Expected property name/);
    expect(json.error.hint).toBe(`Example: --values '{"city":"Lisbon"}'`);
    expect((await cli(['run', ...GOAL, '--checks', '[{"type":"nope"}]'])).json.error).toMatchObject({ code: 'invalid_value', message: expect.stringMatching(/^--checks: /) });
    expect((await cli(['run', ...GOAL, '--detail', 'everything'])).json.error).toMatchObject({ code: 'invalid_value', message: '--detail must be concise or full, got "everything"' });
    expect((await cli(['run', ...GOAL, '--browser', 'firefox'])).json.error).toMatchObject({ code: 'invalid_value' });
  });

  it('passes --totp through, and refuses a bad authenticator secret as a usage error naming the key, never the secret', async () => {
    const { cli, runner, started } = setup();
    await cli(['run', ...GOAL, '--totp', '{"otp":"JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"}']);
    expect(started[0].totp).toEqual({ otp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
    const { code, json, out, err } = await cli(['run', ...GOAL, '--totp', '{"otp":"JBSW1Y3DP-PRIVATEPART"}']);
    expect(code).toBe(2);
    expect(json.error).toMatchObject({ code: 'invalid_value', message: expect.stringMatching(/^--totp: totp\.otp: /) });
    expect(out + err).not.toContain('PRIVATEPART');
    // A secret passed without its JSON wrapper is not quoted back by the parse error either.
    const bare = await cli(['run', ...GOAL, '--totp', 'JBSWY3DPEHPK3PXPPRIVATEPART']);
    expect(bare.json.error).toMatchObject({ code: 'invalid_value', message: '--totp must be a JSON object of key to secret' });
    expect(bare.out + bare.err).not.toContain('PRIVATEPART');
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('reports a missing key as a usage error before any browser starts', async () => {
    const { cli, runner } = setup();
    runner.requireKey.mockImplementation(() => {
      throw new Error('No API key: set TYPESAFE_API_KEY');
    });
    const { code, json } = await cli(['run', ...GOAL]);
    expect(code).toBe(2);
    expect(json).toEqual({ ok: false, error: { code: 'missing_key', message: 'No API key: set TYPESAFE_API_KEY', hint: 'Run jevway setup in a terminal, or see jevway doctor' } });
    expect(runner.start).not.toHaveBeenCalled();
  });
});

describe('a one-shot run', () => {
  it('prints one concise JSON result with the story and absolute file paths, and progress as NDJSON on stderr', async () => {
    const { cli, tabs } = setup();
    const cwd = tempDir();
    const { code, json, events } = await cli(['run', ...GOAL], { cwd });

    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, status: 'done', story: ['Clicked "Open Full name".'], url: 'http://fixture/stays/2' });
    expect(json.session).toBeUndefined();
    expect(json.steps).toBeUndefined();
    expect(json.files.run_dir).toMatch(new RegExp(`^${join(cwd, '.jevway', 'runs')}/\\d{4}-\\d{2}-\\d{2}_\\d{4}_book-a-stay-in-lisbon_[0-9a-f]{4}$`));
    expect(json.files.screenshot).toBe(join(json.files.run_dir, 'final.jpg'));
    expect(existsSync(json.files.manifest)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['started', 'step', 'finished']);
    expect(events[1]).toMatchObject({ n: 1, story: 'Clicked "Open Full name".', session: expect.stringMatching(UUID) });
    expect(tabs[0].closes).toBe(1);
  });

  it('is what `jevway --goal …` runs, as before', async () => {
    const { cli, created } = setup();
    const { code, json } = await cli([...GOAL, '--browser', 'launch-headless']);
    expect(code).toBe(0);
    expect(json.status).toBe('done');
    expect(created[0].browser).toBe('launch-headless');
  });

  it('exits 1 on a hand-back and says what to do next in flags', async () => {
    const { cli } = setup({ ask: scriptedJev([{ operation: 'BLOCKED' }]).ask });
    const { code, json } = await cli(['run', ...GOAL]);
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: true, status: 'needs_input' });
    expect(json.next).toBe('Add the missing values to `--values` and run again. Pass `--session new` to keep the tab between calls.');
  });

  it('adds the raw steps and stats with --detail full', async () => {
    const { cli } = setup();
    const { json } = await cli(['run', ...GOAL, '--detail', 'full']);
    expect(json.steps).toHaveLength(1);
    expect(json.jev).toBeDefined();
  });

  it('keeps the tabs open with --keep-open', async () => {
    const { cli, tabs } = setup();
    await cli(['run', ...GOAL, '--keep-open']);
    expect(tabs[0].closes).toBe(0);
  });

  it('records into the run folder with --record, and into a folder with --record <dir> as before', async () => {
    const { cli, started } = setup();
    const cwd = tempDir();
    await cli(['run', ...GOAL, '--record'], { cwd });
    expect(started[0].output).toMatchObject({ record: true });
    await cli(['run', ...GOAL, '--record', 'rec'], { cwd });
    expect(started[1].output).toEqual({ dir: join(cwd, 'rec'), record: true });
    await cli(['run', ...GOAL, '--record-dir', 'rec2'], { cwd });
    expect(started[2].output).toEqual({ dir: join(cwd, 'rec2'), record: true });
  });

  it('passes every task flag through', async () => {
    const { cli, started, created } = setup();
    await cli([
      'run', ...GOAL,
      '--values', '{"token":"s3cret-value","city":"Lisbon"}', '--secret-keys', 'token', '--files', '{"avatar":"/abs/me.png"}',
      '--done-when', 'A stay is booked', '--checks', '[{"type":"url_contains","text":"/stays/"}]', '--max-steps', '7',
      '--max-seconds', '60', '--allowed-hosts', 'fixture,*.example.com', '--blocked-hosts', 'ads.example',
      '--confirm-irreversible', '--confirm-target', 'Lisbon', '--allow-coordinate-clicks', '--model', 'jev', '--screenshots', 'off', '--screenshot',
    ]);
    expect(started[0]).toMatchObject({
      goal: 'Book a stay in Lisbon',
      url: 'http://fixture/stays',
      values: { token: 's3cret-value', city: 'Lisbon' },
      secretKeys: ['token'],
      files: { avatar: '/abs/me.png' },
      doneWhen: 'A stay is booked',
      checks: [{ type: 'url_contains', text: '/stays/' }],
      maxSteps: 7,
      maxSeconds: 60,
      allowedHosts: ['fixture', '*.example.com'],
      blockedHosts: ['ads.example'],
      confirmIrreversible: true,
      confirmTarget: 'Lisbon',
      allowCoordinateClicks: true,
    });
    expect(created[0]).toEqual({ browser: 'auto', choice: { model: 'jev', screenshots: 'off' } });
  });

  it('takes the browser and model from JEVWAY_BROWSER and JEVWAY_MODEL when no flag names them', async () => {
    const { cli, created } = setup();
    await cli(['run', ...GOAL], { env: { JEVWAY_BROWSER: 'launch', JEVWAY_MODEL: 'clef' } });
    expect(created[0]).toEqual({ browser: 'launch', choice: { model: 'clef' } });
  });

  it('ends blocked on Ctrl-C and still prints its one result', async () => {
    const gated = gatedAsk(scriptedJev([{ operation: 'DONE' }]).ask);
    const { cli, interrupts } = setup({ ask: gated.ask });
    const running = cli(['run', ...GOAL]);
    await vi.waitFor(() => expect(gated.asked.length).toBeGreaterThan(0));
    interrupts.forEach((press) => press());
    const { code, json } = await running;
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: true, status: 'blocked', reason: expect.stringMatching(/Cancelled by the caller/) });
  });

  it('reports a failure to start as a tool error, exit 1, with no stack trace', async () => {
    const { cli, runner } = setup();
    runner.start.mockRejectedValueOnce(new Error('Not opened: fixture is a blocked host (fixture)'));
    const { code, json, out, err } = await cli(['run', ...GOAL]);
    expect(code).toBe(1);
    expect(json).toEqual({ ok: false, error: { code: 'failed', message: 'Not opened: fixture is a blocked host (fixture)', hint: expect.any(String) } });
    expectNoStackTrace(out + err);
    expect(runner.close).toHaveBeenCalled();
  });
});

describe('looking at a page', () => {
  it('reads a URL in-process and prints what it shows', async () => {
    const { cli, runner } = setup();
    const { code, json } = await cli(['look', '--url', 'http://fixture/about']);
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, url: 'http://fixture/about', page_text: expect.stringContaining('Looked at'), elements: expect.any(Array) });
    expect(runner.close).toHaveBeenCalled();
  });

  it('wants exactly one of --url, --tab or --session', async () => {
    const { cli } = setup();
    expect((await cli(['look'])).json.error).toMatchObject({ code: 'missing_flag', message: 'jevway look needs one of --url, --tab or --session' });
    expect((await cli(['look', '--url', 'http://a/', '--tab', 'b'])).code).toBe(2);
  });
});

describe('without a daemon', () => {
  it('lists no sessions, stops nothing, and knows no session, without starting one', async () => {
    const { cli } = setup();
    expect(await cli(['sessions'])).toMatchObject({ code: 0, json: { ok: true, daemon: null, sessions: [] } });
    expect(await cli(['stop'])).toMatchObject({ code: 0, json: { ok: true, stopped: false } });
    const end = await cli(['end', 'f47ac10b-58cc-4372-a567-0e02b2c3d479']);
    expect(end.code).toBe(1);
    expect(end.json.error).toMatchObject({ code: 'unknown_session' });
    expect((await cli(['look', '--session', 'f47ac10b-58cc-4372-a567-0e02b2c3d479'])).json.error.code).toBe('unknown_session');
  });
});

describe('what to do next, in flags', () => {
  const statuses: TaskStatus[] = ['done', 'needs_input', 'needs_confirmation', 'uncertain', 'step_budget', 'blocked'];

  it('names flags and the session to pass, never an MCP parameter', () => {
    for (const status of statuses) {
      const next = cliNext(nextFor({ status }), 'abc');
      expect(next, status).not.toMatch(/`(values|goal|confirm_irreversible|confirm_target|max_steps|max_seconds)\b/);
      expect(next, status).not.toMatch(/this session/);
    }
    expect(cliNext(nextFor({ status: 'needs_confirmation' }), 'abc')).toMatch(/run again with `--session abc`, `--confirm-irreversible` and `--confirm-target`/);
    expect(cliNext(nextFor({ status: 'done' }), 'abc')).toBe('Read the result in `page_text` (and `evidence`); end it with `jevway end abc` when you no longer need its tab.');
    expect(cliNext(nextFor({ status: 'done' }), undefined)).toBe('Read the result in `page_text` (and `evidence`).');
    expect(cliNext(nextFor({ status: 'step_budget' }), 'abc')).toMatch(/`--max-steps` \/ `--max-seconds`/);
  });
});
