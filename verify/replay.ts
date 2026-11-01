/**
 * Replays recorded Jev answers through the fixture suites, offline and free: no key, no network call to a model.
 *
 *   pnpm verify:replay verify/out/replay/2026-11-01            # replay: verify, gotchas, redteam, capabilities
 *   pnpm verify:replay -- --record verify/out/replay/2026-11-01  # record them first (live: spends Jev credits)
 *   JEVWAY_REPLAY_ONLY=gotchas,redteam pnpm verify:replay verify/out/replay/2026-11-01
 *   node verify/replay.ts --self-check                          # offline proof: a scripted run recorded, then replayed
 *
 * Each suite runs as its own process with JEVWAY_REPLAY and JEVWAY_REPLAY_DIR=<dir>/<suite>. A suite passes only when
 * it exits 0 AND replays with no miss: a request never recorded ends its run as a model error, which a suite can count
 * as a safe hand-back, so misses are counted from their `replay miss:` lines. Gotchas run the `normal` profile unless
 * JEVWAY_GOTCHAS_PROFILES says otherwise: `churn` and `slow` change the page with timing, so they miss by design, and so
 * does `pnpm verify`'s live Wikipedia scenario. Replayed answers come back at once: latencies are replay latencies.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectChrome } from '../src/browser/chrome.ts';
import { Tab } from '../src/browser/tab.ts';
import type { Ask } from '../src/jev/decide.ts';
import { recordingAsk, ReplayMiss, replayingAsk, type RecordedRoute } from '../src/jev/replay.ts';
import { BrowserTask, type TaskSummary } from '../src/task/run-task.ts';

const SUITES = {
  verify: 'run.ts',
  gotchas: 'gotchas.ts',
  redteam: 'redteam.ts',
  capabilities: 'capabilities.ts',
} as const;
type Suite = keyof typeof SUITES;

const MISS = 'replay miss:';

interface SuiteResult {
  suite: Suite;
  exitCode: number;
  misses: string[];
}

// Runs one suite as a child process, echoing its output and collecting its miss lines.
const runSuite = (suite: Suite, mode: 'record' | 'replay', dir: string) =>
  new Promise<SuiteResult>((done) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JEVWAY_REPLAY: mode,
      JEVWAY_REPLAY_DIR: join(dir, suite),
      JEVWAY_GOTCHAS_PROFILES: process.env.JEVWAY_GOTCHAS_PROFILES || 'normal',
    };
    // A replay needs no key: none is loaded or passed on, so nothing can reach a model.
    if (mode === 'replay') {
      delete env.TYPESAFE_API_KEY;
      delete env.OPENROUTER_API_KEY;
    }
    const args = [...(mode === 'record' ? ['--env-file-if-exists=.env'] : []), new URL(SUITES[suite], import.meta.url).pathname];
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const misses: string[] = [];
    const scan = (sink: NodeJS.WriteStream) => (chunk: Buffer) => {
      sink.write(chunk);
      for (const line of chunk.toString().split('\n')) if (line.startsWith(MISS)) misses.push(line);
    };
    child.stdout.on('data', scan(process.stdout));
    child.stderr.on('data', scan(process.stderr));
    child.on('close', (code) => done({ suite, exitCode: code ?? 1, misses }));
  });

const hasRecordings = (dir: string) => {
  try {
    return readdirSync(dir).some((file) => file.endsWith('.jsonl'));
  } catch {
    return false;
  }
};

const runSuites = async (mode: 'record' | 'replay', dir: string) => {
  const only = (process.env.JEVWAY_REPLAY_ONLY ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const name of only) if (!(name in SUITES)) throw new Error(`Unknown suite "${name}"; use ${Object.keys(SUITES).join(' | ')}.`);
  const suites = (only.length ? only : Object.keys(SUITES)) as Suite[];
  for (const suite of suites) {
    const folder = join(dir, suite);
    // Two recordings in one folder would interleave their answers to the same request.
    if (mode === 'record' && hasRecordings(folder)) throw new Error(`${folder} already holds recordings; record into a new folder.`);
    if (mode === 'replay' && !hasRecordings(folder)) throw new Error(`${folder} holds no recordings; record with --record first.`);
  }
  const results: SuiteResult[] = [];
  for (const suite of suites) {
    process.stdout.write(`\n══ ${suite} (${mode}) ══\n`);
    results.push(await runSuite(suite, mode, dir));
  }
  process.stdout.write(`\n${mode === 'replay' ? 'Replayed' : 'Recorded'} ${dir}${mode === 'replay' ? ' (latencies are replay latencies, not Jev\'s)' : ''}\n`);
  for (const { suite, exitCode, misses } of results) {
    const passed = exitCode === 0 && !misses.length;
    process.stdout.write(`  ${passed ? '✔' : '✘'} ${suite.padEnd(13)} exit ${exitCode} · ${misses.length} misses\n`);
    for (const miss of misses.slice(0, 10)) process.stdout.write(`      ${miss}\n`);
    if (misses.length > 10) process.stdout.write(`      … and ${misses.length - 10} more\n`);
  }
  return results.every(({ exitCode, misses }) => exitCode === 0 && !misses.length);
};

// ── Self-check: a scripted run on the stays fixture, recorded, then replayed on a fresh Chrome and port ──

const ROUTE: RecordedRoute = { profile: 'jev', model: 'jev-1.14.0', route: 'direct' };
const PLAN = [
  { operation: 'TYPE_TEXT', target: 'Destination' },
  { operation: 'CLICK', target: 'Lisbon, Portugal' },
  { operation: 'CLICK', target: 'Free cancellation' },
  { operation: 'CLICK', target: 'Search' },
];
// Steps the run takes on its own (closing a popup) are in the history too, but not in the plan.
const PLANNED = PLAN.map((step) => step.operation);

const chosen = (id: string, ids: string[]) => ({
  type: 'choice',
  choice: id,
  confidence: 0.95,
  probabilities: Object.fromEntries(ids.map((other) => [other, other === id ? 0.95 : 0.05 / (ids.length - 1 || 1)])),
});

// A deterministic stand-in for Jev: follows PLAN by the number of planned actions taken, then waits for the results.
const scriptedAsk = (): Ask & { calls: number } => {
  const ask = async (request: any) => {
    ask.calls++;
    const state = Array.isArray(request.state) ? request.state.find((part: any) => part?.page) : request.state;
    const taken = (state?.recent_actions ?? []).filter((action: any) => PLANNED.includes(action.operation)).length;
    const step = state?.recent_actions ? PLAN[taken] : undefined;
    // Past the plan: done once the results are listed, else wait for them.
    const listed = String(state?.page?.text ?? '').includes('stays in Lisbon');
    const next = step?.operation ?? (listed ? 'DONE' : 'WAIT');
    const answers = Object.fromEntries(
      Object.entries(request.questions as Record<string, any>).map(([id, question]) => {
        if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'done_check' && next === 'DONE' ? 0.95 : 0 }];
        if (question.type === 'box') return [id, { type: 'box', box: { top: 0, bottom: 0.01, left: 0, right: 0.01 }, confidence: 0 }];
        const ids = Object.keys(question.criteria);
        if (id === 'operation') return [id, chosen(next, ids)];
        if (id.startsWith('value_for_')) return [id, chosen(ids.includes('destination') ? 'destination' : ids[0], ids)];
        const named = ids.find((key) => JSON.stringify(question.criteria[key]).includes(`] ${step?.target}`));
        return [id, chosen(named ?? ids[0], ids)];
      }),
    );
    return { answers, usage: { input_tokens: 100 } };
  };
  ask.calls = 0;
  return ask as Ask & { calls: number };
};

const selfCheckRun = async (ask: Ask) => {
  const fixture = readFileSync(new URL('./fixture/stays.html', import.meta.url));
  const server = createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(fixture));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/stays.html`;
  const chrome = await connectChrome('launch-headless');
  try {
    const tab = await Tab.open(chrome.cdp, url);
    const summary = await new BrowserTask(tab, ask, {
      goal: 'Search stays in Lisbon with free cancellation.',
      values: { destination: 'Lisbon' },
      doneWhen: 'Search results for Lisbon are listed.',
      screenshots: 'always',
      imageTransport: 'assets',
      maxSteps: 6,
    }).run();
    const { result } = await tab.send('Runtime.evaluate', { expression: 'window.__fixture', returnByValue: true });
    return { summary, fixture: result.value };
  } finally {
    await chrome.close();
    server.close();
  }
};

const comparable = ({ status, reason, steps }: TaskSummary) => ({ status, reason, steps });

const selfCheck = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevway-replay-self-check-'));
  const scripted = scriptedAsk();
  const recorded = await selfCheckRun(recordingAsk(scripted, ROUTE, dir));
  const recordedCalls = scripted.calls;
  process.stdout.write(`recorded: ${recorded.summary.status} in ${recorded.summary.steps.length} actions, ${recordedCalls} requests → ${dir}\n`);

  const replay = replayingAsk(ROUTE.model, dir);
  const misses: string[] = [];
  let answered = 0;
  const counted: Ask = async (request, options) => {
    try {
      const answer = await replay(request, options);
      answered++;
      return answer;
    } catch (error) {
      if (error instanceof ReplayMiss) misses.push(error.message);
      throw error;
    }
  };
  const replayed = await selfCheckRun(counted);
  process.stdout.write(`replayed: ${replayed.summary.status} in ${replayed.summary.steps.length} actions, ${answered} answers, ${misses.length} misses\n`);
  for (const miss of misses) process.stdout.write(`${miss}\n`);

  assert.equal(recorded.summary.status, 'done', `the scripted run did not finish: ${recorded.summary.reason}`);
  assert.deepEqual(misses, [], 'the replay missed');
  assert.equal(scripted.calls, recordedCalls, 'the replay asked the scripted Jev');
  assert.deepEqual(comparable(replayed.summary), comparable(recorded.summary));
  assert.deepEqual(replayed.fixture, recorded.fixture, 'the fixture ended in another state');
  assert.deepEqual(recorded.fixture?.searched, { city: 'Lisbon', guests: '1', freeCancellation: true, breakfast: false }, 'the scripted run did not search');
  process.stdout.write('✔ self-check: the replay matched the recording with no miss and no model call\n');
};

const args = process.argv.slice(2);
if (args.includes('--self-check')) {
  await selfCheck();
} else {
  const record = args.includes('--record');
  const dir = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'verify/out/replay/default');
  process.exitCode = (await runSuites(record ? 'record' : 'replay', dir)) ? 0 : 1;
}
