/**
 * Real-world verification: public sites, a fresh headless Chrome per run, ground truth from the page's own URL.
 *
 *   pnpm verify:real                                   # every scenario, 5 runs each, the profile's screenshot mode
 *   JEV_SCREENSHOTS=always JEV_REAL_RUNS=3 pnpm verify:real
 *   JEV_REAL_ONLY=npm,mdn pnpm verify:real
 *
 * Every task stops before any login, payment or submission. Jev's own DONE never counts as a pass.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectChrome, type BrowserSource } from '../src/browser/chrome.ts';
import { Tab } from '../src/browser/tab.ts';
import { buildActionSpace } from '../src/jev/action-space.ts';
import { createAsk, profileOptions, resolveModel } from '../src/jev/model.ts';
import { BrowserTask, type TaskSummary } from '../src/task/run-task.ts';

// Calendars label days like "Thursday, October 29, 2026".
const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

// The same day as a URL parameter ("2026-11-01"), in local time like the calendar labels above.
const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA');

interface Scenario {
  name: string;
  url: string;
  goal: string;
  values?: Record<string, string>;
  doneWhen: string;
  /** Ground truth on the final page's URL (decoded). */
  passes: (url: URL) => boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'wikipedia',
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    goal: 'Find and open the Wikipedia article about the Rosetta Stone.',
    values: { search_query: 'Rosetta Stone' },
    doneWhen: 'The Wikipedia article titled Rosetta Stone is open.',
    passes: (url) => url.pathname === '/wiki/Rosetta_Stone',
  },
  {
    name: 'mdn',
    url: 'https://developer.mozilla.org/en-US/',
    goal: 'Search MDN and open the reference page for the JavaScript method Array.prototype.flat().',
    values: { search_query: 'Array.prototype.flat' },
    doneWhen: 'The MDN reference page for Array.prototype.flat() is open.',
    passes: (url) => url.pathname.endsWith('/Web/JavaScript/Reference/Global_Objects/Array/flat'),
  },
  {
    name: 'github',
    url: 'https://github.com/search?type=repositories',
    goal: 'Search GitHub repositories for "next.js" and open the vercel/next.js repository.',
    values: { search_query: 'next.js' },
    doneWhen: 'The vercel/next.js repository page is open.',
    passes: (url) => url.pathname.toLowerCase() === '/vercel/next.js',
  },
  {
    name: 'hacker-news',
    url: 'https://news.ycombinator.com/',
    goal: 'Open the comments page of the first story on the Hacker News front page.',
    doneWhen: 'A Hacker News comments page for a story is open.',
    passes: (url) => url.hostname === 'news.ycombinator.com' && url.pathname === '/item' && url.searchParams.has('id'),
  },
  {
    name: 'npm',
    url: 'https://www.npmjs.com/',
    goal: 'Search npm for the package "zod" and open its package page.',
    values: { search_query: 'zod' },
    doneWhen: 'The npm package page for zod is open.',
    passes: (url) => url.pathname === '/package/zod',
  },
  {
    name: 'booking',
    url: 'https://www.booking.com/',
    // Without dates Booking shows its city landing page instead of search results.
    goal: `Search for stays in Lisbon from ${daysFromNow(14)} to ${daysFromNow(16)} and show the search results. Do not sign in, book, or reserve anything.`,
    values: { destination: 'Lisbon' },
    doneWhen: `Booking.com's search results for Lisbon are showing for ${daysFromNow(14)} to ${daysFromNow(16)}, with a count of properties found.`,
    // The city landing page drops the dates from its URL, so they are part of the check.
    passes: (url) =>
      url.pathname.includes('/searchresults') &&
      /lisbon|lisboa/i.test(url.searchParams.get('ss') ?? '') &&
      url.searchParams.get('checkin') === isoDaysFromNow(14) &&
      url.searchParams.get('checkout') === isoDaysFromNow(16),
  },
  {
    name: 'airbnb',
    url: 'https://www.airbnb.com/',
    goal: `Search for stays in Lisbon from ${daysFromNow(14)} to ${daysFromNow(16)} and show the search results. Do not sign in, book, or reserve anything.`,
    values: { destination: 'Lisbon' },
    doneWhen: `Airbnb search results for stays in Lisbon are listed for ${daysFromNow(14)} to ${daysFromNow(16)}.`,
    passes: (url) =>
      url.pathname.startsWith('/s/') &&
      /lisbon|lisboa/i.test(url.pathname) &&
      url.searchParams.get('checkin') === isoDaysFromNow(14) &&
      url.searchParams.get('checkout') === isoDaysFromNow(16),
  },
  {
    name: 'google-flights',
    url: 'https://www.google.com/travel/flights?hl=en',
    goal: `Search one-way flights from Lisbon to Berlin departing on ${daysFromNow(14)} and show the results. Do not book anything.`,
    values: { origin: 'Lisbon', destination: 'Berlin' },
    doneWhen: 'Flight results from Lisbon to Berlin are listed.',
    // The form state alone also puts `tfs=` in the URL; only /search means results were requested.
    passes: (url) => url.pathname.startsWith('/travel/flights/search'),
  },
];

const { profile, screenshots } = resolveModel();
const ask = createAsk(profile);
const runs = Number(process.env.JEV_REAL_RUNS ?? 5);
const only = process.env.JEV_REAL_ONLY?.split(',');
const source = (process.env.JEV_VERIFY_BROWSER ?? 'launch-headless') as BrowserSource;
const outDir = new URL(`./out/real-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
mkdirSync(outDir, { recursive: true });
process.stdout.write(`model: ${profile.name} (${profile.model}) · screenshots: ${screenshots} · ${runs} runs each\n`);

// A bot check or captcha ends the run for the environment, not for the agent: reported apart from failures.
// A challenge page says so in its title or at the top; the whole text also matches comments that merely discuss captchas.
const BOT_WALL = /verify(ing)? you are (human|not a bot)|performing security verification|unusual traffic|captcha|are you a robot/i;

interface RunResult {
  scenario: string;
  run: number;
  passed: boolean;
  botWall?: boolean;
  url: string;
  summary?: Partial<TaskSummary>;
  error?: string;
}
const results: RunResult[] = [];

for (const scenario of SCENARIOS.filter((s) => !only || only.includes(s.name))) {
  for (let run = 1; run <= runs; run++) {
    // A fresh browser per run: consent banners and cookies from one run never help the next.
    const chrome = await connectChrome(source);
    let result: RunResult = { scenario: scenario.name, run, passed: false, url: '' };
    try {
      const tab = await Tab.open(chrome.cdp, scenario.url);
      const task = new BrowserTask(tab, ask, {
        ...profileOptions(profile),
        goal: scenario.goal,
        values: scenario.values,
        doneWhen: scenario.doneWhen,
        maxSteps: 25,
        screenshots,
      });
      const summary = await task.run();
      // Ground truth comes from a separate read of the page, not from the task's summary.
      const url = String(await tab.evaluate('location.href'));
      // Challenge pages can sit at the target URL itself (npm serves Cloudflare's at /package/zod).
      const pageHead = String(await tab.evaluate('`${document.title}\\n${(document.body?.innerText ?? "").slice(0, 600)}`'));
      const botWall = BOT_WALL.test(pageHead);
      const passed = !botWall && scenario.passes(new URL(url));
      result = { ...result, url, passed, summary, ...(botWall && { botWall }) };
      writeFileSync(new URL(`${scenario.name}-${run}.json`, outDir), JSON.stringify({ summary, trace: task.trace }, null, 1));
      if (!passed) {
        // What the model saw at the end, for diagnosing a failure.
        const page = await tab.observe();
        const jpeg = await tab.markedScreenshot(buildActionSpace(page.actions).marks, page);
        writeFileSync(new URL(`${scenario.name}-${run}.jpg`, outDir), Buffer.from(jpeg, 'base64'));
      }
    } catch (error) {
      result.error = (error as Error).message;
    } finally {
      await chrome.close();
    }
    results.push(result);
    const s = result.summary;
    process.stdout.write(
      `${result.passed ? '✔' : result.botWall ? '⊘ bot wall' : '✘'} ${scenario.name} #${run} — ${result.error ?? `${s?.status} in ${s?.elapsed_ms}ms · ${s?.steps?.length} actions · ${s?.jev?.requests} requests · ${s?.jev?.screenshots} screenshots${result.passed ? '' : ` · ${s?.reason} · ${result.url}`}`}\n`,
    );
  }
}

// Pass rate and medians per scenario.
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const table = [...new Set(results.map((r) => r.scenario))].map((name) => {
  const rows = results.filter((r) => r.scenario === name);
  return {
    scenario: name,
    passed: `${rows.filter((r) => r.passed).length}/${rows.length}`,
    bot_walls: rows.filter((r) => r.botWall).length,
    median_ms: median(rows.flatMap((r) => (r.summary?.elapsed_ms ? [r.summary.elapsed_ms] : []))),
    median_requests: median(rows.flatMap((r) => (r.summary?.jev ? [r.summary.jev.requests] : []))),
    median_request_ms: median(rows.flatMap((r) => (r.summary?.jev ? [r.summary.jev.median_latency_ms] : []))),
    screenshots: rows.reduce((sum, r) => sum + (r.summary?.jev?.screenshots ?? 0), 0),
  };
});
writeFileSync(new URL('report.json', outDir), JSON.stringify({ profile: profile.name, screenshots, table, results }, null, 1));
console.table(table);
const passed = results.filter((r) => r.passed).length;
const walled = results.filter((r) => r.botWall).length;
process.stdout.write(
  `${passed}/${results.length - walled} runs passed (${walled} hit a bot wall and don't count) · ${outDir.pathname}\n`,
);
process.exitCode = passed === results.length - walled ? 0 : 1;
