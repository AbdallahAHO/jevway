import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { envFilePath, shownEnvFilePath } from './env-file.ts';
import { unifiedDiff } from './unified-diff.ts';

type Env = Record<string, string | undefined>;

/** The machine setup looks at: the home folder, the environment, and whether a command is on PATH. */
export interface Machine {
  home: string;
  env: Env;
  onPath: (binary: string) => boolean;
}

const SERVER = { command: 'npx', args: ['-y', '-p', 'jevway', 'jevway-mcp'] };

interface CommandRegistration {
  kind: 'command';
  argv: string[];
  /** The config file the command writes, when it is worth naming, and the entry it writes there. */
  writes?: { file: (machine: Machine) => string; snippet: string };
}

interface ConfigRegistration {
  kind: 'config';
  file: (machine: Machine) => string;
  /** The key holding the servers (`mcpServers`, `mcp`), and the jevway entry under it. */
  container: string;
  entry: unknown;
  /** Top-level keys a new file starts with. */
  newFile?: Record<string, unknown>;
}

/** An MCP client setup knows how to find, check and register jevway with. */
export interface Client {
  name: 'claude-code' | 'codex' | 'cursor' | 'opencode';
  label: string;
  binary: string;
  /** Paths (config folders and files) any one of which means the client is installed. */
  markers: (machine: Machine) => string[];
  skillsDir: (machine: Machine) => string;
  /** True when the client's jevway install already brings the skill (the Claude Code plugin). */
  hasSkillBundled?: (machine: Machine) => boolean;
  isConfigured: (machine: Machine) => boolean;
  registration: CommandRegistration | ConfigRegistration;
}

const xdgConfig = ({ home, env }: Machine) => env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
const claudeFolder = ({ home, env }: Machine) => env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
const claudeJson = (machine: Machine) =>
  machine.env.CLAUDE_CONFIG_DIR?.trim() ? join(machine.env.CLAUDE_CONFIG_DIR.trim(), '.claude.json') : join(machine.home, '.claude.json');
const codexFolder = ({ home, env }: Machine) => env.CODEX_HOME?.trim() || join(home, '.codex');
const openCodeFolder = (machine: Machine) => join(xdgConfig(machine), 'opencode');

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

const readJson = (path: string): Record<string, any> | undefined => {
  try {
    const value = JSON.parse(readText(path) ?? '');
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
};

// A file that is not plain JSON (JSONC with comments) still counts when it names a jevway key.
const namesJevway = (path: string, container: string) => {
  const parsed = readJson(path);
  if (parsed) return Boolean(parsed[container]?.jevway);
  return /"jevway"\s*:/.test(readText(path) ?? '');
};

const hasClaudePlugin = (machine: Machine) =>
  Object.keys(readJson(join(claudeFolder(machine), 'plugins', 'installed_plugins.json'))?.plugins ?? {}).some((id) => id.startsWith('jevway@'));

const openCodeFile = (machine: Machine) => {
  const json = join(openCodeFolder(machine), 'opencode.json');
  const jsonc = join(openCodeFolder(machine), 'opencode.jsonc');
  return !existsSync(json) && existsSync(jsonc) ? jsonc : json;
};

/** The clients setup registers jevway with, in the order it offers them. */
export const CLIENTS: Client[] = [
  {
    name: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    markers: (machine) => [claudeFolder(machine), claudeJson(machine)],
    skillsDir: (machine) => join(claudeFolder(machine), 'skills'),
    hasSkillBundled: hasClaudePlugin,
    isConfigured: (machine) => Boolean(readJson(claudeJson(machine))?.mcpServers?.jevway) || hasClaudePlugin(machine),
    registration: { kind: 'command', argv: ['claude', 'mcp', 'add', 'jevway', '-s', 'user', '--', SERVER.command, ...SERVER.args] },
  },
  {
    name: 'codex',
    label: 'Codex',
    binary: 'codex',
    markers: (machine) => [codexFolder(machine)],
    skillsDir: (machine) => join(codexFolder(machine), 'skills'),
    isConfigured: (machine) => /^\s*\[mcp_servers\.(?:jevway|"jevway")\]/m.test(readText(join(codexFolder(machine), 'config.toml')) ?? ''),
    registration: {
      kind: 'command',
      argv: ['codex', 'mcp', 'add', 'jevway', '--', SERVER.command, ...SERVER.args],
      writes: {
        file: (machine) => join(codexFolder(machine), 'config.toml'),
        snippet: `[mcp_servers.jevway]\ncommand = "${SERVER.command}"\nargs = [${SERVER.args.map((arg) => `"${arg}"`).join(', ')}]\n`,
      },
    },
  },
  {
    name: 'cursor',
    label: 'Cursor',
    binary: 'cursor',
    markers: ({ home }) => [join(home, '.cursor')],
    skillsDir: ({ home }) => join(home, '.cursor', 'skills'),
    isConfigured: ({ home }) => namesJevway(join(home, '.cursor', 'mcp.json'), 'mcpServers'),
    registration: { kind: 'config', file: ({ home }) => join(home, '.cursor', 'mcp.json'), container: 'mcpServers', entry: SERVER },
  },
  {
    name: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    markers: (machine) => [openCodeFolder(machine)],
    skillsDir: (machine) => join(openCodeFolder(machine), 'skills'),
    isConfigured: (machine) => namesJevway(openCodeFile(machine), 'mcp'),
    registration: {
      kind: 'config',
      file: openCodeFile,
      container: 'mcp',
      entry: { type: 'local', command: [SERVER.command, ...SERVER.args], enabled: true },
      newFile: { $schema: 'https://opencode.ai/config.json' },
    },
  },
];

/** Names `--client` accepts: the known clients, and `other` for any stdio MCP client. */
export const CLIENT_NAMES = [...CLIENTS.map(({ name }) => name), 'other'] as const;

/**
 * Whether `binary` is an executable file in one of `PATH`'s folders. Scans the folders itself, never a shell, so a
 * shell function or alias of the same name does not count.
 */
export const onPathIn =
  (path = process.env.PATH ?? '') =>
  (binary: string) =>
    path
      .split(delimiter)
      .filter(Boolean)
      .some((folder) => (process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']).some((extension) => existsSync(join(folder, binary + extension))));

/** `path` with the home folder written as `~`, for messages. */
export const shownPath = (path: string, home: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * The clients installed on this machine (command on PATH or config present), and whether each already has a
 * jevway server.
 */
export const detectClients = (machine: Machine) =>
  CLIENTS.filter((client) => machine.onPath(client.binary) || client.markers(machine).some(existsSync)).map((client) => ({
    client,
    configured: client.isConfigured(machine),
  }));

const indentOf = (text: string) => /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';

const snippetFor = ({ container, entry }: ConfigRegistration) => JSON.stringify({ [container]: { jevway: entry } }, null, 2);

/** What registering jevway with a client would do, before anything is done. */
export type PlannedChange =
  | { kind: 'command'; argv: string[]; command: string }
  | { kind: 'edit'; file: string; shownFile: string; before?: string; next: string; diff: string }
  | { kind: 'manual'; file: string; shownFile: string; reason: string; snippet: string };

/**
 * What setup would do to register jevway with `client`: run its `mcp add` command, or add only the `jevway` entry to
 * its JSON config (the file's own indent kept, shown as a unified diff). A file that is not plain JSON, or whose server
 * list is not an object, is never edited: the change is `manual`, with the snippet to add by hand.
 *
 * @example
 * plannedChange(cursor, machine)
 * // { kind: 'edit', file: '/Users/ada/.cursor/mcp.json', shownFile: '~/.cursor/mcp.json', next: '{…}', diff: '--- …' }
 */
export const plannedChange = (client: Client, machine: Machine): PlannedChange => {
  const { registration } = client;
  if (registration.kind === 'command') return { kind: 'command', argv: registration.argv, command: registration.argv.join(' ') };
  const file = registration.file(machine);
  const shownFile = shownPath(file, machine.home);
  const before = readText(file);
  const manual = (reason: string): PlannedChange => ({ kind: 'manual', file, shownFile, reason, snippet: snippetFor(registration) });
  let config: Record<string, unknown>;
  try {
    config = before?.trim() ? JSON.parse(before) : { ...registration.newFile };
  } catch {
    return manual(`${shownFile} is not plain JSON (comments or trailing commas), so setup leaves it alone`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return manual(`${shownFile} does not hold a JSON object`);
  const servers = config[registration.container] ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) return manual(`"${registration.container}" in ${shownFile} is not an object`);
  const next = `${JSON.stringify({ ...config, [registration.container]: { ...servers, jevway: registration.entry } }, null, before ? indentOf(before) : 2)}\n`;
  return { kind: 'edit', file, shownFile, before, next, diff: unifiedDiff(before, next, shownFile) };
};

/** What `setup --client <name> --print --json` prints. */
export interface PrintedRegistration {
  client: (typeof CLIENT_NAMES)[number];
  kind: 'command' | 'config';
  command?: string;
  file?: string;
  snippet: string;
}

/**
 * The exact command or config snippet that registers jevway with a client, and where it goes; for `other`, the
 * server's command and args.
 *
 * @example
 * printedRegistration('codex', machine)
 * // { client: 'codex', kind: 'command', command: 'codex mcp add jevway -- npx …', file: '~/.codex/config.toml', snippet: '[mcp_servers.jevway]…' }
 */
export const printedRegistration = (name: PrintedRegistration['client'], machine: Machine): PrintedRegistration => {
  const client = CLIENTS.find((candidate) => candidate.name === name);
  if (!client) return { client: 'other', kind: 'config', snippet: JSON.stringify(SERVER, null, 2) };
  const { registration } = client;
  if (registration.kind === 'command') {
    const command = registration.argv.join(' ');
    return registration.writes
      ? { client: client.name, kind: 'command', command, file: shownPath(registration.writes.file(machine), machine.home), snippet: registration.writes.snippet }
      : { client: client.name, kind: 'command', command, snippet: command };
  }
  return { client: client.name, kind: 'config', file: shownPath(registration.file(machine), machine.home), snippet: snippetFor(registration) };
};

/**
 * `printedRegistration` as text: a `#` line saying what to do and where, then the command or snippet.
 *
 * @example
 * renderPrinted(printedRegistration('cursor', machine))
 * // '# Cursor: merge into "mcpServers" in ~/.cursor/mcp.json (keep the other servers)\n{\n  "mcpServers": …'
 */
export const renderPrinted = ({ client, kind, command, file, snippet }: PrintedRegistration, env: Env = process.env) => {
  const label = CLIENTS.find(({ name }) => name === client)?.label;
  const keyNote = `# The key stays in ${shownEnvFilePath(envFilePath(env))}, which jevway reads itself; never put it in this config.`;
  if (!label) return `# Any stdio MCP client: add a server named "jevway" that runs\n${snippet}\n${keyNote}\n`;
  if (kind === 'command') {
    const alternative = file && snippet !== command ? `# or add this to ${file} yourself:\n${snippet}` : '';
    return `# ${label}: run\n${command}\n${alternative}${keyNote}\n`;
  }
  const container = Object.keys(JSON.parse(snippet))[0];
  return `# ${label}: merge into "${container}" in ${file} (keep the other servers)\n${snippet}\n${keyNote}\n`;
};
