/**
 * Live gotcha suite: real Jev on small local pages that rebuild the patterns that broke it on a real app
 * (suggestions that ignore Escape, sortable tables, div date pickers, targets below the fold, late content),
 * run plainly and under stress. Reports pass rates and crashes; failures are findings, not fixes.
 *
 *   pnpm verify:gotchas
 *   JEVWAY_GOTCHAS_RUNS=1 JEVWAY_GOTCHAS_PROFILES=normal pnpm verify:gotchas   # quick look
 *   JEVWAY_GOTCHAS_ONLY=wizard,toggle-trap pnpm verify:gotchas                 # a few scenarios
 *
 * Profiles: `normal` (plain page), `slow` (400 ms latency, 50 KB/s, 4x CPU throttling), `churn` (?chaos=1: the list is
 * rebuilt every 900 ms, a 40 px banner comes and goes every 1.3 s, click effects land 300-800 ms late).
 * A run passes (✔) only when the page's own state (window.__fixture) shows the goal reached AND the run ended `done`;
 * ◐ is a goal reached with another status (the calling agent would think it failed), ✘ a goal not reached.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connectChrome } from '../src/browser/chrome.ts';
import { Tab } from '../src/browser/tab.ts';
import { createAsk, profileOptions, resolveModel } from '../src/jev/model.ts';
import { BrowserTask, type TaskSummary } from '../src/task/run-task.ts';

const PROFILES = ['normal', 'slow', 'churn'] as const;
type Profile = (typeof PROFILES)[number];

interface Scenario {
  id: string;
  goal: string;
  values?: Record<string, string>;
  doneWhen: string;
  /** Page expression that is true only when the goal was really reached. */
  passes: string;
}

interface RunResult {
  scenario: string;
  profile: Profile;
  run: number;
  /** Strict: the page shows the goal reached and the run ended `done`. */
  passed: boolean;
  /** The page's own state shows the goal reached, whatever status the run ended with. */
  reached: boolean;
  /** `task.run()` (or the browser around it) threw: it should always hand back a summary instead. */
  crashed: boolean;
  summary?: TaskSummary;
  fixture?: unknown;
  error?: string;
}

// Each scenario is verify/fixture/gotchas/<id>.html.
const SCENARIOS: Scenario[] = [
  {
    id: 'search-suggestions',
    goal: 'Search the traces for the text in query and open the trace whose input asks about the weather in Berlin.',
    values: { query: 'weather' },
    doneWhen: 'A trace detail panel about the weather in Berlin is open.',
    passes: `window.__fixture.opened === 'trace-berlin'`,
  },
  {
    id: 'sort-then-open',
    goal: 'Sort the sessions by total cost, highest first, and open the most expensive session.',
    doneWhen: 'A session detail is open.',
    passes: `window.__fixture.opened === 'session-07'`,
  },
  {
    id: 'date-range',
    goal: "Set the dashboard's date range to the past 7 days.",
    doneWhen: 'The range button reads "Past 7 days" and the menu is closed.',
    passes: `window.__fixture.range === '7d'`,
  },
  {
    id: 'below-fold',
    goal: 'Open the user whose ID is in user_id.',
    values: { user_id: 'u-0047' },
    doneWhen: 'The detail page for user u-0047 is open.',
    passes: `window.__fixture.opened === 'u-0047'`,
  },
  {
    id: 'late-content',
    goal: 'Open the run named "nightly-eval".',
    doneWhen: 'The run "nightly-eval" is open.',
    passes: `window.__fixture.opened === 'nightly-eval'`,
  },
  {
    id: 'wizard',
    goal: 'Complete the setup wizard with the name in name.',
    values: { name: 'Ada' },
    doneWhen: '"Setup complete" is shown.',
    passes: `window.__fixture.done === true && window.__fixture.name === 'Ada'`,
  },
  {
    id: 'sticky-header',
    goal: 'Open Item 23.',
    doneWhen: 'Item 23 is open.',
    passes: `window.__fixture.opened === 'item-23'`,
  },
  {
    id: 'consent-first',
    goal: 'Search for the text in query and open the first result.',
    values: { query: 'latency' },
    doneWhen: 'A search result for latency is open.',
    passes: `window.__fixture.opened === 'result-1'`,
  },
  {
    id: 'infinite-scroll',
    goal: 'Open Item 55.',
    doneWhen: 'Item 55 is open.',
    passes: `window.__fixture.opened === 'item-55'`,
  },
  {
    id: 'toggle-trap',
    goal: 'Show only failed runs.',
    doneWhen: 'Only failed runs are listed.',
    passes: `window.__fixture.filter === 'failed'`,
  },
];

const csv = (name: string) =>
  (process.env[name] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const runsPerCell = Number(process.env.JEVWAY_GOTCHAS_RUNS ?? 3);
const profiles = csv('JEVWAY_GOTCHAS_PROFILES').length ? csv('JEVWAY_GOTCHAS_PROFILES') : [...PROFILES];
const only = csv('JEVWAY_GOTCHAS_ONLY');
for (const name of profiles) {
  if (!PROFILES.includes(name as Profile)) throw new Error(`Unknown profile "${name}"; use ${PROFILES.join(' | ')}.`);
}
for (const id of only) {
  if (!SCENARIOS.some((scenario) => scenario.id === id)) throw new Error(`Unknown scenario "${id}".`);
}
const scenarios = only.length ? SCENARIOS.filter((scenario) => only.includes(scenario.id)) : SCENARIOS;

const { profile: model, screenshots } = resolveModel();
const ask = createAsk(model);
process.stdout.write(
  `model: ${model.name} (${model.model}) · screenshots: ${screenshots} · ${scenarios.length} scenarios × ${profiles.join(', ')} × ${runsPerCell} runs\n`,
);
const outDir = new URL(`./out/gotchas-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
mkdirSync(outDir, { recursive: true });

// Serve every page in verify/fixture/gotchas/ at /<file name> on a random local port; the query string is ignored.
const fixtureDir = new URL('./fixture/gotchas/', import.meta.url);
const pages = Object.fromEntries(
  readdirSync(fixtureDir).map((file) => [`/${file}`, readFileSync(new URL(file, fixtureDir))]),
);
const server = createServer((request, response) => {
  const page = pages[new URL(request.url ?? '/', 'http://localhost').pathname];
  response.writeHead(page ? 200 : 404, { 'content-type': 'text/html' }).end(page);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const chrome = await connectChrome('launch-headless');

// Reads ground truth through a separate CDP session, not through the agent's tab wrapper.
const groundTruth = async (targetId: string, expression: string) => {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const { result } = await chrome.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return result.value;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// How each profile opens a page. Slow throttles before navigating so the page itself loads slowly too.
const openTab: Record<Profile, (url: string) => Promise<Tab>> = {
  normal: (url) => Tab.open(chrome.cdp, url),
  slow: async (url) => {
    const tab = await Tab.open(chrome.cdp, 'about:blank');
    await tab.send('Network.enable');
    await tab.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: 50000,
      uploadThroughput: 20000,
    });
    await tab.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await tab.navigate(url);
    return tab;
  },
  churn: (url) => Tab.open(chrome.cdp, `${url}?chaos=1`),
};

const runOnce = async (scenario: Scenario, profile: Profile, run: number): Promise<RunResult> => {
  const result: RunResult = { scenario: scenario.id, profile, run, passed: false, reached: false, crashed: false };
  let tab: Tab | undefined;
  try {
    tab = await openTab[profile](`${origin}/${scenario.id}.html`);
    const task = new BrowserTask(tab, ask, {
      goal: scenario.goal,
      values: scenario.values,
      doneWhen: scenario.doneWhen,
      screenshots,
      ...profileOptions(model),
      maxSteps: 15,
      recordDir: new URL(`${scenario.id}/${profile}-${run}/`, outDir).pathname,
    });
    result.summary = await task.run();
    // Under churn the last click's effect can still be on its way (up to 800 ms) when the run ends.
    if (profile === 'churn') await sleep(1000);
    result.reached = Boolean(await groundTruth(tab.targetId, scenario.passes));
    result.passed = result.reached && result.summary.status === 'done';
    result.fixture = await groundTruth(tab.targetId, 'window.__fixture');
  } catch (error) {
    result.crashed = true;
    result.passed = false;
    result.reached = false;
    result.error = (error as Error).message;
  } finally {
    await tab?.close();
  }
  return result;
};

const oneLine = (text: string, max = 300) => text.replace(/\s+/g, ' ').slice(0, max);

const describe = (result: RunResult) => {
  const { summary } = result;
  const mark = result.passed ? '✔' : result.reached ? '◐' : '✘';
  const head = `${mark} ${result.scenario} ${result.profile} #${result.run}`;
  if (result.crashed) return `${head} — crashed${summary ? ` after ${summary.steps.length} actions` : ''} · ${oneLine(result.error ?? '')}`;
  if (!summary) return head;
  const timing = `${summary.status} in ${summary.elapsed_ms}ms · ${summary.steps.length} actions`;
  if (result.passed) return `${head} — ${timing}`;
  return `${head} — ${timing} · ${oneLine(summary.reason)} · page: ${oneLine(JSON.stringify(result.fixture), 160)}`;
};

const results: RunResult[] = [];
try {
  for (const scenario of scenarios) {
    for (const profile of profiles as Profile[]) {
      for (let run = 1; run <= runsPerCell; run++) {
        const result = await runOnce(scenario, profile, run);
        results.push(result);
        process.stdout.write(`${describe(result)}\n`);
      }
    }
  }
} finally {
  await chrome.close();
  server.close();
  writeFileSync(new URL('report.json', outDir), JSON.stringify(results, null, 2));
}

const passedIn = (rows: RunResult[]) => rows.filter((row) => row.passed).length;
// Goal reached on the page, but the run ended with a status other than `done`.
const reachedOnlyIn = (rows: RunResult[]) => rows.filter((row) => row.reached && !row.passed).length;
const cell = (rows: RunResult[]) => {
  const reachedOnly = reachedOnlyIn(rows);
  return `${passedIn(rows)}/${rows.length}${reachedOnly ? ` (+${reachedOnly} reached)` : ''}`;
};
const idWidth = Math.max(...scenarios.map((scenario) => scenario.id.length), 'scenario'.length);
const line = (name: string, cells: string[]) => `${name.padEnd(idWidth)}  ${cells.map((text) => text.padStart(24)).join('')}\n`;

process.stdout.write(`\n${line('scenario', profiles)}`);
for (const scenario of scenarios) {
  const rows = results.filter((result) => result.scenario === scenario.id);
  process.stdout.write(line(scenario.id, (profiles as Profile[]).map((profile) => cell(rows.filter((row) => row.profile === profile)))));
}
process.stdout.write(
  line('total', (profiles as Profile[]).map((profile) => {
    const rows = results.filter((row) => row.profile === profile);
    return `${cell(rows)} ${rows.length ? Math.round((passedIn(rows) / rows.length) * 100) : 0}%`;
  })),
);
const crashes = results.filter((result) => result.crashed).length;
const reachedOnly = reachedOnlyIn(results);
process.stdout.write(
  `\n${passedIn(results)}/${results.length} runs passed (done, goal reached)${reachedOnly ? ` · ${reachedOnly} more reached the goal without ending done` : ''} · ${crashes} crashed · report in ${outDir.pathname}report.json\n`,
);
process.exitCode = passedIn(results) === results.length ? 0 : 1;
