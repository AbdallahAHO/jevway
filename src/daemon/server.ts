import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { InboxError } from '../inbox/inbox.ts';
import { createInboxRegistry, type InboxRegistry } from '../inbox/inbox-registry.ts';
import { ensureOutRoot } from '../output/layout.ts';
import { createSessionService, UnknownSession, type SessionInfo, type SessionService } from '../session/session-service.ts';
import { presentSummary } from '../task/present.ts';
import type { Runner } from '../task/start-task.ts';
import { readLines, sendLine, type ErrorBody, type Hello, type Method, type Placement, type RunnerChoice } from './protocol.ts';

/** What the daemon drives: a runner as `createRunner` makes one (one browser connection and model each). */
export type SessionRunner = Pick<Runner, 'start' | 'look' | 'startJourney' | 'close'>;

export interface DaemonOptions {
  socket: string;
  version: string;
  /** `envFingerprint` of the environment this daemon reads. */
  fingerprint: string;
  /** How long a session, and then the daemon, may sit idle; 0 never idles out. */
  idleMs: number;
  runnerFor: (choice: RunnerChoice) => SessionRunner;
  /** One entry per start, stop, request and idle end; never a request's parameters. */
  log: (entry: Record<string, unknown>) => void;
  /** The inboxes `jevway inbox` makes while this daemon runs; they end with it. */
  inboxes?: InboxRegistry;
}

export interface Daemon {
  socket: string;
  /** Resolves once the daemon has stopped: by `stop()`, a `stop` request or idling out. */
  closed: Promise<void>;
  /** Ends every session (closing the tabs they opened), closes the browsers and the socket. */
  stop(): Promise<void>;
}

/** Another daemon already answers on the socket. */
export class DaemonRunning extends Error {
  readonly code = 'daemon_running';
}

interface Holder {
  service: SessionService;
  outDir: string;
}

interface CallContext {
  signal: AbortSignal;
  emit: (event: unknown) => void;
  /** Marks a session id as in use by this call, so the idle sweep leaves it alone. */
  track: (session: string) => void;
}

const STOP_WAIT_MS = 10_000;

// 3600000 → '1 h', 1800000 → '30 min'.
const idleWords = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);

const listen = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

const errorBody = (error: unknown): ErrorBody => {
  if (error instanceof UnknownSession) {
    return { code: 'unknown_session', message: error.message, hint: 'List the open ones with jevway sessions, or start one with jevway run --session new --url <url> --goal <goal>' };
  }
  if (error instanceof InboxError) return { code: error.code, message: error.message, hint: error.hint };
  return { code: 'failed', message: error instanceof Error ? error.message : String(error), hint: 'The message says what failed; jevway doctor checks the key and the browser.' };
};

/**
 * Serves the session service over a local socket until stopped or idle: one runner per browser/model choice, one
 * service per output root, sessions found by id in whichever service holds them, and `sessions.json` kept in each
 * output root. A socket file nothing answers on is replaced; one another daemon answers on is `DaemonRunning`.
 *
 * @example
 * const daemon = await startDaemon({ socket, version, fingerprint, idleMs: 3_600_000, runnerFor, log });
 * await daemon.closed;
 */
export const startDaemon = async ({ socket, version, fingerprint, idleMs, runnerFor, log, inboxes = createInboxRegistry() }: DaemonOptions): Promise<Daemon> => {
  const runners = new Map<string, SessionRunner>();
  const services = new Map<string, Holder>();
  const connections = new Set<Socket>();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const busy = new Map<string, number>();
  const startedAt = new Date();
  let lastActivity = Date.now();
  let stopping: Promise<number> | undefined;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));

  const lifetime = `Sessions end when the daemon stops${idleMs ? ` or after ${idleWords(idleMs)} idle` : ''}`;
  const unknown = (id: string, kind: 'session' | 'journey') =>
    new UnknownSession(
      kind === 'session'
        ? `Unknown session "${id}". ${lifetime}; start a new one with --session new and --url (or --tab).`
        : `Unknown journey "${id}". Journeys end when finished, or as sessions do: ${lifetime.toLowerCase()}; start a new one with jevway journey start --url <url>.`,
    );

  const allSessions = () => [...services.values()].flatMap(({ service }) => service.listSessions());
  const holderOf = (id: string, kind: 'session' | 'journey') => {
    for (const holder of services.values()) if (holder.service.listSessions().some(({ session }) => session === id)) return holder;
    throw unknown(id, kind);
  };

  const serviceFor = (choice: RunnerChoice, place: Placement) => {
    const runnerKey = JSON.stringify([choice.browser, choice.model ?? null, choice.screenshots ?? null]);
    let runner = runners.get(runnerKey);
    if (!runner) runners.set(runnerKey, (runner = runnerFor(choice)));
    const key = JSON.stringify([runnerKey, place.outDir, place.journeysDir ?? null]);
    let holder = services.get(key);
    if (!holder) {
      const env = place.journeysDir ? { JEVWAY_JOURNEYS_DIR: place.journeysDir } : {};
      holder = { service: createSessionService(runner, { outDir: place.outDir, cwd: place.cwd, env, idleMs: idleMs || undefined }), outDir: place.outDir };
      services.set(key, holder);
    }
    return holder;
  };

  /** Rewrites `<root>/sessions.json` in every output root this daemon writes to. */
  const writeSessionFiles = () => {
    const byRoot = new Map<string, SessionInfo[]>();
    for (const { service, outDir } of services.values()) byRoot.set(outDir, [...(byRoot.get(outDir) ?? []), ...service.listSessions()]);
    for (const [root, sessions] of byRoot) {
      try {
        ensureOutRoot(root);
        sessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
        writeFileSync(join(root, 'sessions.json'), `${JSON.stringify({ updated_at: new Date().toISOString(), sessions }, null, 1)}\n`);
      } catch {
        // A folder that can't be written never fails a call.
      }
    }
  };

  const endOne = ({ service }: Holder, { session, kind }: SessionInfo, keepTab = false) =>
    kind === 'journey' ? service.journeyFinish(session, { keepTab }) : service.end(session, { keepTab });

  const hello = (): Hello => ({
    version,
    fingerprint,
    pid: process.pid,
    sessions: allSessions().length,
    idle_timeout_s: idleMs ? idleMs / 1000 : null,
    started_at: startedAt.toISOString(),
  });

  const withoutPreview = ({ journey, report }: { journey: string; report: Record<string, unknown> }) => ({ journey, ...report });

  const handlers: Record<Exclude<Method, 'stop'>, (params: Record<string, any>, call: CallContext) => Promise<unknown> | unknown> = {
    hello: () => hello(),
    async task({ request, detail, runner, place }, { signal, emit, track }) {
      const { service } = request.session ? holderOf(request.session, 'session') : serviceFor(runner, place);
      const result = await service.task(request, {
        signal,
        onEvent: (event) => {
          if (event.type === 'started') {
            track(event.session);
            writeSessionFiles();
          }
          emit(event);
        },
      });
      writeSessionFiles();
      return presentSummary(result, { detail });
    },
    async look({ session, pdf }) {
      return { session, ...(await holderOf(session, 'session').service.look({ session, pdf: pdf === true })) };
    },
    async end({ session, keepTab }) {
      const holder = holderOf(session, 'session');
      const info = holder.service.listSessions().find((entry) => entry.session === session)!;
      const ended = await endOne(holder, info, keepTab);
      writeSessionFiles();
      return info.kind === 'journey' ? { journey: session, ...ended } : ended;
    },
    sessions: () => ({ daemon: hello(), sessions: allSessions().sort((a, b) => a.started_at.localeCompare(b.started_at)) }),
    async 'journey.start'({ request, runner, place }) {
      const reply = await serviceFor(runner, place).service.journeyStart(request);
      writeSessionFiles();
      return withoutPreview(reply);
    },
    async 'journey.step'({ journey, input }) {
      return withoutPreview(await holderOf(journey, 'journey').service.journeyStep(journey, input));
    },
    async 'journey.autopilot'({ journey, input }) {
      return withoutPreview(await holderOf(journey, 'journey').service.journeyAutopilot(journey, input));
    },
    'journey.annotate'({ journey, screen, notes, relabel }) {
      holderOf(journey, 'journey').service.journeyAnnotate(journey, screen, notes, relabel);
      return { journey, screen, annotated: true };
    },
    async 'journey.finish'({ journey, keepTab }) {
      const summary = await holderOf(journey, 'journey').service.journeyFinish(journey, { keepTab });
      writeSessionFiles();
      return { journey, ...summary };
    },
    // Inboxes are named `inbox`, never `session`, so the idle sweep never mistakes one for a busy session.
    'inbox.create': ({ provider }) => inboxes.create({ provider }),
    async 'inbox.wait'({ inbox, from, subject, timeoutS }, { signal, emit }) {
      const address = inboxes.addressOf(inbox);
      const message = await inboxes.wait(inbox, {
        from,
        subject,
        timeoutMs: timeoutS * 1000,
        signal,
        onPoll: (elapsedMs) => emit({ type: 'inbox_wait', address, elapsed_s: Math.round(elapsedMs / 1000), timeout_s: timeoutS }),
      });
      return { message: message ?? null };
    },
    'inbox.list': ({ inbox }, { signal }) => inboxes.list(inbox, { signal }),
    'inbox.read': ({ inbox, id }, { signal }) => inboxes.read(inbox, id, { signal }),
  };

  // Ending (not destroying) lets the last replies reach their clients first.
  const finish = () => {
    for (const connection of connections) {
      connection.end();
      setTimeout(() => connection.destroy(), 1_000).unref();
    }
    markClosed();
  };

  const shutdown = (reason: string) =>
    (stopping ??= (async () => {
      clearInterval(timer);
      server.close();
      for (const controller of controllers) controller.abort();
      await Promise.race([Promise.allSettled([...pending]), delay(STOP_WAIT_MS)]);
      let ended = 0;
      for (const holder of services.values()) {
        for (const info of holder.service.listSessions()) {
          try {
            await endOne(holder, info);
            ended++;
          } catch {
            // A tab that is already gone is ended all the same.
          }
        }
      }
      for (const runner of runners.values()) await runner.close().catch(() => undefined);
      writeSessionFiles();
      log({ event: 'stopped', reason, ended });
      return ended;
    })());

  const handle = async (socket: Socket, mine: Map<number, AbortController>, { id, method, params = {} }: { id: number; method: Method; params?: Record<string, any> }) => {
    if (method === 'stop') {
      const ended = await shutdown('stop');
      sendLine(socket, { id, result: { stopped: true, ended } });
      finish();
      return;
    }
    if (stopping) {
      sendLine(socket, { id, error: { code: 'daemon_unavailable', message: 'The daemon is stopping.', hint: 'Run the command again: it starts a new daemon.' } });
      return;
    }
    const handler = handlers[method as Exclude<Method, 'stop'>];
    if (!handler) {
      sendLine(socket, { id, error: { code: 'unknown_method', message: `Unknown method "${method}"`, hint: 'The daemon and this jevway may differ in version: run jevway stop.' } });
      return;
    }
    const controller = new AbortController();
    mine.set(id, controller);
    controllers.add(controller);
    const tracked: string[] = [];
    const track = (session: string) => {
      tracked.push(session);
      busy.set(session, (busy.get(session) ?? 0) + 1);
    };
    for (const session of [params.session, params.journey, params.request?.session]) if (typeof session === 'string') track(session);
    const began = Date.now();
    lastActivity = began;
    let failed: string | undefined;
    const work = (async () => {
      try {
        const result = await handler(params, { signal: controller.signal, emit: (event) => sendLine(socket, { id, event }), track });
        sendLine(socket, { id, result });
      } catch (error) {
        const body = errorBody(error);
        failed = body.code;
        sendLine(socket, { id, error: body });
      }
    })();
    pending.add(work);
    await work;
    pending.delete(work);
    mine.delete(id);
    controllers.delete(controller);
    for (const session of tracked) {
      const left = (busy.get(session) ?? 1) - 1;
      if (left > 0) busy.set(session, left);
      else busy.delete(session);
    }
    lastActivity = Date.now();
    log({ event: 'request', method, id, ...(tracked[0] && { session: tracked[0] }), ms: lastActivity - began, ...(failed && { error: failed }) });
  };

  const onConnection = (socket: Socket) => {
    connections.add(socket);
    const mine = new Map<number, AbortController>();
    readLines(socket, (message) => {
      if (typeof message?.cancel === 'number') mine.get(message.cancel)?.abort();
      else if (typeof message?.id === 'number' && typeof message?.method === 'string') void handle(socket, mine, message);
    });
    // A client that goes away cancels its running calls, as a cancelled MCP request does.
    socket.on('close', () => {
      connections.delete(socket);
      for (const controller of mine.values()) controller.abort();
    });
    socket.on('error', () => undefined);
  };

  let sweeping = false;
  const sweep = async () => {
    if (sweeping || stopping) return;
    sweeping = true;
    try {
      const cutoff = Date.now() - idleMs;
      let changed = false;
      for (const holder of services.values()) {
        for (const info of holder.service.listSessions()) {
          if (info.running || busy.has(info.session) || Date.parse(info.last_used_at) > cutoff) continue;
          await endOne(holder, info).catch(() => undefined);
          changed = true;
          log({ event: 'idle_end', session: info.session, kind: info.kind });
        }
      }
      if (changed) writeSessionFiles();
      if (!allSessions().length && !pending.size && lastActivity <= cutoff) {
        await shutdown('idle');
        finish();
      }
    } finally {
      sweeping = false;
    }
  };

  if (process.platform !== 'win32') mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  let server = createServer(onConnection);
  try {
    await listen(server, socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    if (await answers(socket)) throw new DaemonRunning(`A jevway daemon already answers on ${socket}`);
    // A socket file left by a daemon that died: nothing answers on it.
    rmSync(socket, { force: true });
    server = createServer(onConnection);
    await listen(server, socket);
  }
  if (process.platform !== 'win32') chmodSync(socket, 0o600);
  const timer = idleMs > 0 ? setInterval(() => void sweep(), Math.min(Math.max(idleMs / 4, 25), 60_000)) : undefined;
  timer?.unref();
  log({ event: 'started', pid: process.pid, version, socket, idle_timeout_s: idleMs ? idleMs / 1000 : null });

  return {
    socket,
    closed,
    async stop() {
      await shutdown('stopped');
      finish();
    },
  };
};
