/**
 * Live end-to-end verification: real Chrome, real Jev calls, independent ground-truth checks.
 *
 *   pnpm verify                 # headless Chrome, fixture + Wikipedia + MCP stdio
 *   JEV_VERIFY_BROWSER=launch pnpm verify   # watch it in a visible window
 *
 * Every scenario asserts the page's real state (window.__fixture or URL), never Jev's own DONE.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectChrome, type BrowserSource } from '../src/browser/chrome.ts';
import { Tab } from '../src/browser/tab.ts';
import { createAsk, profileOptions, resolveModel } from '../src/jev/model.ts';
import { BrowserTask, type TaskSummary } from '../src/task/run-task.ts';

// JEV_MODEL / JEV_SCREENSHOTS pick the decision model and screenshot mode, as in the MCP server.
const { profile, screenshots } = resolveModel();
const ask = createAsk(profile);
// Experiment override: measure a model's decisions against ground truth without its hand-back threshold.
// It doesn't reach the MCP scenario, whose server uses the profile's threshold.
const minConfidence = Number(process.env.JEV_VERIFY_MIN_CONFIDENCE ?? profile.minConfidence);
process.stdout.write(`model: ${profile.name} (${profile.model}) · screenshots: ${screenshots} · min confidence: ${minConfidence}\n`);
const source = (process.env.JEV_VERIFY_BROWSER ?? 'launch-headless') as BrowserSource;
const outDir = new URL(`./out/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
mkdirSync(outDir, { recursive: true });

// Serve the fixture on a random local port.
const fixture = readFileSync(new URL('./fixture/stays.html', import.meta.url));
const server = createServer((_request, response) =>
  response.writeHead(200, { 'content-type': 'text/html' }).end(fixture),
);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/stays.html`;

const chrome = await connectChrome(source);
const results: { scenario: string; passed: boolean; summary?: Partial<TaskSummary>; error?: string }[] = [];

// Reads ground truth through a separate CDP session, not through the agent's tab wrapper.
const groundTruth = async (targetId: string, expression: string) => {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const { result } = await chrome.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return result.value;
};

const scenario = async (name: string, body: () => Promise<Partial<TaskSummary> | void>) => {
  process.stdout.write(`▶ ${name}\n`);
  try {
    const summary = await body();
    results.push({ scenario: name, passed: true, ...(summary && { summary }) });
    process.stdout.write(`  ✔ pass${summary ? ` — ${brief(summary)}` : ''}\n`);
  } catch (error) {
    results.push({ scenario: name, passed: false, error: (error as Error).message });
    process.stdout.write(`  ✘ FAIL — ${(error as Error).message}\n`);
  }
};

const brief = (s: Partial<TaskSummary>) =>
  `${s.status} in ${s.elapsed_ms}ms · ${s.steps?.length} actions · ${s.jev?.requests} Jev requests (median ${s.jev?.median_latency_ms}ms, ${s.jev?.input_tokens} input tokens, ${s.jev?.screenshots} screenshots)`;

const expectStatus = (summary: TaskSummary, status: TaskSummary['status']) =>
  assert.equal(
    summary.status,
    status,
    `expected ${status}, got ${summary.status}: ${summary.reason}\n${JSON.stringify(summary.stuck ?? summary.steps, null, 1)}`,
  );

const saveTrace = (name: string, task: BrowserTask, summaries: TaskSummary[]) =>
  writeFileSync(new URL(`${name}.json`, outDir), JSON.stringify({ summaries, trace: task.trace }, null, 2));

// 1–4 share one session on one tab, exactly as an agent would continue it.
const stayTab = await Tab.open(chrome.cdp, fixtureUrl);
const stays = new BrowserTask(stayTab, ask, {
  goal: 'Find stays in Lisbon for 2 guests with free cancellation, then open the details of Casa Flora.',
  values: { destination: 'Lisbon' },
  doneWhen: "Casa Flora's details page is showing.",
  screenshots,
  ...profileOptions(profile),
  minConfidence,
});
const staySummaries: TaskSummary[] = [];
const fixtureState = () => groundTruth(stayTab.targetId, 'window.__fixture');

await scenario('fixture: autocomplete + native select + checkbox + async results + open result', async () => {
  const summary = await stays.run();
  staySummaries.push(summary);
  expectStatus(summary, 'done');
  const state = await fixtureState();
  assert.equal(state.searched?.city, 'Lisbon', 'search was not applied to Lisbon');
  assert.equal(state.searched?.guests, '2', 'search did not use 2 guests');
  assert.equal(state.searched?.freeCancellation, true, 'free cancellation filter not applied');
  assert.equal(state.searched?.breakfast, false, 'breakfast filter was set but never requested');
  assert.equal(state.opened, 'casa-flora', 'Casa Flora was not opened');
  return summary;
});

await scenario('fixture: missing value hands back needs_input (nothing invented)', async () => {
  stays.update({
    goal: 'Book Casa Flora for the guest using their full name and email address.',
    values: { full_name: 'Ada Lovelace' },
    doneWhen: 'A booking confirmation with a reference number is showing.',
  });
  const summary = await stays.run();
  staySummaries.push(summary);
  expectStatus(summary, 'needs_input');
  assert.match(summary.reason, /email/i, 'needs_input should name the email field');
  const state = await fixtureState();
  assert.equal(state.booking.confirmed, false);
  return summary;
});

await scenario('fixture: irreversible "Confirm booking and pay" hands back needs_confirmation', async () => {
  stays.update({ values: { email: 'ada@example.com' } });
  const summary = await stays.run();
  staySummaries.push(summary);
  expectStatus(summary, 'needs_confirmation');
  assert.match(summary.reason, /confirm booking/i);
  const state = await fixtureState();
  assert.equal(state.booking.confirmed, false, 'booking must not be confirmed before the agent confirms');
  return summary;
});

await scenario('fixture: confirmed continuation completes the booking', async () => {
  stays.update({ confirmIrreversible: true });
  const summary = await stays.run();
  staySummaries.push(summary);
  expectStatus(summary, 'done');
  const state = await fixtureState();
  assert.deepEqual(state.booking, { name: 'Ada Lovelace', email: 'ada@example.com', confirmed: true });
  return summary;
});
saveTrace('fixture-session', stays, staySummaries);
await stayTab.close();

await scenario('live web: Wikipedia search → Gödel’s incompleteness theorems article', async () => {
  const tab = await Tab.open(chrome.cdp, 'https://en.wikipedia.org/wiki/Main_Page');
  const task = new BrowserTask(tab, ask, {
    goal: 'Find and open the Wikipedia article about Gödel’s incompleteness theorems.',
    values: { search_query: 'Gödel incompleteness theorems' },
    doneWhen: "The Wikipedia article titled Gödel's incompleteness theorems is open.",
    screenshots,
    ...profileOptions(profile),
  minConfidence,
  });
  const summary = await task.run();
  saveTrace('wikipedia', task, [summary]);
  const url = await groundTruth(tab.targetId, 'decodeURIComponent(location.pathname)');
  await tab.close();
  expectStatus(summary, 'done');
  assert.equal(url, "/wiki/Gödel's_incompleteness_theorems");
  return summary;
});

await chrome.close();

await scenario('MCP stdio: tools list + browser_task + browser_task_end', async () => {
  const client = new Client({ name: 'jev-browse-verify', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL('../src/mcp.ts', import.meta.url).pathname],
      env: { ...process.env, JEV_BROWSER: 'launch-headless' } as Record<string, string>,
      stderr: 'inherit',
    }),
  );
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(['browser_task', 'browser_task_end'].every((name) => names.includes(name)), names.join(', '));
    const response: any = await client.callTool({
      name: 'browser_task',
      arguments: {
        url: fixtureUrl,
        goal: 'Search stays in London with free cancellation for 1 guest.',
        values: { destination: 'London' },
        done_when: 'Search results for London are listed.',
      },
    });
    assert.ok(!response.isError, response.content[0].text);
    const summary = JSON.parse(response.content[0].text);
    writeFileSync(new URL('mcp.json', outDir), JSON.stringify(summary, null, 2));
    expectStatus(summary, 'done');
    const ended: any = await client.callTool({ name: 'browser_task_end', arguments: { session: summary.session } });
    assert.match(ended.content[0].text, /ended/);
    return summary;
  } finally {
    await client.close();
  }
});

server.close();
writeFileSync(new URL('report.json', outDir), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.passed);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} scenarios passed · traces in ${outDir.pathname}\n`,
);
process.exitCode = failed.length ? 1 : 0;
