import type { DaemonAccess } from '../daemon/client.ts';
import { DOCTOR_USAGE, runDoctor } from '../setup/doctor-command.ts';
import { SETUP_USAGE, runSetup } from '../setup/setup-command.ts';
import { SKILL_USAGE, runSkill } from '../setup/skill-command.ts';
import type { Runner } from '../task/start-task.ts';
import { closestName, usageError } from './flags.ts';
import { topHelp } from './help.ts';
import { inboxCommand } from './inbox-command.ts';
import { journeyCommand } from './journey-command.ts';
import { lookCommand } from './look-command.ts';
import { printFailure, type CliIo } from './output.ts';
import { runCommand } from './run-command.ts';
import { endCommand, serveCommand, sessionsCommand, stopCommand } from './session-commands.ts';

/** A runner as `createRunner` makes one: what one-shot runs, looks and the daemon drive. */
export type CliRunner = Pick<Runner, 'start' | 'look' | 'startJourney' | 'close' | 'requireKey'>;

/** Everything a command touches outside itself, injected so tests run every command in-process. */
export interface CliDeps {
  io: CliIo;
  env: Record<string, string | undefined>;
  cwd: string;
  version: string;
  /** What `loadEnvFile` filled at start, for `jevway doctor`. */
  fromEnvFile: string[];
  createRunner: (browser: string, choice: { model?: string; screenshots?: string }) => CliRunner;
  daemon: DaemonAccess;
  /** Calls `handler` on Ctrl-C (and SIGTERM) until the returned function is called. */
  onInterrupt: (handler: () => void) => () => void;
}

/** `usage`: help text for a command that prints its own output (the setup commands), sent through `io` like every other help. */
type Command = { summary: string; run: (argv: string[], deps: CliDeps) => Promise<number>; usage?: string };

const COMMANDS: Record<string, Command> = {
  run: { summary: 'hand a browser goal to Jev (one-shot, or a session with --session)', run: runCommand },
  look: { summary: 'print what a page or a session\'s tab shows, with no model call', run: lookCommand },
  journey: { summary: 'map mobile user journeys: start, step, autopilot, annotate, finish', run: journeyCommand },
  inbox: { summary: 'a throwaway email inbox for test and demo sign-ups: create, wait, list, read', run: inboxCommand },
  sessions: { summary: 'list the open sessions and journeys', run: sessionsCommand },
  end: { summary: 'end a session and close the tabs it opened', run: endCommand },
  serve: { summary: 'run the session daemon in the foreground', run: serveCommand },
  stop: { summary: 'stop the session daemon', run: stopCommand },
  doctor: { summary: 'check the key, browser, Node and ffmpeg (--json for agents)', run: (argv, deps) => runDoctor(argv, deps.fromEnvFile), usage: DOCTOR_USAGE },
  setup: { summary: 'set up the key, browser and MCP clients (interactive; --client <name> --print for agents)', run: (argv, deps) => runSetup(argv, deps.fromEnvFile), usage: SETUP_USAGE },
  skill: { summary: 'print the agent skill, or --install it into a skills folder', run: (argv) => runSkill(argv), usage: SKILL_USAGE },
};

const printUsage = async (deps: CliDeps, usage: string) => {
  await deps.io.out(usage.endsWith('\n') ? usage : `${usage}\n`);
  return 0;
};

const commandList = () => [...Object.entries(COMMANDS).map(([name, { summary }]) => ({ name, summary })), { name: 'help [command]', summary: 'this help, or a command\'s' }];

const unknownCommand = (name: string) => {
  const meant = closestName(name, Object.keys(COMMANDS));
  return usageError('unknown_command', `Unknown command "${name}"`, `${meant ? `Did you mean jevway ${meant}? ` : ''}See jevway --help`);
};

/**
 * `jevway <argv>`: runs one command and returns its exit code. Every failure, expected or not, becomes one
 * `{ ok: false, error }` document on stdout: never a stack trace.
 *
 * @example
 * process.exitCode = await runCli(['run', '--url', 'https://example.com', '--goal', 'Open the docs'], deps);
 */
export const runCli = async (argv: string[], deps: CliDeps): Promise<number> => {
  try {
    const [first, ...rest] = argv;
    if (first === undefined) {
      throw usageError('missing_command', 'No command given', 'Start with jevway run --url <url> --goal "<outcome>"; jevway --help lists the commands');
    }
    if (first === '--version' || first === '-v') {
      await deps.io.out(`${deps.version}\n`);
      return 0;
    }
    if (first === '--help' || first === '-h' || (first === 'help' && !rest.length)) {
      await deps.io.out(topHelp(commandList()));
      return 0;
    }
    if (first === 'help') {
      const command = COMMANDS[rest[0]];
      if (!command) throw unknownCommand(rest[0]);
      if (command.usage) return await printUsage(deps, command.usage);
      return await command.run([...rest.slice(1), '--help'], deps);
    }
    // Today's form: `jevway --goal … --url …` is `jevway run …`.
    if (first.startsWith('-')) return await runCommand(argv, deps);
    const command = COMMANDS[first];
    if (!command) throw unknownCommand(first);
    if (command.usage && (rest.includes('--help') || rest.includes('-h'))) return await printUsage(deps, command.usage);
    return await command.run(rest, deps);
  } catch (error) {
    return printFailure(deps.io, error);
  }
};
