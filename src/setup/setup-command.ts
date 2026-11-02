import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createLiveAsk, resolveModel } from '../jev/model.ts';
import { CLIENT_NAMES, onPathIn, printedRegistration, renderPrinted, type Machine, type PrintedRegistration } from './clients.ts';
import { print, printError, printJson } from './command-output.ts';
import { realProbes } from './doctor-command.ts';
import { browserFinding, diagnose, exitCode, liveCheck, render, type Finding } from './doctor.ts';
import { envFilePath, shownEnvFilePath } from './env-file.ts';
import { setupWizard, type SetupDeps } from './setup-wizard.ts';
import { bundledSkillDir } from './skill-command.ts';
import { terminalPrompter } from './terminal-prompter.ts';

const CLIENT_LIST = CLIENT_NAMES.join('|');

export const SETUP_USAGE = `Examples:
  jevway setup
  jevway setup --client codex --print
  jevway setup --client cursor --print --json

jevway setup                                   interactive: key, browser, MCP clients (needs a terminal)
jevway setup --client <${CLIENT_LIST}> --print [--json]
                                               print how to register jevway with that client; changes nothing

Examples:
  jevway setup
  jevway setup --client cursor --print
  jevway setup --client codex --print --json   # { client, kind, command?, file?, snippet }`;

const realMachine = (): Machine => ({ home: homedir(), env: process.env, onPath: onPathIn() });

const isClientName = (name: string): name is PrintedRegistration['client'] => (CLIENT_NAMES as readonly string[]).includes(name);

const liveFinding = async (): Promise<Finding> => {
  try {
    const { profile } = resolveModel({ live: true });
    return await liveCheck(createLiveAsk(profile), profile.model, [process.env.TYPESAFE_API_KEY, process.env.OPENROUTER_API_KEY]);
  } catch (error) {
    return { level: 'fail', area: 'Live', message: (error as Error).message, fix: 'Run `jevway doctor` for the details' };
  }
};

const runCommand = (argv: string[]) =>
  new Promise<{ ok: boolean; output: string }>((resolve) =>
    execFile(argv[0], argv.slice(1), { timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || (error?.message ?? '') }),
    ),
  );

const realDeps = (fromEnvFile: string[]): SetupDeps => ({
  machine: realMachine(),
  envFile: envFilePath(),
  fromEnvFile,
  checkBrowser: (source) => browserFinding(realProbes(source, undefined, fromEnvFile)),
  checkLive: liveFinding,
  run: runCommand,
  doctor: async () => {
    const findings = await diagnose(realProbes(process.env.JEVWAY_BROWSER?.trim() || 'auto', undefined, fromEnvFile));
    return { report: render(findings), ready: exitCode(findings) === 0 };
  },
  skillSource: bundledSkillDir(),
});

/** The env-file steps an agent hands to a person, who types the key in their own editor. */
const envFileSteps = () => {
  const path = shownEnvFilePath(envFilePath());
  const folder = path.replace(/\/env$/, '');
  return `mkdir -p ${folder} && touch ${path} && chmod 600 ${path}, then the person adds TYPESAFE_API_KEY=<key> in their own editor`;
};

/**
 * `jevway setup`: with `--client <name> --print`, prints how to register jevway with that client and changes nothing;
 * otherwise the interactive wizard, which needs a terminal and exits 2 without one.
 *
 * @example
 * process.exit(await runSetup(process.argv.slice(3), loadEnvFile()));
 */
export const runSetup = async (argv: string[], fromEnvFile: string[] = []): Promise<number> => {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        client: { type: 'string' },
        print: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    return printError(2, 'usage', `jevway setup: ${(error as Error).message}`, `jevway setup --client <${CLIENT_LIST}> --print [--json]`);
  }
  if (options.help) {
    await print(`${SETUP_USAGE}\n`);
    return 0;
  }
  if (options.print || options.client !== undefined || options.json) {
    if (!options.print || !options.client || !isClientName(options.client)) {
      const problem = !options.print ? '--client and --json go with --print' : options.client ? `unknown client "${options.client}"` : '--print needs --client';
      return printError(2, 'usage', `jevway setup: ${problem}`, `jevway setup --client <${CLIENT_LIST}> --print [--json]`);
    }
    const printed = printedRegistration(options.client, realMachine());
    await (options.json ? printJson(printed) : print(renderPrinted(printed)));
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return printError(
      2,
      'needs_tty',
      'jevway setup asks questions and needs a terminal. An agent registers jevway with `jevway setup --client <name> --print` (add --json for the fields), which changes nothing.',
      `Key: ${envFileSteps()}. Client: jevway setup --client <${CLIENT_LIST}> --print. Check: jevway doctor --json.`,
    );
  }
  const terminal = terminalPrompter();
  try {
    return await setupWizard(terminal.io, realDeps(fromEnvFile));
  } finally {
    terminal.close();
  }
};
