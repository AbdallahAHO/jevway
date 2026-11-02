import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENTS, detectClients, plannedChange, type Machine } from '../../src/setup/clients.ts';
import { runSetup } from '../../src/setup/setup-command.ts';
import { captureStdout } from './stdout.ts';

const SERVER_ARGS = ['-y', '-p', 'jevway', 'jevway-mcp'];

const machineWith = (files: Record<string, string> = {}, binaries: string[] = [], env: Record<string, string> = {}): Machine => {
  const home = mkdtempSync(join(tmpdir(), 'jevway-home-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(home, path, '..'), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  return { home, env, onPath: (binary) => binaries.includes(binary) };
};

const client = (name: string) => CLIENTS.find((candidate) => candidate.name === name)!;
const detected = (machine: Machine) => detectClients(machine).map(({ client, configured }) => `${client.name}${configured ? ' (configured)' : ''}`);

afterEach(() => vi.unstubAllEnvs());

describe('finding the MCP clients on this machine', () => {
  it('finds nothing on a bare machine', () => {
    expect(detected(machineWith())).toEqual([]);
  });

  it('finds a client by its command on PATH or by its config folder', () => {
    const machine = machineWith({ '.cursor/argv.json': '{}', '.config/opencode/opencode.json': '{}' }, ['claude', 'codex']);
    expect(detected(machine)).toEqual(['claude-code', 'codex', 'cursor', 'opencode']);
  });

  it('honours $CODEX_HOME and $XDG_CONFIG_HOME', () => {
    const machine = machineWith({ 'codex-home/config.toml': '', 'xdg/opencode/opencode.json': '{}' });
    machine.env = { CODEX_HOME: join(machine.home, 'codex-home'), XDG_CONFIG_HOME: join(machine.home, 'xdg') };
    expect(detected(machine)).toEqual(['codex', 'opencode']);
  });

  it('says which clients already have jevway, from each one’s own config', () => {
    const machine = machineWith({
      '.claude.json': JSON.stringify({ mcpServers: { jevway: { command: 'npx' } } }),
      '.codex/config.toml': '[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.jevway]\ncommand = "npx"\n',
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { other: {} } }),
      '.config/opencode/opencode.json': JSON.stringify({ mcp: { jevway: { type: 'local' } } }),
    });
    expect(detected(machine)).toEqual(['claude-code (configured)', 'codex (configured)', 'cursor', 'opencode (configured)']);
  });

  it('counts the Claude Code plugin as configured', () => {
    const machine = machineWith({ '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'jevway@jevway': [] } }) }, ['claude']);
    expect(detected(machine)).toEqual(['claude-code (configured)']);
  });
});

describe('what setup would change for each client', () => {
  it('Claude Code and Codex run their own mcp add command', () => {
    const machine = machineWith();
    expect(plannedChange(client('claude-code'), machine)).toEqual({
      kind: 'command',
      argv: ['claude', 'mcp', 'add', 'jevway', '-s', 'user', '--', 'npx', ...SERVER_ARGS],
      command: 'claude mcp add jevway -s user -- npx -y -p jevway jevway-mcp',
    });
    expect(plannedChange(client('codex'), machine)).toMatchObject({ kind: 'command', command: 'codex mcp add jevway -- npx -y -p jevway jevway-mcp' });
  });

  it('Cursor: adds only the jevway entry, keeps every other server, and shows it as a diff', () => {
    const before = `{\n    "mcpServers": {\n        "other": {\n            "command": "other-mcp"\n        }\n    },\n    "theme": "dark"\n}\n`;
    const machine = machineWith({ '.cursor/mcp.json': before });
    const change = plannedChange(client('cursor'), machine);
    expect(change).toMatchObject({ kind: 'edit', file: join(machine.home, '.cursor/mcp.json'), shownFile: '~/.cursor/mcp.json' });
    if (change.kind !== 'edit') throw new Error('expected an edit');
    expect(JSON.parse(change.next)).toEqual({
      mcpServers: { other: { command: 'other-mcp' }, jevway: { command: 'npx', args: SERVER_ARGS } },
      theme: 'dark',
    });
    // The file's own four-space indent is kept, so the diff shows only the insertion.
    expect(change.diff.split('\n').filter((line) => /^[-+](?![-+])/.test(line))).toEqual([
      '+        },',
      '+        "jevway": {',
      '+            "command": "npx",',
      '+            "args": [',
      '+                "-y",',
      '+                "-p",',
      '+                "jevway",',
      '+                "jevway-mcp"',
      '+            ]',
    ]);
  });

  it('Cursor without a config file: creates one', () => {
    const machine = machineWith({ '.cursor/argv.json': '{}' });
    const change = plannedChange(client('cursor'), machine);
    expect(change).toMatchObject({ kind: 'edit', diff: expect.stringMatching(/^--- \/dev\/null\n/) });
    if (change.kind === 'edit') expect(JSON.parse(change.next)).toEqual({ mcpServers: { jevway: { command: 'npx', args: SERVER_ARGS } } });
  });

  it('OpenCode: a local server under "mcp", and a new file gets its schema', () => {
    const machine = machineWith({ '.config/opencode/.keep': '' });
    const change = plannedChange(client('opencode'), machine);
    if (change.kind !== 'edit') throw new Error('expected an edit');
    expect(change.shownFile).toBe('~/.config/opencode/opencode.json');
    expect(JSON.parse(change.next)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { jevway: { type: 'local', command: ['npx', ...SERVER_ARGS], enabled: true } },
    });
  });

  it('never edits a file that is not plain JSON: it hands back the snippet to add by hand', () => {
    const machine = machineWith({ '.cursor/mcp.json': '{\n  // my servers\n  "mcpServers": {}\n}\n' });
    expect(plannedChange(client('cursor'), machine)).toEqual({
      kind: 'manual',
      file: join(machine.home, '.cursor/mcp.json'),
      shownFile: '~/.cursor/mcp.json',
      reason: expect.stringMatching(/not plain JSON/),
      snippet: expect.stringContaining('"jevway"'),
    });
  });

  it('never edits a file whose server list is not an object', () => {
    const machine = machineWith({ '.cursor/mcp.json': '{ "mcpServers": [] }' });
    expect(plannedChange(client('cursor'), machine)).toMatchObject({ kind: 'manual', reason: expect.stringMatching(/mcpServers/) });
  });
});

describe('jevway setup --client <name> --print (for installing agents)', () => {
  const print = (...argv: string[]) => captureStdout(() => runSetup(argv));

  it.each([
    ['claude-code', { client: 'claude-code', kind: 'command', command: 'claude mcp add jevway -s user -- npx -y -p jevway jevway-mcp', snippet: 'claude mcp add jevway -s user -- npx -y -p jevway jevway-mcp' }],
    [
      'codex',
      {
        client: 'codex',
        kind: 'command',
        command: 'codex mcp add jevway -- npx -y -p jevway jevway-mcp',
        file: '~/.codex/config.toml',
        snippet: '[mcp_servers.jevway]\ncommand = "npx"\nargs = ["-y", "-p", "jevway", "jevway-mcp"]\n',
      },
    ],
    ['cursor', { client: 'cursor', kind: 'config', file: '~/.cursor/mcp.json', snippet: JSON.stringify({ mcpServers: { jevway: { command: 'npx', args: SERVER_ARGS } } }, null, 2) }],
    [
      'opencode',
      {
        client: 'opencode',
        kind: 'config',
        file: '~/.config/opencode/opencode.json',
        snippet: JSON.stringify({ mcp: { jevway: { type: 'local', command: ['npx', ...SERVER_ARGS], enabled: true } } }, null, 2),
      },
    ],
    ['other', { client: 'other', kind: 'config', snippet: JSON.stringify({ command: 'npx', args: SERVER_ARGS }, null, 2) }],
  ])('%s --json gives { client, kind, command?, file?, snippet } and exits 0', async (name, expected) => {
    vi.stubEnv('CODEX_HOME', '');
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const { code, output } = await print('--client', name, '--print', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual(expected);
  });

  it('prints the command or snippet as text, saying where it goes', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const cursor = await print('--client', 'cursor', '--print');
    expect(cursor.code).toBe(0);
    expect(cursor.output).toMatch(/^# Cursor: merge into "mcpServers" in ~\/\.cursor\/mcp\.json/);
    expect(cursor.output).toContain('"jevway": {');
    expect((await print('--client', 'claude-code', '--print')).output).toMatch(/\nclaude mcp add jevway -s user -- npx -y -p jevway jevway-mcp\n/);
  });

  it('honours $XDG_CONFIG_HOME in the path it names', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/cfg');
    expect(JSON.parse((await print('--client', 'opencode', '--print', '--json')).output).file).toBe('/cfg/opencode/opencode.json');
  });

  it('changes nothing on disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jevway-home-'));
    vi.stubEnv('HOME', home);
    for (const name of ['claude-code', 'codex', 'cursor', 'opencode', 'other']) await print('--client', name, '--print');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(home)).toEqual([]);
  });

  it('an unknown client, or --print without --client, is a usage error naming the clients', async () => {
    for (const argv of [['--client', 'vscode', '--print'], ['--print']]) {
      const { code, output } = await print(...argv);
      expect(code).toBe(2);
      expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'usage', hint: expect.stringContaining('claude-code|codex|cursor|opencode|other') } });
    }
  });
});
