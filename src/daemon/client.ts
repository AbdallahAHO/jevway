import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { logPath } from './paths.ts';
import { readLines, sendLine, type Hello, type Method } from './protocol.ts';

/**
 * A daemon call that failed: the daemon's own error (`code`, `message`, `hint`), or `lost` when the connection closed
 * or timed out before an answer, so the call may or may not have happened.
 */
export class DaemonFailure extends Error {
  readonly code: string;
  readonly hint: string;
  readonly lost: boolean;
  constructor(code: string, message: string, hint: string, lost = false) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.lost = lost;
  }
}

export interface RequestOptions {
  onEvent?: (event: any) => void;
  /** Give up after this long: the connection closes, which cancels the call on the daemon's side. */
  timeoutMs?: number;
  /** Aborting sends a cancel and keeps waiting for the call's answer. */
  signal?: AbortSignal;
}

export interface DaemonConnection {
  hello: Hello;
  request<T = any>(method: Method, params?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  close(): void;
  closed: Promise<void>;
}

/** The daemon events a command tells on stderr: when it started one, and why it replaced one. */
export interface DaemonEvent {
  type: 'daemon';
  event: 'started' | 'restarted';
  pid: number;
  log: string;
  reason?: string;
}

const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);
const HELLO_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 10_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const lostConnection = (timedOut: boolean) =>
  new DaemonFailure(
    'daemon_unavailable',
    timedOut ? 'The daemon did not answer in time.' : 'The connection to the daemon closed before it answered.',
    'Run the command again; jevway sessions shows what the daemon holds.',
    true,
  );

const open = (socket: string) =>
  new Promise<Socket | undefined>((resolve, reject) => {
    const connection = createConnection(socket);
    const onError = (error: NodeJS.ErrnoException) => {
      if (NOT_LISTENING.has(error.code ?? '')) resolve(undefined);
      else reject(new DaemonFailure('daemon_unavailable', `Could not reach the jevway daemon at ${socket}: ${error.message}`, 'Run jevway stop, then the command again.'));
    };
    connection.once('error', onError);
    connection.once('connect', () => {
      connection.off('error', onError);
      resolve(connection);
    });
  });

/**
 * Connects to the daemon on `socket` and says hello; undefined when nothing listens there.
 *
 * @example
 * const daemon = await connectDaemon('/Users/ada/.cache/jevway/daemon.sock');
 * daemon?.hello.version // '0.1.2'
 */
export const connectDaemon = async (socket: string): Promise<DaemonConnection | undefined> => {
  const connection = await open(socket);
  if (!connection) return undefined;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; onEvent?: (event: any) => void }>();
  let nextId = 0;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  readLines(connection, (message) => {
    const call = waiting.get(message?.id);
    if (!call) return;
    if ('event' in message) return call.onEvent?.(message.event);
    waiting.delete(message.id);
    if ('error' in message) call.reject(new DaemonFailure(message.error.code, message.error.message, message.error.hint));
    else call.resolve(message.result);
  });
  connection.on('error', () => undefined);
  connection.on('close', () => {
    for (const call of waiting.values()) call.reject(lostConnection(false));
    waiting.clear();
    markClosed();
  });

  const request = <T>(method: Method, params: Record<string, unknown> = {}, { onEvent, timeoutMs, signal }: RequestOptions = {}) =>
    new Promise<T>((resolve, reject) => {
      if (connection.destroyed) return reject(lostConnection(false));
      const id = ++nextId;
      const onAbort = () => sendLine(connection, { cancel: id });
      const timer = timeoutMs
        ? setTimeout(() => {
            waiting.delete(id);
            settle();
            reject(lostConnection(true));
            connection.destroy();
          }, timeoutMs)
        : undefined;
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      waiting.set(id, {
        resolve: (value) => (settle(), resolve(value)),
        reject: (error) => (settle(), reject(error)),
        onEvent,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      sendLine(connection, { id, method, params });
      if (signal?.aborted) onAbort();
    });

  try {
    const hello = await request<Hello>('hello', {}, { timeoutMs: HELLO_TIMEOUT_MS });
    return { hello, request, close: () => connection.end(), closed };
  } catch (error) {
    connection.destroy();
    throw error;
  }
};

export interface DaemonAccess {
  socket: string;
  log: string;
  /** The running daemon, or undefined; never starts one. */
  find(): Promise<DaemonConnection | undefined>;
  /**
   * The running daemon, started when none answers, or replaced when it is another version or was started with other
   * settings and holds no sessions. `onEvent` hears when it started or replaced one.
   */
  ensure(onEvent: (event: DaemonEvent) => void): Promise<DaemonConnection>;
}

/**
 * How a command reaches the daemon on `socket`. `start` launches one (in the background for the real CLI, in-process in
 * tests); the client then waits up to 10 s for it to answer.
 */
export const daemonAccess = ({
  socket,
  log,
  version,
  fingerprint,
  start,
  startTimeoutMs = START_TIMEOUT_MS,
}: {
  socket: string;
  log: string;
  version: string;
  fingerprint: string;
  start: () => void | Promise<void>;
  startTimeoutMs?: number;
}): DaemonAccess => ({
  socket,
  log,
  find: () => connectDaemon(socket),
  async ensure(onEvent) {
    let reason: string | undefined;
    const running = await connectDaemon(socket);
    if (running) {
      const { hello } = running;
      reason =
        hello.version !== version
          ? `the running daemon is version ${hello.version}, this jevway is ${version}`
          : hello.fingerprint !== fingerprint
            ? 'the running daemon was started with other settings (keys, CHROME_PATH, JEVWAY_ALLOWED_HOSTS/JEVWAY_BLOCKED_HOSTS or JEVWAY_REPLAY)'
            : undefined;
      if (!reason) return running;
      if (hello.sessions > 0) {
        running.close();
        throw new DaemonFailure(
          'daemon_busy',
          `${reason}, and it holds ${hello.sessions} session${hello.sessions === 1 ? '' : 's'}`,
          'List them with jevway sessions; jevway stop ends them and the next command starts a new daemon',
        );
      }
      await running.request('stop', {}, { timeoutMs: STOP_TIMEOUT_MS }).catch(() => undefined);
      running.close();
      await Promise.race([running.closed, delay(STOP_TIMEOUT_MS)]);
    } else if (process.platform !== 'win32' && existsSync(socket)) {
      // A socket file nothing answers on: its daemon died without removing it.
      rmSync(socket, { force: true });
    }
    await start();
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const connection = await connectDaemon(socket).catch(() => undefined);
      if (connection) {
        onEvent({ type: 'daemon', event: reason ? 'restarted' : 'started', pid: connection.hello.pid, log, ...(reason && { reason }) });
        return connection;
      }
      await delay(50);
    }
    throw new DaemonFailure('daemon_unavailable', `The jevway daemon did not start within ${startTimeoutMs / 1000} s`, `See ${log}, or run jevway serve to watch it start`);
  },
});

/**
 * Starts `node <entry> serve` detached in `stateDir`, its output appended to `daemon.log` (moved to `daemon.log.1`
 * past 5 MB). Returns at once; the caller waits for the socket.
 */
export const spawnDaemon = ({ entry, stateDir, env, execArgv = process.execArgv }: { entry: string; stateDir: string; env: NodeJS.ProcessEnv; execArgv?: string[] }) => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = logPath(stateDir);
  if ((statSync(log, { throwIfNoEntry: false })?.size ?? 0) > 5_000_000) renameSync(log, `${log}.1`);
  const fd = openSync(log, 'a', 0o600);
  try {
    spawn(process.execPath, [...execArgv, entry, 'serve'], { detached: true, stdio: ['ignore', fd, fd], cwd: stateDir, env, windowsHide: true }).unref();
  } finally {
    closeSync(fd);
  }
};
