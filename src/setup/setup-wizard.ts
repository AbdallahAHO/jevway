import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { writeFileAtomic } from './atomic-write.ts';
import { detectClients, plannedChange, shownPath, type Client, type Machine } from './clients.ts';
import type { Finding } from './doctor.ts';
import { setEnvValue, writeEnvFile } from './env-file.ts';
import { installSkill, skillState } from './skill-command.ts';

/** The terminal, as setup uses it: `ask` echoes what is typed, `askHidden` does not. */
export interface Prompter {
  say: (text: string) => void;
  ask: (question: string) => Promise<string>;
  askHidden: (question: string) => Promise<string>;
}

/** Everything setup touches outside the terminal, injectable so each step can be tested without a machine. */
export interface SetupDeps {
  machine: Machine;
  /** The env file's absolute path. */
  envFile: string;
  /** Names `loadEnvFile` filled at start; setup adds the ones it writes, so the closing doctor says where they live. */
  fromEnvFile: string[];
  checkBrowser: (source: string) => Promise<Finding>;
  /** One real request with the key now in `machine.env`. */
  checkLive: () => Promise<Finding>;
  /** Runs a client's own command (never through a shell). */
  run: (argv: string[]) => Promise<{ ok: boolean; output: string }>;
  doctor: () => Promise<{ report: string; ready: boolean }>;
  /** The bundled `skill/jevway/` folder. */
  skillSource: string;
}

const KEY_NAMES = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'];

const KEY_ROUTES = [
  { value: 'TYPESAFE_API_KEY', label: 'TypeSafe (recommended): Jev on the TypeSafe API, with screenshots and Box' },
  { value: 'OPENROUTER_API_KEY', label: 'OpenRouter: Jev without Box, and the other models' },
];

const BROWSERS = [
  { value: 'auto', label: `${'auto'.padEnd(16)}your running Chrome: allow it once at chrome://inspect/#remote-debugging; you see every step` },
  { value: 'launch', label: `${'launch'.padEnd(16)}a throwaway Chrome profile jevway starts and closes, signed in nowhere` },
  { value: 'launch-headless', label: `${'launch-headless'.padEnd(16)}the same, without a window` },
  { value: 'port', label: `${'port'.padEnd(16)}a Chrome you started with --remote-debugging-port=<port> and its own --user-data-dir` },
];

const TRY_ON_CLI = `jevway --url https://en.wikipedia.org/wiki/Main_Page --goal "Open the Wikipedia article about the Rosetta Stone" --values '{"search_query":"Rosetta Stone"}'`;

const confirm = async (io: Prompter, question: string, fallback = false) => {
  const reply = (await io.ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return reply ? /^y(es)?$/.test(reply) : fallback;
};

const choose = async (io: Prompter, question: string, options: { value: string; label: string }[], fallback = 0) => {
  options.forEach(({ label }, index) => io.say(`  ${index + 1}. ${label}`));
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = (await io.ask(`${question} [${fallback + 1}] `)).trim();
    if (!reply) break;
    const chosen = options[Number(reply) - 1] ?? options.find(({ value }) => value === reply);
    if (chosen) return chosen.value;
    io.say(`Type a number from 1 to ${options.length}.`);
  }
  return options[fallback].value;
};

const formatFinding = ({ level, area, message, fix }: Finding) =>
  `${level === 'fail' ? 'FAIL' : level}  ${area}: ${message}${level !== 'ok' && fix ? `\n      Fix: ${fix}` : ''}`;

const readEnvText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/**
 * Why `key` cannot be an API key (too short, spaces, quotes or `#`), or undefined when its shape is plausible.
 * The message never repeats the key.
 */
export const keyShapeProblem = (key: string) => {
  if (key.length < 16) return 'That is too short for an API key. Paste the whole key.';
  if (/[^\x21-\x7e]|["'`#\\]/.test(key)) return 'An API key has no spaces, quotes or #. Paste just the key.';
  return undefined;
};

const keyStep = async (io: Prompter, { machine, envFile, fromEnvFile, checkLive }: SetupDeps) => {
  const shownFile = shownPath(envFile, machine.home);
  io.say('\n1/3 The API key');
  const existing = KEY_NAMES.find((name) => machine.env[name]?.trim());
  if (existing) {
    io.say(`${existing} is already set (from ${fromEnvFile.includes(existing) ? shownFile : 'your environment'}).`);
    if (!(await confirm(io, 'Replace it?'))) return;
  }
  const name = await choose(io, 'Which route?', KEY_ROUTES);
  let key: string | undefined;
  for (let attempt = 0; attempt < 3 && !key; attempt++) {
    const typed = (await io.askHidden(`Paste your ${name} (hidden as you type), then Enter: `)).trim();
    const problem = keyShapeProblem(typed);
    if (problem) io.say(problem);
    else key = typed;
  }
  if (!key) {
    io.say(`No key saved. Run jevway setup again, or add ${name}=<key> to ${shownFile} in your own editor.`);
    return;
  }
  if (name === 'OPENROUTER_API_KEY' && !key.startsWith('sk-or-') && !(await confirm(io, 'That does not look like an OpenRouter key (they start sk-or-). Save it anyway?'))) {
    io.say('No key saved.');
    return;
  }
  writeEnvFile(envFile, setEnvValue(readEnvText(envFile), name, key));
  io.say(`Saved ${name} to ${shownFile} (only you can read it; its other lines are kept).`);
  if (machine.env[name]?.trim() && !fromEnvFile.includes(name)) {
    io.say(`${name} is also set in your environment, which wins over the file: remove it there to use the new key.`);
  } else {
    machine.env[name] = key;
    if (!fromEnvFile.includes(name)) fromEnvFile.push(name);
  }
  if (await confirm(io, 'Check the key with one real request now? It costs a fraction of a cent.')) io.say(formatFinding(await checkLive()));
};

const askPort = async (io: Prompter) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = (await io.ask('Port Chrome listens on [9222] ')).trim() || '9222';
    if (/^\d+$/.test(reply) && Number(reply) > 0 && Number(reply) < 65536) return `http://127.0.0.1:${reply}`;
    io.say('Type a port number, such as 9222.');
  }
  return 'http://127.0.0.1:9222';
};

const browserStep = async (io: Prompter, { machine, envFile, fromEnvFile, checkBrowser }: SetupDeps) => {
  const shownFile = shownPath(envFile, machine.home);
  io.say('\n2/3 The browser jevway drives');
  const current = machine.env.JEVWAY_BROWSER?.trim() || 'auto';
  const currentIndex = BROWSERS.findIndex(({ value }) => value === (current.includes('://') ? 'port' : current));
  let source: string;
  for (;;) {
    const choice = await choose(io, 'Which browser?', BROWSERS, Math.max(0, currentIndex));
    source = choice === 'port' ? await askPort(io) : choice;
    const finding = await checkBrowser(source);
    io.say(formatFinding(finding));
    if (finding.level !== 'fail' || !(await confirm(io, 'Choose another? (No keeps this one; fix it later.)'))) break;
  }
  const text = readEnvText(envFile);
  const inFile = parseEnv(text).JEVWAY_BROWSER;
  if (source === 'auto' && inFile !== undefined) {
    writeEnvFile(envFile, setEnvValue(text, 'JEVWAY_BROWSER', undefined));
    io.say(`Removed JEVWAY_BROWSER=${inFile} from ${shownFile}: auto is the default.`);
  } else if (source !== 'auto' && inFile !== source) {
    writeEnvFile(envFile, setEnvValue(text, 'JEVWAY_BROWSER', source));
    io.say(`Saved JEVWAY_BROWSER=${source} to ${shownFile}.`);
  }
  const fromShell = machine.env.JEVWAY_BROWSER?.trim() && !fromEnvFile.includes('JEVWAY_BROWSER');
  if (fromShell && machine.env.JEVWAY_BROWSER !== source) {
    io.say(`JEVWAY_BROWSER=${machine.env.JEVWAY_BROWSER} is set in your environment, which wins over the file.`);
  } else if (source === 'auto') {
    delete machine.env.JEVWAY_BROWSER;
  } else {
    machine.env.JEVWAY_BROWSER = source;
  }
};

// Registers jevway with one client after showing exactly what changes; true when it is registered.
const register = async (io: Prompter, { machine, run }: SetupDeps, client: Client) => {
  const change = plannedChange(client, machine);
  if (change.kind === 'manual') {
    io.say(`${client.label}: ${change.reason}. Add this to ${change.shownFile} yourself:\n${change.snippet}`);
    return false;
  }
  if (change.kind === 'command') {
    io.say(`${client.label}: setup will run\n  ${change.command}`);
    if (!(await confirm(io, 'Run it?'))) return false;
    const result = await run(change.argv);
    io.say(result.ok ? `${client.label}: registered.` : `${client.label}: the command failed:\n${result.output.trim()}`);
    return result.ok;
  }
  io.say(`${client.label}: setup will change ${change.shownFile}:\n${change.diff}`);
  if (!(await confirm(io, `Write this change to ${change.shownFile}?`))) return false;
  if (readEnvText(change.file) !== (change.before ?? '')) {
    io.say(`${client.label}: ${change.shownFile} changed meanwhile; nothing written. Run jevway setup again.`);
    return false;
  }
  writeFileAtomic(change.file, change.next, change.before === undefined ? 0o644 : statSync(change.file).mode & 0o777);
  io.say(`${client.label}: registered in ${change.shownFile}.`);
  return true;
};

const offerSkill = async (io: Prompter, { machine, skillSource }: SetupDeps, client: Client) => {
  if (client.hasSkillBundled?.(machine)) return;
  const folder = client.skillsDir(machine);
  const shown = shownPath(join(folder, 'jevway'), machine.home);
  const state = skillState(skillSource, folder);
  if (state === 'same') return io.say(`${client.label}: the jevway skill is already in ${shown}.`);
  const question =
    state === 'different'
      ? `Replace the jevway skill in ${shown} with this version's?`
      : `Copy the jevway skill to ${shown}? It tells the agent when to hand a browser goal to jevway.`;
  if (!(await confirm(io, question))) return;
  installSkill(skillSource, folder, { force: true });
  io.say(`${client.label}: skill copied to ${shown}.`);
};

const clientsStep = async (io: Prompter, deps: SetupDeps) => {
  io.say('\n3/3 Your MCP clients');
  const found = detectClients(deps.machine);
  if (!found.length) {
    io.say('No Claude Code, Codex, Cursor or OpenCode found. For another MCP client: jevway setup --client other --print');
    return [];
  }
  const registered: string[] = [];
  for (const { client, configured } of found) {
    if (configured) io.say(`${client.label}: jevway is already registered; skipped.`);
    if (configured || (await register(io, deps, client))) registered.push(client.label);
    await offerSkill(io, deps, client);
  }
  return registered;
};

/**
 * The interactive setup: the key (hidden, into the env file only), the browser (tested before it is saved), and each
 * MCP client found (every change shown, made only on a yes), then the doctor's report and what to try first. Returns
 * 0 when the doctor finds jevway ready, 1 otherwise.
 *
 * @example
 * process.exitCode = await setupWizard(terminal.io, realDeps);
 */
export const setupWizard = async (io: Prompter, deps: SetupDeps): Promise<number> => {
  io.say(`jevway setup: the API key, the browser, then your MCP clients. Ctrl-C stops at any point; every file is either left as it was or written whole.`);
  await keyStep(io, deps);
  await browserStep(io, deps);
  const registered = await clientsStep(io, deps);
  io.say('\nChecking the setup (jevway doctor):');
  const { report, ready } = await deps.doctor();
  io.say(report.trimEnd());
  if (!ready) io.say('Try first: fix the FAIL lines above (`jevway doctor --plan` lists them), then run `jevway doctor` again.');
  else if (registered.length) io.say(`Try first: restart ${registered.join(' or ')} and ask it to "use jevway to open the Wikipedia article about the Rosetta Stone".`);
  else io.say(`Try first: ${TRY_ON_CLI}`);
  return ready ? 0 : 1;
};
