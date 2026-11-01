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
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectChrome, type BrowserSource } from '../src/browser/chrome.ts';
import { Tab } from '../src/browser/tab.ts';
import { createAsk, profileOptions, resolveModel } from '../src/jev/model.ts';
import { ANY_HOST, narrowHosts } from '../src/task/hosts.ts';
import { BrowserTask, type TaskSummary } from '../src/task/run-task.ts';
import { judgeQuote } from './evidence-quote.ts';

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

// Serve the fixtures on a random local port: /canvas.html, /wide-table.html, anything else is the stays fixture.
const fixture = readFileSync(new URL('./fixture/stays.html', import.meta.url));
const otherFixtures: Record<string, Buffer | string> = {
  '/canvas.html': readFileSync(new URL('./fixture/canvas.html', import.meta.url)),
  '/wide-table.html': readFileSync(new URL('./fixture/wide-table.html', import.meta.url)),
  '/steps.html': readFileSync(new URL('./fixture/steps.html', import.meta.url)),
  '/offhost.html': readFileSync(new URL('./fixture/offhost.html', import.meta.url)),
  '/partner.html': readFileSync(new URL('./fixture/partner.html', import.meta.url)),
  '/iframe-signup.html': readFileSync(new URL('./fixture/iframe-signup.html', import.meta.url), 'utf8'),
};
const server = createServer((request, response) => {
  const page = otherFixtures[request.url ?? ''] ?? fixture;
  response.writeHead(200, { 'content-type': 'text/html' }).end(typeof page === 'string' ? page.replaceAll('{{CROSS_ORIGIN}}', crossOrigin) : page);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/stays.html`;
// The embedded signup form, on a second port reached as localhost: another origin and site, so it runs out of process.
const signupForm = readFileSync(new URL('./fixture/iframe-signup-form.html', import.meta.url));
const frameServer = createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(signupForm));
await new Promise<void>((resolve) => frameServer.listen(0, '127.0.0.1', resolve));
const crossOrigin = `http://localhost:${(frameServer.address() as { port: number }).port}`;

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
  stays.update({ confirmIrreversible: true, confirmTarget: 'Casa Flora' });
  const summary = await stays.run();
  staySummaries.push(summary);
  expectStatus(summary, 'done');
  const state = await fixtureState();
  assert.deepEqual(state.booking, { name: 'Ada Lovelace', email: 'ada@example.com', confirmed: true });
  return summary;
});
saveTrace('fixture-session', stays, staySummaries);
await stayTab.close();

// Only with Box (Jev 1.14 on the TypeSafe API) and screenshots: a Start button drawn on a canvas, which the DOM
// reader can't report. Without the opt-in nothing may be clicked; with it, the box centre must start the game.
if (profile.box && screenshots !== 'off') {
  await scenario('fixture: canvas-only control → opt-in coordinate click', async () => {
    const canvasUrl = fixtureUrl.replace('/stays.html', '/canvas.html');
    const options = {
      ...profileOptions(profile),
      minConfidence,
      screenshots,
      goal: 'Start the game by pressing the Start button.',
      doneWhen: 'The status says the game started.',
      maxSteps: 4,
    };
    const lockedTab = await Tab.open(chrome.cdp, canvasUrl);
    const locked = await new BrowserTask(lockedTab, ask, options).run();
    const lockedState = await groundTruth(lockedTab.targetId, 'window.__fixture');
    await lockedTab.close();
    assert.equal(lockedState.started, false, 'clicked the canvas without allowCoordinateClicks');
    assert.equal(lockedState.misses, 0, 'clicked the canvas without allowCoordinateClicks');

    const tab = await Tab.open(chrome.cdp, canvasUrl);
    const task = new BrowserTask(tab, ask, { ...options, allowCoordinateClicks: true });
    const summary = await task.run();
    saveTrace('canvas', task, [locked, summary]);
    const state = await groundTruth(tab.targetId, 'window.__fixture');
    await tab.close();
    assert.equal(state.started, true, `game not started (${state.misses} misses): ${summary.reason}`);
    return summary;
  });
}

// The caller's checks (plan 099) confirm a done and overturn one the page doesn't show; the done's quote (plan 100) is the page's own text.
await scenario('fixture: caller checks confirm a done, and any quote it gives is on the page', async () => {
  const tab = await Tab.open(chrome.cdp, fixtureUrl);
  const options = {
    ...profileOptions(profile),
    minConfidence,
    screenshots,
    goal: 'Search stays in Lisbon for 2 guests with free cancellation.',
    values: { destination: 'Lisbon' },
    doneWhen: 'Search results for stays in Lisbon are listed.',
    maxSteps: 12,
  };
  const task = new BrowserTask(tab, ask, {
    ...options,
    checks: [
      { type: 'text_contains', text: 'stays in Lisbon for 2 guest(s)' },
      { type: 'checked', label: 'Free cancellation', state: true },
      { type: 'value_equals', label: 'Guests', value: '2 guests' },
      { type: 'element_exists', role: 'link', name: 'View Casa Flora' },
    ],
  });
  const summary = await task.run();
  // A second call on the same results with a check the page can't pass: Jev's done must come back uncertain.
  const overturned = new BrowserTask(tab, ask, { ...options, checks: [{ type: 'text_contains', text: 'Booking confirmed' }] });
  const unconfirmed = await overturned.run();
  saveTrace('checks-evidence', task, [summary, unconfirmed]);
  const state = await groundTruth(tab.targetId, 'window.__fixture');
  const bodyText = String(await groundTruth(tab.targetId, 'document.body.innerText'));
  await tab.close();
  assert.equal(state.searched?.city, 'Lisbon', 'search was not applied to Lisbon');
  assert.equal(state.searched?.guests, '2', 'search did not use 2 guests');
  assert.equal(state.searched?.freeCancellation, true, 'free cancellation filter not applied');
  expectStatus(summary, 'done');
  assert.deepEqual(summary.checks?.map((check) => check.pass), [true, true, true, true], JSON.stringify(summary.checks));
  // Precision, not recall: a quote given must be the page's own text; a done without one is reported, not failed.
  const quote = judgeQuote(summary.evidence, bodyText);
  process.stdout.write(`  ${quote.line}${summary.evidence?.deep_link ? ` ${summary.evidence.deep_link}` : ''}\n`);
  assert.ok(quote.pass, quote.line);
  assert.equal(unconfirmed.status, 'uncertain', `a failing check left ${unconfirmed.status}: ${unconfirmed.reason}`);
  assert.match(unconfirmed.reason, /Booking confirmed/);
  assert.equal(unconfirmed.evidence, undefined);
  return summary;
});

// Rows wider than their scroll box (Langfuse's traces table): the row, not its checkbox, must be listed and opened.
await scenario('fixture: wide table row opens its detail (recorded)', async () => {
  const tab = await Tab.open(chrome.cdp, fixtureUrl.replace('/stays.html', '/wide-table.html'));
  const { actions } = await tab.observe();
  const rows = actions.filter((action) => action.role === 'row');
  assert.equal(rows.length, 3, `expected 3 clickable rows, snapshot listed ${rows.length}`);
  assert.ok(actions.some((a) => a.role === 'columnheader' && a.label.startsWith('Start time')), 'sortable header not listed');
  const task = new BrowserTask(tab, ask, {
    ...profileOptions(profile),
    minConfidence,
    screenshots,
    goal: 'Open the most recent trace (the top row) to see its detail. Do not select or delete anything.',
    doneWhen: 'The trace detail panel for handle-chatbot-message is showing its input and output.',
    maxSteps: 5,
    recordDir: new URL('wide-table/', outDir).pathname,
  });
  const summary = await task.run();
  saveTrace('wide-table', task, [summary]);
  const state = await groundTruth(tab.targetId, 'window.__fixture');
  await tab.close();
  assert.equal(state.opened, 'handle-chatbot-message', `opened ${state.opened}: ${summary.reason}`);
  assert.deepEqual(state.selected, [], 'ticked a row checkbox instead of opening the row');
  return summary;
});

// allowed_hosts: the partner link goes to localhost (same server, another host). The click may run; nothing after it may.
await scenario('fixture: a link to another host ends the run blocked (allowed hosts)', async () => {
  const tab = await Tab.open(chrome.cdp, fixtureUrl.replace('/stays.html', '/offhost.html'));
  const task = new BrowserTask(tab, ask, {
    ...profileOptions(profile),
    minConfidence,
    screenshots,
    goal: 'Open the partner offer and claim it.',
    doneWhen: 'The partner offer shows as claimed.',
    maxSteps: 6,
    hosts: narrowHosts(ANY_HOST, { allowed: ['127.0.0.1'] }),
  });
  const summary = await task.run();
  saveTrace('offhost', task, [summary]);
  const state = await groundTruth(tab.targetId, '({ host: location.hostname, claimed: window.__fixture?.claimed })');
  await tab.close();
  expectStatus(summary, 'blocked');
  assert.match(summary.reason, /localhost is outside the allowed hosts \(127\.0\.0\.1\)/);
  assert.equal(state.host, 'localhost', 'the run never followed the partner link');
  assert.equal(state.claimed, false, 'the run acted on a host outside its allowed hosts');
  return summary;
});

// A newsletter form in a cross-origin iframe: the frame is read like the page and typed into. Subscribing sends something, so
// the click is handed back for confirmation first; the confirmed continuation (naming the newsletter, which only the frame
// shows) completes it.
await scenario('fixture: signup form inside a cross-origin iframe, confirmed', async () => {
  const tab = await Tab.open(chrome.cdp, fixtureUrl.replace('/stays.html', '/iframe-signup.html'));
  const task = new BrowserTask(tab, ask, {
    ...profileOptions(profile),
    minConfidence,
    screenshots,
    goal: 'Subscribe to the newsletter with my email address using the signup form on this page.',
    values: { email: 'ada@example.com' },
    doneWhen: 'The signup form says ada@example.com is subscribed.',
    maxSteps: 6,
  });
  const first = await task.run();
  const before = await groundTruth(tab.targetId, 'window.__fixture');
  task.update({ confirmIrreversible: true, confirmTarget: 'the newsletter' });
  const summary = await task.run();
  saveTrace('iframe-signup', task, [first, summary]);
  const state = await groundTruth(tab.targetId, 'window.__fixture');
  await tab.close();
  expectStatus(first, 'needs_confirmation');
  assert.equal(before.subscribed, null, 'subscribed before the confirmation');
  expectStatus(summary, 'done');
  assert.equal(state.subscribed, 'ada@example.com', `subscribed ${state.subscribed}: ${summary.reason}`);
  assert.equal(state.shared, false, 'clicked an unrelated control on the page');
  return summary;
});

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
  // A redirect alias (/wiki/Gödel_incompleteness_theorems) shows the same article: compare its canonical link.
  const url = await groundTruth(
    tab.targetId,
    `decodeURIComponent(new URL(document.querySelector('link[rel="canonical"]')?.href ?? location.href).pathname)`,
  );
  await tab.close();
  expectStatus(summary, 'done');
  assert.equal(url, "/wiki/Gödel's_incompleteness_theorems");
  return summary;
});

// The MCP server shares this Chrome, so ground truth reads the very tab it drives. A client that cancels mid-run must
// leave nothing running: at most the press already under way lands after the cancel, and none a second later.
await scenario('MCP stdio: a cancelled browser_task stops acting (session continues)', async () => {
  const recordDir = new URL('cancel/', outDir).pathname;
  const client = new Client({ name: 'jevway-verify', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL('../src/mcp.ts', import.meta.url).pathname],
      env: { ...process.env, JEV_BROWSER: chrome.endpoint } as Record<string, string>,
      stderr: 'inherit',
    }),
  );
  const call = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const response: any = await client.callTool({ name: 'browser_task', arguments: args }, undefined, signal && { signal });
    assert.ok(!response.isError, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const first = await call({
      url: fixtureUrl.replace('/stays.html', '/steps.html'),
      goal: 'Press the "Step 1" button.',
      done_when: 'Step 1 shows as pressed.',
      record_dir: recordDir,
    });
    expectStatus(first, 'done');
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const target = targetInfos.find((info: any) => info.type === 'page' && info.url.includes('/steps.html'));
    const pressed = async (): Promise<{ step: number; t: number }[]> => (await groundTruth(target.targetId, 'window.__fixture')).pressed;
    const before = (await pressed()).length;

    const controller = new AbortController();
    const cancelled = call(
      {
        session: first.session,
        goal: 'Press the buttons "Step 2" through "Step 10", one at a time, in order.',
        done_when: 'All ten steps show as pressed.',
      },
      controller.signal,
    ).catch((error: Error) => error);
    // Cancel once two more presses landed: the run is mid-way, between or inside its steps.
    const deadline = Date.now() + 60_000;
    while ((await pressed()).length < before + 2) {
      assert.ok(Date.now() < deadline, 'the run never pressed two more steps');
      await sleep(50);
    }
    controller.abort();
    const cancelledAt = Date.now();
    const atCancel = (await pressed()).length;
    assert.ok((await cancelled) instanceof Error, 'the cancelled call returned a result');
    await sleep(5000);
    const after = await pressed();
    const late = after.filter((press) => press.t > cancelledAt);
    assert.ok(after.length <= atCancel + 1, `${after.length - atCancel} presses after the cancel: ${JSON.stringify(late)}`);
    assert.ok(late.every((press) => press.t - cancelledAt < 1000), `a press landed over 1 s after the cancel: ${JSON.stringify(late)}`);

    // The run's own record (nobody read the cancelled call's result) ends cancelled, with one executed click per press.
    const recorded = JSON.parse(readFileSync(join(recordDir, 'summary.json'), 'utf8')).summaries[1];
    assert.equal(recorded.status, 'blocked', recorded.reason);
    assert.equal(recorded.reason, 'Cancelled by the caller');
    const clicks = recorded.steps.filter((step: any) => step.operation === 'CLICK' && !step.not_executed);
    assert.equal(clicks.length, after.length - before, 'recorded clicks and real presses differ');

    // The session's next call runs normally.
    const next = await call({ session: first.session, goal: 'Press the "Step 10" button.', done_when: 'Step 10 shows as pressed.' });
    expectStatus(next, 'done');
    assert.ok((await pressed()).some((press) => press.step === 10), 'Step 10 was not pressed');
    writeFileSync(new URL('cancel.json', outDir), JSON.stringify({ first, recorded, next, pressed: await pressed(), cancelledAt }, null, 2));
    await client.callTool({ name: 'browser_task_end', arguments: { session: first.session } });
    return { ...recorded, steps: recorded.steps };
  } finally {
    await client.close();
  }
});

await chrome.close();

await scenario('MCP stdio: tools list + browser_task + browser_task_end', async () => {
  const client = new Client({ name: 'jevway-verify', version: '0.0.0' });
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
    assert.ok(['browser_task', 'browser_task_end', 'browser_look'].every((name) => names.includes(name)), names.join(', '));
    assert.equal(tools.find((tool) => tool.name === 'browser_look')?.annotations?.readOnlyHint, true, 'browser_look is not read-only');
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
    // A look at the same tab: no Jev request, the same page, nothing to act on.
    const looked: any = await client.callTool({ name: 'browser_look', arguments: { session: summary.session } });
    assert.ok(!looked.isError, looked.content[0].text);
    const look = JSON.parse(looked.content[0].text);
    writeFileSync(new URL('mcp-look.json', outDir), JSON.stringify(look, null, 2));
    assert.equal(look.url, summary.url);
    assert.match(look.page_text, /London/);
    assert.ok(look.elements.length > 0 && !looked.content[0].text.includes('"node"'), 'the look listed node ids');
    const ended: any = await client.callTool({ name: 'browser_task_end', arguments: { session: summary.session } });
    assert.match(ended.content[0].text, /ended/);
    return summary;
  } finally {
    await client.close();
  }
});

server.close();
frameServer.close();
writeFileSync(new URL('report.json', outDir), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.passed);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} scenarios passed · traces in ${outDir.pathname}\n`,
);
process.exitCode = failed.length ? 1 : 0;
