import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliDeps } from '../../src/cli/dispatch.ts';
import { daemonAccess } from '../../src/daemon/client.ts';
import { startDaemon, type Daemon } from '../../src/daemon/server.ts';
import { fakeRunner } from '../fakes.ts';

export const VERSION = '9.9.9';
export const FINGERPRINT = 'test-settings';

/** A short temporary folder: a Unix socket path must stay under about 100 characters. */
export const tempDir = (prefix = 'jv-') => mkdtempSync(join(tmpdir(), prefix));

export interface CliRun {
  code: number;
  out: string;
  err: string;
  /** stdout parsed as ONE JSON document: two documents, or text around one, fail the parse. */
  json: any;
  /** Every stderr line, each parsed as JSON. */
  events: any[];
}

/**
 * Runs `jevway <argv>` in-process, with stdout and stderr captured and parsed. `interrupt` holds the Ctrl-C handlers
 * the command registered, to press them from a test.
 */
export const cliWith = (base: Partial<CliDeps> & Pick<CliDeps, 'createRunner'>) => {
  const interrupts: (() => void)[] = [];
  const cli = async (argv: string[], overrides: Partial<CliDeps> = {}): Promise<CliRun> => {
    let out = '';
    let err = '';
    const deps: CliDeps = {
      io: { out: (text) => void (out += text), err: (text) => void (err += text) },
      env: {},
      cwd: tempDir(),
      version: VERSION,
      fromEnvFile: [],
      daemon: noDaemon,
      onInterrupt: (handler) => {
        interrupts.push(handler);
        return () => interrupts.splice(interrupts.indexOf(handler), 1);
      },
      ...base,
      ...overrides,
    };
    const code = await runCli(argv, deps);
    const json = out.trim().startsWith('{') ? JSON.parse(out) : undefined;
    const events = err.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { code, out, err, json, events };
  };
  return { cli, interrupts };
};

/** Daemon access that finds nothing running and fails the test if a command tries to start one. */
export const noDaemon = daemonAccess({
  socket: join(tempDir('jv-none-'), 'daemon.sock'),
  log: '/dev/null',
  version: VERSION,
  fingerprint: FINGERPRINT,
  start: () => {
    throw new Error('this command must not start a daemon');
  },
});

/**
 * A daemon served in this process on a real socket, started by the CLI's first command that needs one, with tasks on
 * fake tabs. `started` lists every daemon the CLI started; `logged` every log line.
 */
export const daemonHarness = ({
  runner = fakeRunner().runner,
  idleMs = 3_600_000,
  daemonVersion = VERSION,
  stateDir = tempDir('jvd-'),
}: { runner?: ReturnType<typeof fakeRunner>['runner']; idleMs?: number; daemonVersion?: string; stateDir?: string } = {}) => {
  const socket = join(stateDir, 'daemon.sock');
  const started: Daemon[] = [];
  const logged: Record<string, unknown>[] = [];
  const serve = (version = daemonVersion) =>
    startDaemon({ socket, version, fingerprint: FINGERPRINT, idleMs, runnerFor: () => runner, log: (entry) => logged.push(entry) }).then((daemon) => {
      started.push(daemon);
      return daemon;
    });
  const access = daemonAccess({ socket, log: join(stateDir, 'daemon.log'), version: VERSION, fingerprint: FINGERPRINT, start: () => void serve(VERSION).catch(() => undefined) });
  const { cli, interrupts } = cliWith({ createRunner: () => runner, daemon: access });
  return { cli, interrupts, socket, started, logged, serve, runner, access };
};
