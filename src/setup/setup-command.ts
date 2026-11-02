import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { CLIENT_NAMES, onPathIn, printedRegistration, renderPrinted, type Machine, type PrintedRegistration } from './clients.ts';
import { print, printError, printJson } from './command-output.ts';
import { envFilePath, shownEnvFilePath } from './env-file.ts';

const CLIENT_LIST = CLIENT_NAMES.join('|');

const USAGE = `jevway setup                                   interactive: key, browser, MCP clients (needs a terminal)
jevway setup --client <${CLIENT_LIST}> --print [--json]
                                               print how to register jevway with that client; changes nothing

Examples:
  jevway setup
  jevway setup --client cursor --print
  jevway setup --client codex --print --json   # { client, kind, command?, file?, snippet }`;

const realMachine = (): Machine => ({ home: homedir(), env: process.env, onPath: onPathIn() });

const isClientName = (name: string): name is PrintedRegistration['client'] => (CLIENT_NAMES as readonly string[]).includes(name);

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
    await print(`${USAGE}\n`);
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
  void fromEnvFile;
  await print(`${USAGE}\n`);
  return 2;
};
