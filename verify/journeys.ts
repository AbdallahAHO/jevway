/**
 * Live verification of mobile journey mapping: real headless Chrome, real Jev, fixture ground truth.
 *
 *   pnpm verify:journeys
 *
 * Asserts against what the fixture actually rendered (window.__visited, window.__paid), the PNG files on disk,
 * and the rendered viewer, never against the session's own report alone.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectChrome } from '../src/browser/chrome.ts';
import { Tab } from '../src/browser/tab.ts';
import { createAsk, profileOptions, resolveModel } from '../src/jev/model.ts';
import type { JourneyDoc } from '../src/journeys/journey-doc.ts';
import { JourneySession, type ScreenReport } from '../src/journeys/journey-session.ts';


const outRoot = new URL(`./out/journeys-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url).pathname;
mkdirSync(outRoot, { recursive: true });

const fixture = readFileSync(new URL('./fixture/journey.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.url?.startsWith('/missing')) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'text/html' }).end(fixture);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const chrome = await connectChrome('launch-headless');
const { profile, screenshots } = resolveModel();
const ask = createAsk(profile);
process.stdout.write(`model: ${profile.name} · screenshots: ${screenshots}\n`);
const results: { scenario: string; passed: boolean; note?: string; error?: string }[] = [];

const scenario = async (name: string, body: () => Promise<string | void>) => {
  process.stdout.write(`▶ ${name}\n`);
  const started = performance.now();
  try {
    const note = await body();
    const ms = Math.round(performance.now() - started);
    results.push({ scenario: name, passed: true, note: `${note ?? ''} (${ms}ms)` });
    process.stdout.write(`  ✔ ${note ?? 'pass'} · ${ms}ms\n`);
  } catch (error) {
    results.push({ scenario: name, passed: false, error: (error as Error).message });
    process.stdout.write(`  ✘ FAIL — ${(error as Error).message}\n`);
  }
};

const truth = async (targetId: string, expression: string) => {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const { result } = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  return result.value;
};

const pngSize = (file: string) => {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const indexOf = (report: ScreenReport, label: RegExp) => {
  const row = report.elements.find((line) => label.test(line));
  assert.ok(row, `no element matching ${label} in:\n${report.elements.join('\n')}`);
  return row.match(/^\[([^\]]+)\]/)![1];
};

const kinds = (doc: JourneyDoc, screenId: string) => doc.screens.find((s) => s.id === screenId)!.qa.map((f) => f.kind);

// ── Guided loop, exactly as an agent drives it ──────────────────────────────────────────────
const outDir = join(outRoot, 'guided');
let journey!: JourneySession;
let report!: ScreenReport;
const ids: Record<string, string> = {};

await scenario('start: phone viewport, screenshot, Jev screen understanding', async () => {
  journey = await JourneySession.start(chrome.cdp, ask, {
    startUrl: fixtureUrl,
    outDir,
    screenshots,
    ...profileOptions(profile),
  });
  report = journey.report();
  ids.home = report.screen.id;
  assert.equal(report.screen.type, 'home');
  assert.deepEqual(pngSize(report.screenshot), { width: 393 * 2, height: 852 * 2 });
  assert.ok(report.jev.ranked_taps.length > 0);
  const preview = Buffer.from(await journey.preview(), 'base64');
  assert.ok(preview.length > 1000 && preview.length < 400_000, `preview is ${preview.length} bytes`);
  return `s01=${report.screen.type} (${report.screen.type_confidence}), patterns: ${report.screen.patterns.join(', ')}; Jev suggests ${report.jev.suggests.operation} "${report.jev.suggests.element}"`;
});

await scenario('guided: search pill → type → autocomplete → Search (touch taps, flow + insight recorded)', async () => {
  report = await journey.step({
    next: indexOf(report, /"Where to\?/),
    flow: 'Homes/Searching homes',
    description: 'Home: search pill, category chips, popular stays list, bottom tab bar.',
    insight: 'Search is the primary entry point; tab bar gives four top-level destinations.',
  });
  ids.search = report.screen.id;
  report = await journey.step({ next: indexOf(report, /Destination/), value: 'Lis' });
  report = await journey.step({ next: indexOf(report, /"Lisbon, Portugal"/) });
  report = await journey.step({
    next: indexOf(report, /"Search"/),
    description: 'Destination search with autocomplete.',
  });
  ids.results = report.screen.id;
  const visited = await truth(journey.tab.targetId, 'window.__visited');
  assert.ok(visited.includes('/search') && visited.includes('/results'), `visited ${visited}`);
  assert.equal(report.screen.type, 'results');
  assert.match(report.screen.title + JSON.stringify(report.elements), /Casa Flora/);
  return `now ${ids.results}=results; visited ${visited.join(' → ')}`;
});

await scenario(
  'guided: open a stay; QA catches planted console error, overflow, 404, tiny unlabeled hearts',
  async () => {
    report = await journey.step({ next: indexOf(report, /"Casa Flora/), flow: 'Homes/Home details' });
    ids.detail = report.screen.id;
    assert.equal(report.screen.type, 'detail');
    const doc = journey.doc;
    assert.ok(kinds(doc, ids.detail).includes('console_error'), `detail QA: ${kinds(doc, ids.detail)}`);
    assert.ok(kinds(doc, ids.detail).includes('horizontal_overflow'), `detail QA: ${kinds(doc, ids.detail)}`);
    assert.ok(kinds(doc, ids.results).includes('failed_request'), `results QA: ${kinds(doc, ids.results)}`);
    for (const screen of [ids.home, ids.results]) {
      assert.ok(kinds(doc, screen).includes('small_tap_target'), `${screen} QA: ${kinds(doc, screen)}`);
      assert.ok(kinds(doc, screen).includes('unlabeled_control'), `${screen} QA: ${kinds(doc, screen)}`);
    }
    const hotspot = doc.steps[0].hotspot!;
    assert.ok(
      hotspot.y > 0.05 && hotspot.y < 0.2 && hotspot.width > 0.8,
      `search pill hotspot ${JSON.stringify(hotspot)}`,
    );
    return `detail QA: ${kinds(doc, ids.detail).join(', ')}`;
  },
);

await scenario('guided: back returns to the SAME results screen (no duplicate screenshot)', async () => {
  const before = journey.doc.screens.length;
  report = await journey.step({ next: 'back', insight: 'Detail has a single dominant Reserve CTA.' });
  assert.equal(report.screen.id, ids.results, `back landed on ${report.screen.id} (${report.screen.type})`);
  assert.equal(report.screen.is_new, false);
  assert.equal(journey.doc.screens.length, before);
  return `back → ${report.screen.id}, screens still ${before}`;
});

await scenario('autopilot (explore): discovers new screens, stays on-site, never pays', async () => {
  const result = await journey.autopilot({ screens: 4, flow: 'Explore' });
  const paid = await truth(journey.tab.targetId, 'window.__paid');
  const host = await truth(journey.tab.targetId, 'location.host');
  assert.equal(paid, false, 'autopilot paid');
  assert.equal(host, new URL(fixtureUrl).host, 'autopilot left the site');
  const homes = journey.doc.screens.filter((screen) => screen.type === 'home');
  assert.equal(homes.length, 1, `home screen recorded ${homes.length}× (${homes.map((h) => h.id)})`);
  assert.ok(
    result.discovered.length >= 2,
    `discovered only ${JSON.stringify(result.discovered)} (stopped: ${result.stopped})`,
  );
  return `stopped=${result.stopped}; discovered ${result.discovered.map((d: any) => `${d.id}:${d.type} via "${d.via}"`).join(', ')}${
    'skipped_irreversible' in result ? `; skipped ${result.skipped_irreversible}` : ''
  }`;
});

await scenario('autopilot (intent): reserve flow stops before "Confirm and pay"', async () => {
  report = await journey.step({ next: 'restart' });
  const result = await journey.autopilot({
    screens: 8,
    flow: 'Homes/Reserving a home',
    intent: 'Open a stay in Lisbon and get to its payment screen, without paying.',
  });
  const paid = await truth(journey.tab.targetId, 'window.__paid');
  assert.equal(paid, false, 'intent autopilot paid');
  const visited: string[] = await truth(journey.tab.targetId, 'window.__visited');
  assert.ok(
    visited.some((route) => route.startsWith('/reserve')),
    `never reached payment: ${visited.join(' → ')} (stopped ${result.stopped})`,
  );
  return `stopped=${result.stopped}${'detail' in result ? ` (${result.detail})` : ''}; route ${visited.slice(-4).join(' → ')}`;
});

await scenario('finish: journey.json flows, every screenshot on disk, viewer renders', async () => {
  for (const screen of journey.doc.screens.slice(0, 3)) {
    journey.annotate(screen.id, { description: screen.description ?? `${screen.type} screen: ${screen.title}` });
  }
  const summary = await journey.finish();
  const doc: JourneyDoc = JSON.parse(readFileSync(summary.journey_json, 'utf8'));
  const searching = doc.flows.find((flow) => flow.name === 'Homes/Searching homes');
  assert.ok(
    searching && searching.screens.length >= 3,
    `flows: ${JSON.stringify(doc.flows.map((f) => [f.name, f.screens.length]))}`,
  );
  assert.ok(
    doc.flows.some((flow) => flow.name === 'Homes' && flow.parent === null),
    'parent flow missing',
  );
  for (const screen of doc.screens)
    assert.ok(existsSync(join(outDir, screen.screenshot)), `${screen.screenshot} missing`);

  const viewer = await Tab.open(chrome.cdp, `file://${summary.viewer}`);
  const check = await truth(
    viewer.targetId,
    `new Promise(r => setTimeout(() => r({
      cards: document.querySelectorAll('#flows .card').length,
      broken: [...document.images].filter(i => i.complete && !i.naturalWidth).length,
      hotspots: document.querySelectorAll('.hotspot').length,
      flows: [...document.querySelectorAll('.flow h2')].map(h => h.textContent),
    }), 600))`,
  );
  writeFileSync(join(outRoot, 'viewer.png'), Buffer.from(await viewer.screenshot(), 'base64'));
  await viewer.close();
  assert.ok(check.cards >= 5 && check.hotspots >= 3 && check.broken === 0, JSON.stringify(check));
  return `${summary.screens} screens · ${summary.steps} steps · flows ${check.flows.join(' | ')} · QA ${JSON.stringify(summary.qa_by_severity)}`;
});

await chrome.close();

// ── The same loop over MCP stdio ────────────────────────────────────────────────────────────
await scenario('MCP: jevway_journey_start (image block) → jevway_journey_autopilot → jevway_journey_annotate → jevway_journey_finish', async () => {
  const client = new Client({ name: 'journey-verify', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL('../src/mcp.ts', import.meta.url).pathname],
      env: { ...process.env, JEVWAY_BROWSER: 'launch-headless', JEVWAY_JOURNEYS_DIR: join(outRoot, 'mcp') } as Record<
        string,
        string
      >,
      stderr: 'inherit',
    }),
  );
  try {
    const { tools } = await client.listTools();
    for (const name of ['jevway_journey_start', 'jevway_journey_step', 'jevway_journey_autopilot', 'jevway_journey_annotate', 'jevway_journey_finish']) {
      assert.ok(
        tools.some((tool) => tool.name === name),
        `${name} not listed`,
      );
    }
    const started: any = await client.callTool({ name: 'jevway_journey_start', arguments: { url: fixtureUrl } });
    assert.ok(!started.isError, started.content[0].text);
    assert.equal(started.content[1].type, 'image');
    const { journey: id } = JSON.parse(started.content[0].text);
    const explored: any = await client.callTool({
      name: 'jevway_journey_autopilot',
      arguments: { journey: id, screens: 2, flow: 'Explore' },
    });
    assert.ok(!explored.isError, explored.content[0].text);
    const annotated: any = await client.callTool({
      name: 'jevway_journey_annotate',
      arguments: {
        journey: id,
        screen: 's01',
        description: 'Home screen',
        relabel: { from_step: 0, to_step: 0, flow: 'Explore/First tap' },
      },
    });
    assert.ok(!annotated.isError, annotated.content[0].text);
    const finished: any = await client.callTool({ name: 'jevway_journey_finish', arguments: { journey: id } });
    const summary = JSON.parse(finished.content[0].text);
    assert.ok(summary.screens >= 3 && existsSync(summary.viewer), finished.content[0].text);
    return `${summary.screens} screens, flows ${summary.flows.map((f: any) => f.name).join(', ')}`;
  } finally {
    await client.close();
  }
});

server.close();
writeFileSync(join(outRoot, 'report.json'), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.passed).length;
process.stdout.write(`\n${results.length - failed}/${results.length} journey scenarios passed · ${outRoot}\n`);
process.exitCode = failed ? 1 : 0;
