import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Hello } from '../daemon/protocol.ts';
import { DaemonRunning, startDaemon } from '../daemon/server.ts';
import { envFingerprint } from '../daemon/paths.ts';
import { callDaemon, daemonFor, TIMEOUTS } from './daemon-call.ts';
import type { CliDeps } from './dispatch.ts';
import { CliError, durationFlag, parseFlags, usageError, type CommandSpec } from './flags.ts';
import { renderHelp } from './help.ts';
import { printDoc } from './output.ts';

export const sessionsSpec: CommandSpec = {
  name: 'sessions',
  summary: 'list the daemon\'s open sessions and journeys',
  examples: ['jevway sessions'],
  flags: {},
  notes: ['Prints { ok: true, daemon: { pid, version, socket, log, idle_timeout_s } | null, sessions: [{ session, kind, goal, status, url, running, run_dir, … }] }. Never starts the daemon.'],
};

export const endSpec: CommandSpec = {
  name: 'end',
  argument: '<id>',
  summary: 'end a session (or finish a journey) and close the tabs it opened',
  examples: ['jevway end <id>', 'jevway end <id> --keep-tab'],
  flags: {
    session: { type: 'string', value: '<id>', describe: 'the session (or pass it as the argument)' },
    'keep-tab': { type: 'boolean', describe: 'leave its tabs open' },
  },
  notes: ['Prints { ok: true, session, run_dir }. A session the daemon does not hold is unknown_session, exit 1.'],
};

export const serveSpec: CommandSpec = {
  name: 'serve',
  summary: 'run the session daemon in the foreground (other commands start it in the background when needed)',
  examples: ['jevway serve', 'jevway serve --idle-timeout 0'],
  flags: { 'idle-timeout': { type: 'string', value: '<duration>', describe: 'end sessions idle this long, then exit: seconds, or 90s, 30m, 2h; 0 never (default 1h)' } },
  notes: [
    'Prints { ok: true, socket, pid, version, idle_timeout_s } once it listens, then NDJSON log lines on stderr until it stops.',
    'Socket and log: $JEVWAY_STATE_DIR, else $XDG_RUNTIME_DIR/jevway, else ~/.cache/jevway (daemon.sock, daemon.log).',
    'It keeps the environment it started with; after changing keys, jevway stop and the next command starts a fresh one.',
  ],
};

export const stopSpec: CommandSpec = {
  name: 'stop',
  summary: 'stop the daemon: end every session, close the tabs they opened and any browser it launched',
  examples: ['jevway stop'],
  flags: {},
  notes: ['Prints { ok: true, stopped: true, ended: <sessions> }, or { ok: true, stopped: false } when none was running.'],
};

const helped = async (spec: CommandSpec, argv: string[], deps: CliDeps, positionals = 0) => {
  const parsed = parseFlags(spec, argv, { positionals });
  if (!parsed.flags.help) return parsed;
  await deps.io.out(renderHelp(spec));
  return undefined;
};

const daemonInfo = (hello: Hello, deps: CliDeps) => ({
  pid: hello.pid,
  version: hello.version,
  socket: deps.daemon.socket,
  log: deps.daemon.log,
  idle_timeout_s: hello.idle_timeout_s,
  started_at: hello.started_at,
});

/** `jevway sessions`: what the running daemon holds; no daemon is an empty list. */
export const sessionsCommand = async (argv: string[], deps: CliDeps) => {
  if (!(await helped(sessionsSpec, argv, deps))) return 0;
  const connection = await deps.daemon.find();
  if (!connection) {
    await printDoc(deps.io, { ok: true, daemon: null, sessions: [] });
    return 0;
  }
  const { daemon, sessions } = await callDaemon<{ daemon: Hello; sessions: unknown[] }>(connection, 'sessions', {}, { writes: false, log: deps.daemon.log, timeoutMs: TIMEOUTS.quick });
  await printDoc(deps.io, { ok: true, daemon: daemonInfo(daemon, deps), sessions });
  return 0;
};

/** `jevway end <id>`: ends a session or finishes a journey. */
export const endCommand = async (argv: string[], deps: CliDeps) => {
  const parsed = await helped(endSpec, argv, deps, 1);
  if (!parsed) return 0;
  const session = parsed.positionals[0] ?? (parsed.flags.session as string | undefined);
  if (!session) throw usageError('missing_flag', 'jevway end needs the session id', 'Example: jevway end <id> (jevway sessions lists them)');
  const connection = await daemonFor(deps, { session, kind: 'session' });
  const ended = await callDaemon<object>(connection, 'end', { session, keepTab: parsed.flags['keep-tab'] === true }, { writes: true, session: () => session, log: deps.daemon.log, timeoutMs: TIMEOUTS.quick });
  await printDoc(deps.io, { ok: true, ...ended });
  return 0;
};

/** `jevway stop`: stops the running daemon, if any. */
export const stopCommand = async (argv: string[], deps: CliDeps) => {
  if (!(await helped(stopSpec, argv, deps))) return 0;
  const connection = await deps.daemon.find();
  if (!connection) {
    await printDoc(deps.io, { ok: true, stopped: false });
    return 0;
  }
  const result = await callDaemon<{ stopped: boolean; ended: number }>(connection, 'stop', {}, { writes: false, log: deps.daemon.log, timeoutMs: TIMEOUTS.quick });
  await Promise.race([connection.closed, new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
  await printDoc(deps.io, { ok: true, ...result });
  return 0;
};

/** `jevway serve`: the daemon in the foreground, until `jevway stop`, Ctrl-C or the idle timeout. */
export const serveCommand = async (argv: string[], deps: CliDeps) => {
  const parsed = await helped(serveSpec, argv, deps);
  if (!parsed) return 0;
  const raw = parsed.flags['idle-timeout'];
  const idleMs = typeof raw === 'string' ? durationFlag('idle-timeout', raw) : 3_600_000;
  const { socket } = deps.daemon;
  if (process.platform !== 'win32') mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  let daemon;
  try {
    daemon = await startDaemon({
      socket,
      version: deps.version,
      fingerprint: envFingerprint(deps.env),
      idleMs,
      runnerFor: ({ browser, ...choice }) => deps.createRunner(browser, choice),
      log: (entry) => deps.io.err(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`),
    });
  } catch (error) {
    if (error instanceof DaemonRunning) throw new CliError(1, error.code, error.message, 'jevway sessions shows it; jevway stop stops it');
    throw error;
  }
  const stopListening = deps.onInterrupt(() => void daemon.stop());
  // One line, so a background daemon's log stays one JSON object per line.
  await deps.io.out(`${JSON.stringify({ ok: true, socket, pid: process.pid, version: deps.version, idle_timeout_s: idleMs ? idleMs / 1000 : null })}\n`);
  await daemon.closed;
  stopListening();
  return 0;
};
