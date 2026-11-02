import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { vi } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { createSessionService } from '../../src/session/session-service.ts';
import type { TaskStatus, TaskSummary } from '../../src/task/run-task.ts';
import type { Runner, StartOptions } from '../../src/task/start-task.ts';
import { page } from '../fakes.ts';

/** The bytes a fake task's end page captures as; an image block carries them base64. */
export const END_PAGE = Buffer.from('end page jpeg');

const JEV = { requests: 3, input_tokens: 7534, median_latency_ms: 284, screenshots: 0, model: 'jev-1.14.0', est_cost_usd: 0.000316 };
const STEPS = [
  { operation: 'TYPE_TEXT', element: 'Where are you going?', value_key: 'city', page_changed: true, value_kept: true, confidence: 0.97 },
  { operation: 'CLICK', element: 'Search', page_changed: true, confidence: 0.95 },
];

/** A realistic summary for each status, with the fields that status carries. */
export const summaryFor = (status: TaskStatus): TaskSummary => {
  const base = {
    status,
    url: 'https://stays.example/search?city=Lisbon',
    title: 'Stays in Lisbon · Staylist',
    page_text: 'Stays in Lisbon\nCasa do Alfama · €142 a night',
    elapsed_ms: 4210,
    steps: STEPS,
    jev: JEV,
    done_probability: status === 'done' ? 0.94 : 0.1,
  };
  const stuck = { operation: 'CLICK', element: 'Search', candidates: [{ element: 'Search', probability: 0.6 }] };
  switch (status) {
    case 'done':
      return {
        ...base,
        reason: 'Completion condition verified',
        evidence: { quote: 'Stays in Lisbon', url: base.url, confidence: 0.92 },
        checks: [{ type: 'url_contains', text: 'Lisbon', pass: true, detail: base.url }],
      };
    case 'needs_input':
      return { ...base, reason: 'No supplied value fits the field "Email"', stuck, missing: [{ label: 'Email', role: 'textbox', path: '/search' }] };
    case 'needs_confirmation':
      return { ...base, reason: 'Clicking "Pay €412" looks irreversible (risk 0.92)', stuck };
    case 'uncertain':
      return { ...base, reason: 'Jev was unsure of the next step (confidence 0.21)', stuck };
    case 'blocked':
      return { ...base, reason: 'The page is a sign-in screen', stuck, wall: { kind: 'sign_in', origin: 'https://stays.example' } };
    case 'step_budget':
      return { ...base, reason: 'The step budget (2 steps) ran out' };
  }
};

/** How one call of a fake task runs: what it tells the step listener and the summary it returns. */
export type FakeRun = (context: { signal?: AbortSignal; onStep?: (step: any, n: number, url: string) => void }) => Promise<TaskSummary>;

/** Tells each step of the summary, then returns it. */
export const runTo = (summary: TaskSummary): FakeRun => async ({ onStep }) => {
  summary.steps.forEach((step, index) => onStep?.(step, index + 1, summary.url));
  return summary;
};

/**
 * A runner whose tasks answer from a queue of runs (a `done` when it is empty) and leave a run folder's files and end
 * page in `lastCall`, as a real `BrowserTask` with `output` does. `noScreenshot` makes the next call's capture fail.
 */
export const fakeRunner = () => {
  const runs: FakeRun[] = [];
  const started: StartOptions[] = [];
  const updates: unknown[] = [];
  const state = { noScreenshot: false };
  const runner = {
    requireKey: () => undefined,
    start: vi.fn(async (options: StartOptions) => {
      started.push(options);
      if (!options.url && !options.tab) throw new Error('Pass `url` to open a new tab or `tab` to reuse an open one.');
      let lastCall: { files: Record<string, string>; screenshot?: Buffer } | undefined;
      const dir = options.output!.dir;
      return {
        update: (changes: unknown) => updates.push(changes),
        look: async () => page({ url: 'http://fixture/stays', text: 'Looked at' }),
        closeTabs: vi.fn(async () => undefined),
        get lastCall() {
          return lastCall;
        },
        run: async (context: Parameters<FakeRun>[0] = {}) => {
          const summary = await (runs.shift() ?? runTo(summaryFor('done')))(context);
          const recorded = options.output!.record;
          lastCall = {
            files: {
              run_dir: dir,
              ...(!state.noScreenshot && { screenshot: join(dir, 'final.jpg') }),
              ...(recorded && { page: join(dir, 'index.html'), video: join(dir, 'run.mp4') }),
              manifest: join(dir, 'manifest.json'),
            },
            ...(!state.noScreenshot && { screenshot: END_PAGE }),
          };
          state.noScreenshot = false;
          return summary;
        },
      };
    }),
    look: vi.fn(async ({ url, tab }: { url?: string; tab?: string }) => page({ url: url ?? `http://fixture/${tab}`, text: 'Looked at' })),
    startJourney: vi.fn(async (options: { outDir: string; startUrl: string }) => ({
      report: () => ({ screen: { id: 's01', url: options.startUrl } }),
      preview: async () => END_PAGE.toString('base64'),
      step: async () => ({ screen: { id: 's02' } }),
      autopilot: async () => ({ stopped: 'checkpoint', screen: { id: 's03' } }),
      annotate: vi.fn(),
      finish: async () => ({
        viewer: join(options.outDir, 'index.html'),
        journey_json: join(options.outDir, 'journey.json'),
        screens: 3,
        steps: 2,
        flows: [{ name: 'Explore', screens: 3 }],
        qa_by_severity: {},
        undescribed_screens: ['s02'],
      }),
    })),
    close: vi.fn(async () => undefined),
  };
  return { runner: runner as unknown as Runner & typeof runner, runs, started, updates, state };
};

type Negotiation = NonNullable<ConstructorParameters<typeof Client>[1]>['versionNegotiation'];

/**
 * An MCP client on its own stdio-like connection to a jevway server built over `service`, through the real
 * `serveStdio` (which picks the protocol era). `pin` speaks 2026-07-28; the default opens with a 2025 `initialize`.
 */
export const connect = async ({
  service,
  env = {},
  versionNegotiation,
}: {
  service: ReturnType<typeof createSessionService>;
  env?: Record<string, string>;
  versionNegotiation?: Negotiation;
}) => {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  serveStdio(createMcpServer({ service, version: '9.9.9', env }), { transport: serverEnd, onerror: (error) => console.error(error) });
  const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation });
  await client.connect(clientEnd);
  return client;
};

/** A session service on a fake runner, writing under a fresh temporary output root. */
export const fakeService = () => {
  const fake = fakeRunner();
  const outDir = join(mkdtempSync(join(tmpdir(), 'jevway-mcp-')), '.jevway');
  return { ...fake, outDir, service: createSessionService(fake.runner, { outDir, env: {} }) };
};
