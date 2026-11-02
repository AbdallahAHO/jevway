import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { DeviceName } from '../browser/devices.ts';
import { scrubberFor } from '../jev/secrets.ts';
import type { JourneySession, StepInput } from '../journeys/journey-session.ts';
import { ensureOutRoot, journeyFolderName, outRoot, runFolderName } from '../output/layout.ts';
import type { RunFiles } from '../output/run-folder.ts';
import { lookAt, type PageLook } from '../task/look.ts';
import { storyLine } from '../task/present.ts';
import type { BrowserTask, TaskStatus, TaskSummary } from '../task/run-task.ts';
import type { Runner, StartOptions } from '../task/start-task.ts';

export interface SessionServiceOptions {
  /** The output root; default `$JEVWAY_OUT_DIR`, else `./.jevway`. */
  outDir?: string;
  /** How long an idle session lives, for the unknown-session message; leave it out when sessions live until a restart. */
  idleMs?: number;
  /** Where `JEVWAY_OUT_DIR` and `JEVWAY_JOURNEYS_DIR` are read (default `process.env`), and relative paths resolve. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  now?: () => Date;
  newId?: () => string;
}

/** A task call: a new session with `url` or `tab`, or a continue with `session`. Start-only fields are ignored on a continue. */
export interface TaskRequest extends Omit<StartOptions, 'output'> {
  session?: string;
  /** New session only: keep the recording for people (video, step shots, `index.html`) in the run folder. */
  record?: boolean;
}

/** What a task call tells as it goes: adapters turn these into MCP progress or CLI NDJSON. */
export type SessionEvent =
  | { type: 'started'; session: string }
  | { type: 'step'; session: string; n: number; story: string; url: string }
  | { type: 'finished'; session: string; status: TaskStatus };

export interface TaskResult {
  session: string;
  /** Scrubbed of secret values; pass it to `presentSummary` for the caller. */
  summary: TaskSummary;
  files?: RunFiles;
  /** The end page as JPEG bytes, for an adapter to inline on a hand-back; absent when the capture failed. */
  screenshot?: Buffer;
}

export interface JourneyRequest {
  url: string;
  device?: DeviceName;
  intent?: string;
  values?: Record<string, string>;
  stayWithin?: string;
  /** The exact folder to write the map to. */
  outDir?: string;
}

export interface JourneyReply {
  journey: string;
  /** The screen report (or the autopilot result) the journey tools return. */
  report: Record<string, unknown>;
  /** A light JPEG of the screen, base64, so a multimodal agent sees what Jev saw. */
  preview: string;
}

export interface SessionInfo {
  session: string;
  kind: 'task' | 'journey';
  /** A task's latest goal, its secret values masked. */
  goal?: string;
  /** How the task's last call ended; none before its first call ends. */
  status?: TaskStatus;
  /** The page the last call ended on (a task), or the journey's start page. */
  url?: string;
  running?: boolean;
  started_at: string;
  last_used_at: string;
  run_dir: string;
}

/** A session id the service does not hold: it ended, expired, or never existed. `code` is for structured CLI errors. */
export class UnknownSession extends Error {
  readonly code = 'unknown_session';
}

interface TaskEntry {
  task: BrowserTask;
  /** The session opened its first tab (`url`), so ending it closes that tab too. */
  ownsTab: boolean;
  /** The session's current call; a cancelled call can still be finishing an input, and the next call waits for it. */
  running?: Promise<unknown>;
  busy: boolean;
  goal: string;
  values: Record<string, string>;
  secretKeys: string[];
  status?: TaskStatus;
  url?: string;
  runDir: string;
  startedAt: Date;
  lastUsedAt: Date;
}

interface JourneyEntry {
  journey: JourneySession;
  url: string;
  outDir: string;
  startedAt: Date;
  lastUsedAt: Date;
}

// 3600000 → '1 h', 1800000 → '30 min'.
const idleWords = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);

/**
 * The sessions behind every adapter (the MCP server, the CLI daemon): task sessions and journeys by opaque UUID, each
 * with its folder under the output root, calls that wait for a session's still-running call, and errors that say what
 * to do next. Transport-free: adapters translate parameters in and present results out.
 *
 * @example
 * const sessions = createSessionService(createRunner('auto'));
 * const first = await sessions.task({ goal: 'Book a stay', url: 'https://stays.example' }, { onEvent: console.error });
 * presentSummary(first); // { session, status: 'needs_input', next: 'Add the missing values …', story, files, … }
 * await sessions.task({ goal: 'Book a stay', session: first.session, values: { email: 'ada@example.com' } });
 * await sessions.end(first.session);
 */
export const createSessionService = (runner: Pick<Runner, 'start' | 'look' | 'startJourney' | 'close'>, options: SessionServiceOptions = {}) => {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const root = resolve(cwd, options.outDir ?? outRoot(env, cwd));
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const sessions = new Map<string, TaskEntry>();
  const journeys = new Map<string, JourneyEntry>();
  const lifetime = `when the server restarts${options.idleMs ? ` or after ${idleWords(options.idleMs)} idle` : ''}`;

  const findTask = (id: string) => {
    const entry = sessions.get(id);
    if (!entry) throw new UnknownSession(`Unknown session "${id}". Sessions end ${lifetime}; start a new one with \`url\` (or \`tab\`).`);
    entry.lastUsedAt = now();
    return entry;
  };
  const findJourney = (id: string) => {
    const entry = journeys.get(id);
    if (!entry) throw new UnknownSession(`Unknown journey "${id}". Journeys end when finished or ${lifetime}; start a new one with its \`url\`.`);
    entry.lastUsedAt = now();
    return entry;
  };

  const startTask = async ({ session: _session, record, recordDir, ...request }: TaskRequest) => {
    const id = newId();
    const at = now();
    const values = request.values ?? {};
    const secretKeys = request.secretKeys ?? [];
    const scrub = scrubberFor(values, secretKeys);
    const runDir = recordDir ? resolve(cwd, recordDir) : join(ensureOutRoot(root), 'runs', runFolderName({ at, goal: request.goal, id, scrub }));
    const task = await runner.start({ ...request, output: { dir: runDir, record: Boolean(record || recordDir) } });
    const entry: TaskEntry = { task, ownsTab: Boolean(request.url), busy: false, goal: scrub(request.goal), values, secretKeys, runDir, startedAt: at, lastUsedAt: at };
    sessions.set(id, entry);
    return { id, entry };
  };

  const continueTask = async (id: string, request: TaskRequest) => {
    const entry = findTask(id);
    await entry.running;
    // Only what a later call may change: start-only fields (url, tab, coordinate clicks, recording) stay as started.
    entry.task.update({
      goal: request.goal,
      values: request.values,
      secretKeys: request.secretKeys,
      files: request.files,
      doneWhen: request.doneWhen,
      checks: request.checks,
      maxSteps: request.maxSteps,
      maxSeconds: request.maxSeconds,
      allowedHosts: request.allowedHosts,
      blockedHosts: request.blockedHosts,
      confirmIrreversible: request.confirmIrreversible,
      confirmTarget: request.confirmTarget,
    });
    entry.values = { ...entry.values, ...request.values };
    entry.secretKeys = [...new Set([...entry.secretKeys, ...(request.secretKeys ?? [])])];
    entry.goal = scrubberFor(entry.values, entry.secretKeys)(request.goal);
    return { id, entry };
  };

  const journeysRoot = () =>
    env.JEVWAY_JOURNEYS_DIR ? resolve(cwd, env.JEVWAY_JOURNEYS_DIR) : join(ensureOutRoot(root), 'journeys');

  const journeyReply = async (id: string, journey: JourneySession, report: object): Promise<JourneyReply> => ({
    journey: id,
    report: report as Record<string, unknown>,
    preview: await journey.preview(),
  });

  return {
    /** The output root this service writes under. */
    outDir: root,

    /**
     * Runs one call: a new session (with `url` or `tab`) or the next call of `session`, which first waits for that
     * session's still-running call. `signal` cancels this call (the run ends `blocked` at its next check).
     */
    async task(request: TaskRequest, { signal, onEvent }: { signal?: AbortSignal; onEvent?: (event: SessionEvent) => void } = {}): Promise<TaskResult> {
      const { id, entry } = request.session ? await continueTask(request.session, request) : await startTask(request);
      // A listener is the adapter's (progress, NDJSON): it never decides how the run goes.
      const tell = (event: SessionEvent) => {
        try {
          onEvent?.(event);
        } catch {
          // ignored
        }
      };
      tell({ type: 'started', session: id });
      entry.busy = true;
      const running = entry.task.run({ signal, onStep: (step, n, url) => tell({ type: 'step', session: id, n, story: storyLine(step), url }) });
      entry.running = running.catch(() => undefined);
      try {
        const summary = await running;
        entry.status = summary.status;
        entry.url = summary.url;
        tell({ type: 'finished', session: id, status: summary.status });
        const call = entry.task.lastCall;
        return { session: id, summary, ...(call && { files: call.files }), ...(call?.screenshot && { screenshot: call.screenshot }) };
      } finally {
        entry.busy = false;
        entry.lastUsedAt = now();
      }
    },

    /** Reads a page with no model call and no input: a session's tab (its secret values masked), an open tab by URL part, or a URL opened and closed again. */
    async look({ session, tab, url }: { session?: string; tab?: string; url?: string }): Promise<PageLook> {
      if ([session, tab, url].filter(Boolean).length !== 1) throw new Error('Pass exactly one of session, tab or url.');
      if (session) return lookAt(await findTask(session).task.look());
      return lookAt(await runner.look({ url, tab }));
    },

    /** Forgets a session and closes the tabs it opened (its first tab only when it started from `url`), unless `keepTab`. */
    async end(session: string, { keepTab = false }: { keepTab?: boolean } = {}) {
      const entry = findTask(session);
      sessions.delete(session);
      if (!keepTab) await entry.task.closeTabs({ keepFirst: !entry.ownsTab });
      return { session, run_dir: entry.runDir };
    },

    /** Every open task session and journey, oldest first, with what it is doing and where its files are. */
    listSessions(): SessionInfo[] {
      const tasks = [...sessions].map(([session, entry]): SessionInfo => ({
        session,
        kind: 'task',
        goal: entry.goal,
        ...(entry.status && { status: entry.status }),
        ...(entry.url && { url: entry.url }),
        running: entry.busy,
        started_at: entry.startedAt.toISOString(),
        last_used_at: entry.lastUsedAt.toISOString(),
        run_dir: entry.runDir,
      }));
      const maps = [...journeys].map(([session, entry]): SessionInfo => ({
        session,
        kind: 'journey',
        url: entry.url,
        started_at: entry.startedAt.toISOString(),
        last_used_at: entry.lastUsedAt.toISOString(),
        run_dir: entry.outDir,
      }));
      return [...tasks, ...maps].sort((a, b) => a.started_at.localeCompare(b.started_at));
    },

    /** Opens `url` on an emulated phone and maps its first screen, into `<root>/journeys/<stamp>_<host>_<id4>/` (or `outDir`). */
    async journeyStart({ url, device, intent, values, stayWithin, outDir }: JourneyRequest): Promise<JourneyReply> {
      const id = newId();
      const at = now();
      const dir = outDir ? resolve(cwd, outDir) : join(journeysRoot(), journeyFolderName({ at, host: new URL(url).host, id }));
      const journey = await runner.startJourney({ startUrl: url, device, intent, values, stayWithin, outDir: dir });
      journeys.set(id, { journey, url, outDir: dir, startedAt: at, lastUsedAt: at });
      return journeyReply(id, journey, journey.report());
    },

    async journeyStep(id: string, input: StepInput): Promise<JourneyReply> {
      const { journey } = findJourney(id);
      return journeyReply(id, journey, await journey.step(input));
    },

    async journeyAutopilot(id: string, input: { screens?: number; flow?: string; intent?: string }): Promise<JourneyReply> {
      const { journey } = findJourney(id);
      return journeyReply(id, journey, await journey.autopilot(input));
    },

    journeyAnnotate(
      id: string,
      screen: string,
      notes: { description?: string; insight?: string },
      relabel?: { fromStep: number; toStep: number; flow: string },
    ) {
      findJourney(id).journey.annotate(screen, notes, relabel);
    },

    /** Writes the final map, closes the journey's tab unless `keepTab`, and forgets the journey. */
    async journeyFinish(id: string, { keepTab = false }: { keepTab?: boolean } = {}) {
      const { journey, outDir } = findJourney(id);
      const summary = await journey.finish({ closeTab: !keepTab });
      journeys.delete(id);
      return { ...summary, manifest: join(outDir, 'manifest.json') };
    },

    /** Closes the browser connection (a launched browser closes with it). */
    close: () => runner.close(),
  };
};

export type SessionService = ReturnType<typeof createSessionService>;
