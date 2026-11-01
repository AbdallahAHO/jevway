import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ask } from '../src/jev/decide.ts';
import { diagnose, exitCode, liveCheck, planSteps, render, type Finding, type Probes } from '../src/setup/doctor.ts';

// A machine where everything is in place; each test breaks one thing.
const healthy = (overrides: Partial<Probes> = {}): Probes => ({
  nodeVersion: '24.21.0',
  browser: 'auto',
  fromEnvFile: [],
  envFile: { path: '~/.config/jevway/env' },
  findChrome: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  devToolsActivePort: () => ({ port: '9222', file: '/Users/ada/Library/Application Support/Google/Chrome/DevToolsActivePort' }),
  answers: async () => true,
  hasFfmpeg: async () => true,
  ...overrides,
});

const findingFor = (findings: Finding[], area: string) => findings.find((finding) => finding.area === area)!;

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('JEVWAY_MODEL', '');
  vi.stubEnv('JEVWAY_SCREENSHOTS', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('jevway doctor: the key and the route it selects', () => {
  it('no key at all blocks, and the fix says where a key goes without asking for it in chat', async () => {
    const findings = await diagnose(healthy());
    expect(findingFor(findings, 'Key')).toMatchObject({
      level: 'fail',
      message: expect.stringMatching(/neither TYPESAFE_API_KEY nor OPENROUTER_API_KEY is set/),
      fix: expect.stringMatching(/TYPESAFE_API_KEY=.*~\/\.config\/jevway\/env.*env block/s),
    });
    expect(exitCode(findings)).toBe(1);
  });

  it('TYPESAFE_API_KEY runs Jev on the TypeSafe API, and the line says where the key came from', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    const findings = await diagnose(healthy());
    expect(findingFor(findings, 'Key')).toMatchObject({
      level: 'ok',
      message: 'TYPESAFE_API_KEY from the environment: Jev (jev-1.14.0) on the TypeSafe API, with screenshots and Box',
    });
    expect(exitCode(findings)).toBe(0);
  });

  it('only OPENROUTER_API_KEY runs Jev through OpenRouter, without Box', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-1');
    const findings = await diagnose(healthy({ fromEnvFile: ['OPENROUTER_API_KEY'] }));
    expect(findingFor(findings, 'Key')).toMatchObject({
      level: 'ok',
      message: 'OPENROUTER_API_KEY from ~/.config/jevway/env: Jev (typesafe/jev-1.14) through OpenRouter, without Box',
    });
  });

  it('a model that needs OpenRouter blocks when only the TypeSafe key is set', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    vi.stubEnv('JEVWAY_MODEL', 'clef');
    expect(findingFor(await diagnose(healthy()), 'Key')).toMatchObject({
      level: 'fail',
      message: expect.stringMatching(/clef runs through OpenRouter, and OPENROUTER_API_KEY is not set/),
      fix: expect.stringMatching(/OPENROUTER_API_KEY.*or unset JEVWAY_MODEL/s),
    });
  });

  it('an unknown model blocks with the models that exist', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    const finding = findingFor(await diagnose(healthy({ model: 'gpt-9' })), 'Model');
    expect(finding).toMatchObject({ level: 'fail', message: expect.stringMatching(/Unknown model "gpt-9"; use jev \|/) });
  });

  it('never prints a key or any part of it', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-SECRET-4242');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-HIDDEN-7777');
    const findings = await diagnose(healthy({ nodeVersion: '22.1.0', browser: 'launch', findChrome: () => undefined }));
    const output = render(findings) + planSteps(findings);
    for (const part of ['SECRET', '4242', 'HIDDEN', '7777']) expect(output).not.toContain(part);
  });
});

describe('jevway doctor: node, browser and ffmpeg', () => {
  beforeEach(() => vi.stubEnv('TYPESAFE_API_KEY', 'ts-1'));

  it('Node below 24 blocks', async () => {
    expect(findingFor(await diagnose(healthy({ nodeVersion: '22.3.0' })), 'Node')).toMatchObject({
      level: 'fail',
      message: 'Node 22.3.0 is too old: jevway needs Node 24 or later',
      fix: expect.stringMatching(/Node 24/),
    });
  });

  it('launch without Chrome blocks and points at CHROME_PATH', async () => {
    const findings = await diagnose(healthy({ browser: 'launch-headless', findChrome: () => undefined }));
    expect(findingFor(findings, 'Browser')).toMatchObject({
      level: 'fail',
      message: 'launch-headless: Chrome not found',
      fix: expect.stringMatching(/CHROME_PATH/),
    });
  });

  it('launch with Chrome installed is ready and names it', async () => {
    const finding = findingFor(await diagnose(healthy({ browser: 'launch' })), 'Browser');
    expect(finding).toMatchObject({ level: 'ok', message: expect.stringMatching(/launch: a throwaway Chrome profile, \/Applications\/Google Chrome/) });
  });

  it('auto with no DevToolsActivePort blocks with the chrome://inspect hint', async () => {
    const finding = findingFor(await diagnose(healthy({ devToolsActivePort: () => undefined })), 'Browser');
    expect(finding).toMatchObject({
      level: 'fail',
      message: 'auto: no running Chrome allows remote debugging',
      fix: expect.stringMatching(/chrome:\/\/inspect\/#remote-debugging.*JEVWAY_BROWSER=launch/s),
    });
  });

  it("auto whose port doesn't answer blocks: Chrome closed or debugging turned off", async () => {
    const answers = vi.fn(async () => false);
    const finding = findingFor(await diagnose(healthy({ answers })), 'Browser');
    expect(answers).toHaveBeenCalledWith('http://127.0.0.1:9222/json/version');
    expect(finding).toMatchObject({
      level: 'fail',
      message: 'auto: Chrome listed port 9222 for remote debugging, but nothing answers there',
      fix: expect.stringMatching(/Start Chrome.*chrome:\/\/inspect\/#remote-debugging/s),
    });
  });

  it('auto with a port that answers is ready and says Chrome asks to allow the first connection', async () => {
    const finding = findingFor(await diagnose(healthy()), 'Browser');
    expect(finding).toMatchObject({ level: 'ok', message: expect.stringMatching(/auto: Chrome allows remote debugging on port 9222/) });
  });

  it('a debugging URL nobody answers blocks and names the address it tried', async () => {
    const answers = vi.fn(async () => false);
    const finding = findingFor(await diagnose(healthy({ browser: 'http://127.0.0.1:9333', answers })), 'Browser');
    expect(answers).toHaveBeenCalledWith('http://127.0.0.1:9333/json/version');
    expect(finding).toMatchObject({
      level: 'fail',
      message: 'http://127.0.0.1:9333: nothing answers at http://127.0.0.1:9333/json/version',
      fix: expect.stringMatching(/--remote-debugging-port=9333/),
    });
  });

  it('a ws:// endpoint is probed over http on the same host and port', async () => {
    const answers = vi.fn(async () => true);
    await diagnose(healthy({ browser: 'ws://127.0.0.1:9333/devtools/browser/abc', answers }));
    expect(answers).toHaveBeenCalledWith('http://127.0.0.1:9333/json/version');
  });

  it('a browser value that is no source blocks', async () => {
    expect(findingFor(await diagnose(healthy({ browser: 'chromium' })), 'Browser')).toMatchObject({
      level: 'fail',
      message: 'chromium is not auto, launch, launch-headless or a debugging URL',
    });
  });

  it('missing ffmpeg is only a warning: recordings lose their video', async () => {
    const findings = await diagnose(healthy({ hasFfmpeg: async () => false }));
    expect(findingFor(findings, 'ffmpeg')).toMatchObject({ level: 'warn', message: expect.stringMatching(/no run\.mp4/) });
    expect(exitCode(findings)).toBe(0);
  });

  it('an env file other users can read is a warning to chmod 600', async () => {
    const findings = await diagnose(healthy({ envFile: { path: '~/.config/jevway/env', mode: 0o644 } }));
    expect(findingFor(findings, 'Env file')).toMatchObject({ level: 'warn', fix: 'chmod 600 ~/.config/jevway/env' });
  });
});

describe('jevway doctor: what it prints', () => {
  it('prints location, cause and fix per line, and a verdict', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    const findings = await diagnose(healthy({ devToolsActivePort: () => undefined, hasFfmpeg: async () => false }));
    expect(render(findings)).toBe(
      [
        'ok    Node: 24.21.0',
        'ok    Key: TYPESAFE_API_KEY from the environment: Jev (jev-1.14.0) on the TypeSafe API, with screenshots and Box',
        'FAIL  Browser: auto: no running Chrome allows remote debugging',
        '      Fix: Open chrome://inspect/#remote-debugging in Chrome and allow it, or set JEVWAY_BROWSER=launch for a throwaway Chrome',
        'warn  ffmpeg: not found; recordings (record_dir) keep their screenshots but get no run.mp4',
        '      Fix: Install ffmpeg (macOS: brew install ffmpeg)',
        '',
        'Not ready: 1 problem blocks jevway. `jevway doctor --plan` lists the steps.',
        '',
      ].join('\n'),
    );
  });

  it('says ready when only warnings are left', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    expect(render(await diagnose(healthy({ hasFfmpeg: async () => false })))).toMatch(/\nReady, with 1 warning\.\n$/);
    expect(render(await diagnose(healthy()))).toMatch(/\nReady\.\n$/);
  });

  it('--plan numbers the steps left, blockers first', async () => {
    const findings = await diagnose(healthy({ nodeVersion: '22.3.0', hasFfmpeg: async () => false }));
    const steps = planSteps(findings).split('\n');
    expect(steps[0]).toBe('Steps left:');
    expect(steps[1]).toMatch(/^1\. Install Node 24/);
    expect(steps[2]).toMatch(/^2\. Put TYPESAFE_API_KEY=/);
    expect(steps[3]).toMatch(/^3\. \(optional\) Install ffmpeg/);
  });

  it('--plan with nothing left says so', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    expect(planSteps(await diagnose(healthy()))).toBe('Nothing left to set up: jevway is ready.\n');
  });
});

describe('jevway doctor --live: one real round trip', () => {
  const answering: Ask = async (request) => {
    const ids = Object.keys((request.questions.evidence as any).criteria);
    const probabilities = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0]));
    return { answers: { evidence: { choice: ids[0], confidence: 1, probabilities } }, usage: { input_tokens: 30 } };
  };

  it('reports the model and how long the answer took', async () => {
    expect(await liveCheck(answering, 'jev-1.14.0', [])).toMatchObject({
      level: 'ok',
      area: 'Live',
      message: expect.stringMatching(/^jev-1\.14\.0 answered one request in \d+ ms$/),
    });
  });

  it('a failed request blocks, and its message never carries the key', async () => {
    const failing: Ask = async () => {
      throw new Error('401 Unauthorized: key ts-SECRET-4242 is not valid');
    };
    const finding = await liveCheck(failing, 'jev-1.14.0', ['ts-SECRET-4242', undefined]);
    expect(finding).toMatchObject({ level: 'fail', message: 'jev-1.14.0: 401 Unauthorized: key [secret] is not valid' });
    expect(finding.fix).toMatch(/key/);
  });
});

describe('jevway doctor under JEVWAY_REPLAY', () => {
  it('warns that answers come from recordings, without blocking', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    const findings = await diagnose(healthy({ replay: { mode: 'replay', dir: '/work/verify/out/replay/default' } }));
    expect(findingFor(findings, 'Replay')).toMatchObject({
      level: 'warn',
      message: 'JEVWAY_REPLAY=replay: jevway answers from recordings in /work/verify/out/replay/default, not from Jev',
      fix: 'Unset JEVWAY_REPLAY for real use',
    });
    expect(exitCode(findings)).toBe(0);
  });

  it('says so while recording too, and says nothing when it is unset', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-1');
    const recording = await diagnose(healthy({ replay: { mode: 'record', dir: '/work/rec' } }));
    expect(findingFor(recording, 'Replay').message).toBe('JEVWAY_REPLAY=record: jevway saves every Jev answer into /work/rec');
    expect(findingFor(await diagnose(healthy()), 'Replay')).toBeUndefined();
  });

  it('checks the real key and route, not the recorded ones', async () => {
    vi.stubEnv('JEVWAY_REPLAY', 'replay');
    vi.stubEnv('JEVWAY_REPLAY_DIR', '/nonexistent/replay');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-1');
    const findings = await diagnose(healthy({ replay: { mode: 'replay', dir: '/nonexistent/replay' } }));
    expect(findingFor(findings, 'Model')).toBeUndefined();
    expect(findingFor(findings, 'Key').level).toBe('ok');
  });
});
