import { resolve } from 'node:path';
import { DaemonFailure, type DaemonConnection, type RequestOptions } from '../daemon/client.ts';
import type { Method, Placement, RunnerChoice } from '../daemon/protocol.ts';
import { outRoot } from '../output/layout.ts';
import type { CliDeps, CliRunner } from './dispatch.ts';
import { CliError, usageError } from './flags.ts';
import { eventPrinter } from './output.ts';

const BROWSER = /^(auto|launch|launch-headless|https?:\/\/\S+|wss?:\/\/\S+)$/;

/** The browser and model a new session or one-shot run uses: the flags, else `JEVWAY_BROWSER` / `JEVWAY_MODEL` / `JEVWAY_SCREENSHOTS`. */
export const runnerChoice = (flags: Record<string, string | boolean>, env: CliDeps['env']): RunnerChoice => {
  const pick = (flag: string, variable: string) => (typeof flags[flag] === 'string' ? (flags[flag] as string) : env[variable]?.trim() || undefined);
  const browser = pick('browser', 'JEVWAY_BROWSER') ?? 'auto';
  if (!BROWSER.test(browser)) {
    throw usageError('invalid_value', `--browser must be auto, launch, launch-headless or a debugging URL, got "${browser}"`, 'Example: --browser launch-headless');
  }
  const model = pick('model', 'JEVWAY_MODEL');
  const screenshots = pick('screenshots', 'JEVWAY_SCREENSHOTS');
  return { browser, ...(model && { model }), ...(screenshots && { screenshots }) };
};

/** A runner for `choice`; an unknown model or screenshot mode is a usage error. */
export const runnerFor = (deps: CliDeps, { browser, ...choice }: RunnerChoice): CliRunner => {
  try {
    return deps.createRunner(browser, choice);
  } catch (error) {
    throw usageError('invalid_value', (error as Error).message, 'jevway run --help lists the models and screenshot modes');
  }
};

/** Fails with `missing_key` (exit 2) before any browser or daemon starts when the model's key is not set. */
export const requireKey = (runner: CliRunner) => {
  try {
    runner.requireKey();
  } catch (error) {
    throw usageError('missing_key', (error as Error).message, 'Run jevway setup in a terminal, or see jevway doctor');
  }
};

/** Where this caller's files go: resolved here, so they land under its working directory whoever started the daemon. */
export const placement = ({ env, cwd }: Pick<CliDeps, 'env' | 'cwd'>): Placement => ({
  outDir: outRoot(env, cwd),
  ...(env.JEVWAY_JOURNEYS_DIR?.trim() && { journeysDir: resolve(cwd, env.JEVWAY_JOURNEYS_DIR.trim()) }),
  cwd,
});

/** The running daemon, started when needed (a new session), or found (a session it should already hold). */
export const daemonFor = async (deps: CliDeps, need: { start: true } | { session: string; kind: 'session' | 'journey' }) => {
  if ('start' in need) return deps.daemon.ensure(eventPrinter(deps.io));
  const running = await deps.daemon.find();
  if (running) return running;
  throw new CliError(
    1,
    'unknown_session',
    `Unknown ${need.kind} "${need.session}": no jevway daemon is running, and sessions end when it stops (or after its idle time).`,
    need.kind === 'session' ? 'Start a new one with jevway run --session new --url <url> --goal <goal>' : 'Start a new one with jevway journey start --url <url>',
  );
};

/**
 * Calls the daemon and closes the connection. A connection lost mid-call is `outcome_unknown` for a call that may
 * have clicked or typed (`writes`), pointing at `jevway look` for the session, else `daemon_unavailable`.
 */
export const callDaemon = async <T>(
  connection: DaemonConnection,
  method: Method,
  params: Record<string, unknown>,
  { writes, session, log, ...options }: RequestOptions & { writes: boolean; session?: () => string | undefined; log: string },
): Promise<T> => {
  try {
    return await connection.request<T>(method, params, options);
  } catch (error) {
    if (!(error instanceof DaemonFailure) || !error.lost) throw error;
    if (!writes) throw new CliError(1, 'daemon_unavailable', error.message, `See ${log}; jevway stop and run the command again`);
    const id = session?.();
    throw new CliError(
      1,
      'outcome_unknown',
      'The daemon stopped answering while the call was running; it may already have clicked or typed.',
      id ? `Check the page with jevway look --session ${id} before repeating the call.` : 'Find the session with jevway sessions and check its page with jevway look --session <id> before repeating the call.',
    );
  } finally {
    connection.close();
  }
};

/** How long a client waits for a call: always longer than the daemon's own limit for it. */
export const TIMEOUTS = {
  /** A task call: its time budget (`--max-seconds`, default 300; a continue may carry up to 3600) plus two minutes. */
  task: (maxSeconds: number | undefined, continuing: boolean) => ((maxSeconds ?? (continuing ? 3600 : 300)) + 120) * 1000,
  quick: 60_000,
  /** Autopilot has no step limit of its own. */
  journey: 30 * 60_000,
};
