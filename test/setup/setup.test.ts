import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Machine } from '../../src/setup/clients.ts';
import type { Finding } from '../../src/setup/doctor.ts';
import { runSetup } from '../../src/setup/setup-command.ts';
import { setupWizard, type Prompter, type SetupDeps } from '../../src/setup/setup-wizard.ts';
import { captureStdout } from './stdout.ts';

const KEY = 'ts_live_SECRETVALUE_0123456789';
const SKILL = join(import.meta.dirname, '..', '..', 'skill', 'jevway');

/**
 * A person at the terminal: each prompt takes the first unused answer whose pattern matches the question, else
 * presses Enter. `screen` is everything that would show: what setup says, each question, and visible answers echoed.
 */
const person = (answers: [RegExp, string][] = []) => {
  const pending = [...answers];
  const screen: string[] = [];
  const questions: string[] = [];
  const answer = (question: string) => {
    questions.push(question);
    const index = pending.findIndex(([pattern]) => pattern.test(question));
    return index === -1 ? '' : pending.splice(index, 1)[0][1];
  };
  const io: Prompter = {
    say: (text) => void screen.push(text),
    ask: async (question) => {
      const reply = answer(question);
      screen.push(`${question}${reply}`);
      return reply;
    },
    askHidden: async (question) => {
      screen.push(question);
      return answer(question);
    },
  };
  return { io, screen: () => screen.join('\n'), questions, unused: () => pending };
};

const ok = (area: string, message: string): Finding => ({ level: 'ok', area, message });

const setupOn = (files: Record<string, string> = {}, { binaries = [] as string[], env = {} as Record<string, string>, fromEnvFile = [] as string[] } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'jevway-home-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(home, path, '..'), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  const machine: Machine = { home, env: { ...env }, onPath: (binary) => binaries.includes(binary) };
  const deps: SetupDeps = {
    machine,
    envFile: join(home, '.config', 'jevway', 'env'),
    fromEnvFile: [...fromEnvFile],
    checkBrowser: vi.fn(async (source: string) => ok('Browser', `${source}: fine`)),
    checkLive: vi.fn(async () => ok('Live', 'jev-1.14.0 answered one request in 300 ms')),
    run: vi.fn(async () => ({ ok: true, output: 'Added stdio MCP server jevway' })),
    doctor: vi.fn(async () => ({ report: 'ok    Node: 24.21.0\n\nReady.\n', ready: true })),
    skillSource: SKILL,
  };
  const envText = () => (existsSync(deps.envFile) ? readFileSync(deps.envFile, 'utf8') : undefined);
  return { home, machine, deps, envText };
};

describe('jevway setup without a terminal (an agent ran it)', () => {
  it('exits 2 with a structured error that names --client --print and the env-file steps, and asks nothing', async () => {
    const { code, output } = await captureStdout(() => runSetup([]));
    expect(code).toBe(2);
    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: {
        code: 'needs_tty',
        message: expect.stringContaining('jevway setup --client <name> --print'),
        hint: expect.stringMatching(/chmod 600 .*jevway\/env.*--client <claude-code\|codex\|cursor\|opencode\|other> --print/s),
      },
    });
  });
});

describe('jevway setup: the key', () => {
  it('reads the key hidden, saves only its line with mode 600, keeps the other lines, and never shows it', async () => {
    const { deps, envText, machine } = setupOn({ '.config/jevway/env': '# mine\nJEVWAY_MODEL=clef\n' });
    const you = person([[/Paste your TYPESAFE_API_KEY/, KEY]]);
    await setupWizard(you.io, deps);
    expect(envText()).toBe(`# mine\nJEVWAY_MODEL=clef\nTYPESAFE_API_KEY=${KEY}\n`);
    expect(statSync(deps.envFile).mode & 0o777).toBe(0o600);
    expect(you.screen()).not.toContain('SECRETVALUE');
    expect(you.screen()).toMatch(/Saved TYPESAFE_API_KEY to .*jevway\/env/);
    // The closing doctor sees the new key.
    expect(machine.env.TYPESAFE_API_KEY).toBe(KEY);
    expect(deps.fromEnvFile).toContain('TYPESAFE_API_KEY');
  });

  it('OpenRouter is the other route, and its key goes in OPENROUTER_API_KEY', async () => {
    const { deps, envText } = setupOn();
    await setupWizard(person([[/Which route/, '2'], [/Paste your OPENROUTER_API_KEY/, 'sk-or-v1-abcdef0123456789']]).io, deps);
    expect(envText()).toBe('OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\n');
  });

  it('an OpenRouter key without the sk-or- prefix is saved only after a yes', async () => {
    const { deps, envText } = setupOn();
    const you = person([[/Which route/, '2'], [/Paste your OPENROUTER_API_KEY/, KEY]]);
    await setupWizard(you.io, deps);
    expect(you.questions.some((question) => /does not look like an OpenRouter key/.test(question))).toBe(true);
    expect(envText()).toBeUndefined();
  });

  it('asks again for a key with spaces or too short, and gives up after three tries without writing', async () => {
    const { deps, envText } = setupOn();
    const you = person([
      [/Paste your/, 'short'],
      [/Paste your/, 'has a space in it 0123456789'],
      [/Paste your/, ''],
    ]);
    await setupWizard(you.io, deps);
    expect(you.questions.filter((question) => /Paste your/.test(question))).toHaveLength(3);
    expect(you.screen()).toMatch(/No key saved/);
    expect(envText()).toBeUndefined();
  });

  it('keeps a key that is already set unless the person says replace', async () => {
    const { deps, envText } = setupOn({ '.config/jevway/env': 'TYPESAFE_API_KEY=existing-key-0123456789\n' }, { env: { TYPESAFE_API_KEY: 'existing-key-0123456789' }, fromEnvFile: ['TYPESAFE_API_KEY'] });
    const you = person();
    await setupWizard(you.io, deps);
    expect(you.screen()).toMatch(/TYPESAFE_API_KEY is already set \(from .*jevway\/env\)/);
    expect(you.screen()).not.toContain('existing-key');
    expect(you.questions.some((question) => /Paste your/.test(question))).toBe(false);
    expect(envText()).toBe('TYPESAFE_API_KEY=existing-key-0123456789\n');
  });

  it('replacing a key replaces its line, and says when the environment would still win', async () => {
    const { deps, envText } = setupOn({ '.config/jevway/env': 'TYPESAFE_API_KEY=old-key-0123456789abc\n' }, { env: { TYPESAFE_API_KEY: 'shell-key-0123456789' } });
    const you = person([[/Replace it/, 'y'], [/Paste your TYPESAFE_API_KEY/, KEY]]);
    await setupWizard(you.io, deps);
    expect(envText()).toBe(`TYPESAFE_API_KEY=${KEY}\n`);
    expect(you.screen()).toMatch(/TYPESAFE_API_KEY is also set in your environment, which wins over the file/);
  });

  it('offers one real request as a check, off unless the person says yes', async () => {
    const declined = setupOn();
    await setupWizard(person([[/Paste your/, KEY]]).io, declined.deps);
    expect(declined.deps.checkLive).not.toHaveBeenCalled();

    const accepted = setupOn();
    const you = person([[/Paste your/, KEY], [/one real request/, 'y']]);
    await setupWizard(you.io, accepted.deps);
    expect(accepted.deps.checkLive).toHaveBeenCalledOnce();
    expect(you.screen()).toMatch(/jev-1\.14\.0 answered one request/);
  });
});

describe('jevway setup: the browser', () => {
  it('auto is the default: tested, and nothing written for it', async () => {
    const { deps, envText } = setupOn();
    const you = person();
    await setupWizard(you.io, deps);
    expect(you.screen()).toMatch(/auto .*chrome:\/\/inspect/);
    expect(deps.checkBrowser).toHaveBeenCalledWith('auto');
    expect(envText()).toBeUndefined();
  });

  it('launch is tested and written as JEVWAY_BROWSER', async () => {
    const { deps, envText, machine } = setupOn();
    await setupWizard(person([[/Which browser/, '2']]).io, deps);
    expect(deps.checkBrowser).toHaveBeenCalledWith('launch');
    expect(envText()).toBe('JEVWAY_BROWSER=launch\n');
    expect(machine.env.JEVWAY_BROWSER).toBe('launch');
  });

  it('a port becomes a local debugging URL', async () => {
    const { deps, envText } = setupOn();
    await setupWizard(person([[/Which browser/, '4'], [/Port/, '9333']]).io, deps);
    expect(deps.checkBrowser).toHaveBeenCalledWith('http://127.0.0.1:9333');
    expect(envText()).toBe('JEVWAY_BROWSER=http://127.0.0.1:9333\n');
  });

  it('a failed test shows the fix and offers another choice', async () => {
    const { deps, envText } = setupOn();
    deps.checkBrowser = vi.fn(async (source: string) =>
      source === 'auto'
        ? ({ level: 'fail', area: 'Browser', message: 'auto: no running Chrome allows remote debugging', fix: 'Open chrome://inspect/#remote-debugging' } as Finding)
        : ok('Browser', `${source}: fine`),
    );
    const you = person([[/Which browser/, '1'], [/Choose another/, 'y'], [/Which browser/, '3']]);
    await setupWizard(you.io, deps);
    expect(you.screen()).toMatch(/Fix: Open chrome:\/\/inspect/);
    expect(envText()).toBe('JEVWAY_BROWSER=launch-headless\n');
  });

  it('choosing auto removes a JEVWAY_BROWSER line left from before', async () => {
    const { deps, envText } = setupOn({ '.config/jevway/env': 'JEVWAY_BROWSER=launch\nJEVWAY_MODEL=clef\n' }, { env: { JEVWAY_BROWSER: 'launch' }, fromEnvFile: ['JEVWAY_BROWSER'] });
    await setupWizard(person([[/Which browser/, '1']]).io, deps);
    expect(envText()).toBe('JEVWAY_MODEL=clef\n');
  });
});

describe('jevway setup: MCP clients', () => {
  const cursorConfig = `{\n  "mcpServers": {\n    "other": {\n      "command": "other-mcp"\n    }\n  }\n}\n`;

  it('shows the diff for a config file and writes nothing without a yes', async () => {
    const { deps, home } = setupOn({ '.cursor/mcp.json': cursorConfig });
    const you = person();
    await setupWizard(you.io, deps);
    expect(you.screen()).toContain('--- ~/.cursor/mcp.json');
    expect(you.screen()).toContain('+    "jevway": {');
    expect(readFileSync(join(home, '.cursor/mcp.json'), 'utf8')).toBe(cursorConfig);
  });

  it('writes the change on a yes, keeping the other servers', async () => {
    const { deps, home } = setupOn({ '.cursor/mcp.json': cursorConfig });
    await setupWizard(person([[/Write this change to ~\/\.cursor\/mcp\.json/, 'y']]).io, deps);
    expect(JSON.parse(readFileSync(join(home, '.cursor/mcp.json'), 'utf8')).mcpServers).toEqual({
      other: { command: 'other-mcp' },
      jevway: { command: 'npx', args: ['-y', '-p', 'jevway', 'jevway-mcp'] },
    });
  });

  it('shows the command for Claude Code and runs it only on a yes', async () => {
    const declined = setupOn({}, { binaries: ['claude'] });
    const you = person();
    await setupWizard(you.io, declined.deps);
    expect(you.screen()).toContain('claude mcp add jevway -s user -- npx -y -p jevway jevway-mcp');
    expect(declined.deps.run).not.toHaveBeenCalled();

    const accepted = setupOn({}, { binaries: ['claude'] });
    await setupWizard(person([[/Run it/, 'y']]).io, accepted.deps);
    expect(accepted.deps.run).toHaveBeenCalledWith(['claude', 'mcp', 'add', 'jevway', '-s', 'user', '--', 'npx', '-y', '-p', 'jevway', 'jevway-mcp']);
  });

  it('skips a client that already has jevway, and says so', async () => {
    const { deps } = setupOn({ '.codex/config.toml': '[mcp_servers.jevway]\ncommand = "npx"\n' });
    const you = person();
    await setupWizard(you.io, deps);
    expect(you.screen()).toMatch(/Codex: jevway is already registered/);
    expect(you.questions.some((question) => /Run it/.test(question))).toBe(false);
  });

  it('leaves a file that is not plain JSON alone and shows what to add by hand', async () => {
    const jsonc = '{\n  // servers\n  "mcpServers": {}\n}\n';
    const { deps, home } = setupOn({ '.cursor/mcp.json': jsonc });
    const you = person([[/Write this change/, 'y']]);
    await setupWizard(you.io, deps);
    expect(you.screen()).toMatch(/not plain JSON.*\n.*"jevway"/s);
    expect(readFileSync(join(home, '.cursor/mcp.json'), 'utf8')).toBe(jsonc);
  });

  it('offers to copy the skill into the client’s skills folder, only on a yes', async () => {
    const { deps, home } = setupOn({ '.codex/config.toml': '' });
    const you = person([[/Copy the jevway skill to ~\/\.codex\/skills\/jevway/, 'y']]);
    await setupWizard(you.io, deps);
    expect(readFileSync(join(home, '.codex/skills/jevway/SKILL.md'), 'utf8')).toBe(readFileSync(join(SKILL, 'SKILL.md'), 'utf8'));
  });

  it('with no client found, points at --client other --print', async () => {
    const you = person();
    await setupWizard(you.io, setupOn().deps);
    expect(you.screen()).toMatch(/No Claude Code, Codex, Cursor or OpenCode found.*jevway setup --client other --print/s);
  });
});

describe('jevway setup: the end', () => {
  it('ends with the doctor report and one thing to try first', async () => {
    const { deps } = setupOn();
    const you = person();
    const code = await setupWizard(you.io, deps);
    expect(code).toBe(0);
    expect(you.screen()).toMatch(/Ready\.\n[\s\S]*Try first: /);
  });

  it('exits 1 when the doctor still finds a blocker', async () => {
    const { deps } = setupOn();
    deps.doctor = vi.fn(async () => ({ report: 'FAIL  Key: …\n', ready: false }));
    expect(await setupWizard(person().io, deps)).toBe(1);
  });
});
