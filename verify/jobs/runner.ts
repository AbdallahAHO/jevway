/**
 * The shared jobs runner: runs each job in a fresh tab of a real app, recorded (video + described steps), and judges
 * it from the final URL and page text, never from the task's own status. Writes `results.json` and `report.html`
 * under `verify/out/<name>-<timestamp>/` and opens the report on macOS. If the browser connection drops it reconnects
 * for the next run; a suite that has to stop early still writes both, with the runs it never got to marked as not run.
 *
 * Write suites (jobs that change the app's state) pass `reset` to put the app back in its seeded state before every
 * run, give a job an async `passes` that reads the app's own state (e.g. its API), and set `expect` on jobs that must
 * end in a hand-back (a destructive job expects `needs_confirmation`) instead of `done`.
 *
 * Two-call jobs give a `followUp`: after the first call it reads the page's table and URL (or any other system, e.g. a
 * mailbox) and returns the second call's goal and values. It may also set `navigate` (a URL to open first, like a link
 * from an email) and `prepare` (a fixed script on the tab, like typing a password, which jev-browse never does). A job
 * sets `confirms` (and a follow-up its own) to the label of the irreversible click the user's request names, e.g.
 * `/register/i`: the runner confirms each distinct click that matches once (up to 3 per call) and hands back any
 * other, like a calling agent that asks the user about everything the request did not name. It passes the job's
 * `confirmTarget`, the words of that request which name what the click acts on, as `confirm_target`.
 *
 * Env knobs, with NAME the uppercased `name`: `JEV_<NAME>_RUNS` (default 3), `JEV_<NAME>_ONLY` (comma-separated job
 * ids), `JEV_<NAME>_DEVICE` (a key of DEVICES, default desktop) and `JEV_<NAME>_PHRASING` (`as-written` or `terse`).
 *
 * @example
 * await runJobs({
 *   name: 'grafana',
 *   title: (count) => `Grafana play: ${count} jobs with jev-browse`,
 *   startUrl: 'https://play.grafana.org/',
 *   browser: process.env.JEV_GRAFANA_BROWSER ?? 'launch-headless',
 *   jobs: JOBS,
 * });
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connectChrome, type BrowserSource } from '../../src/browser/chrome.ts';
import { DEVICES, type DeviceName } from '../../src/browser/devices.ts';
import { Tab } from '../../src/browser/tab.ts';
import { createAsk, profileOptions, resolveModel } from '../../src/jev/model.ts';
import { shownValues } from '../../src/jev/secrets.ts';
import { BrowserTask, type TaskSummary } from '../../src/task/run-task.ts';
import { goalFor, isFlaky, renderReport, wilson, type Confirmation, type Job, type JobResult, type Phrasing } from './report.ts';

// The first table on the page as rows keyed by header text: what a calling agent reads with chrome-devtools.
const readTable = async (tab: Tab): Promise<Record<string, string>[]> =>
  tab.evaluate(`(() => {
    const table = document.querySelector('table');
    if (!table) return [];
    const headers = [...table.querySelectorAll('thead th')].map((th) => th.innerText.split('\\n')[0].trim());
    return [...table.querySelectorAll('tbody tr')].map((tr) =>
      Object.fromEntries([...tr.children].map((td, i) => [headers[i] ?? String(i), td.innerText.trim()])));
  })()`);

// A list's rows can arrive after the first call reports the list.
const FOLLOW_UP_WAIT_MS = 5_000;
const FOLLOW_UP_POLL_MS = 250;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A calling agent's second call: the job's follow-up from the table and the page's URL, polled only when the first call ended on the list.
const readFollowUp = async (tab: Tab, followUp: NonNullable<Job['followUp']>, firstCallDone: boolean) => {
  const deadline = Date.now() + (firstCallDone ? FOLLOW_UP_WAIT_MS : 0);
  for (;;) {
    const rows = await readTable(tab);
    const next = await followUp(rows, { url: new URL(String(await tab.evaluate('location.href'))) });
    if (next || Date.now() >= deadline) return { next, rows };
    await sleep(FOLLOW_UP_POLL_MS);
  }
};

// What a run keeps of the table when no row matched: the first rows, each value cut short (rows can hold long text).
const ROWS_KEPT = 10;
const VALUE_CHARS_KEPT = 120;
const sampleRows = (rows: Record<string, string>[]) =>
  rows.slice(0, ROWS_KEPT).map((row) => Object.fromEntries(Object.entries(row).map(([header, value]) => [header, value.slice(0, VALUE_CHARS_KEPT)])));

// `Clicking "<label>" on "<page title>" looks irreversible (risk …)`: the reason of a needs_confirmation hand-back. The page
// title follows the label (and is left out when the page has none), so the label is read up to its own closing quote.
const CONFIRMATION_LABEL = /^Clicking "(.*?)"(?: on ".*?")? looks irreversible/;
const confirmationLabel = ({ status, reason }: TaskSummary) =>
  status === 'needs_confirmation' ? CONFIRMATION_LABEL.exec(reason)?.[1] : undefined;

// The most clicks one call confirms: a call that keeps asking for more is not covered by what the user's request named.
const MAX_CONFIRMATIONS_PER_CALL = 3;

// One call of a calling agent. A needs_confirmation on a click the user's request names (`confirms` matches its label)
// continues with `confirm_irreversible` and `confirm_target` (the skill's rule: one confirmation per click), so the call can show several
// summaries. Each distinct label is confirmed once, and at most MAX_CONFIRMATIONS_PER_CALL in all: the same click asked
// for again is a retry of something that did not work (a submit the page rejected), which the request did not name, and
// a click that does not match ends the call there too. Each hand-back goes into `confirmations`, confirmed or not.
const runCall = async (task: BrowserTask, { confirms, confirmTarget }: Pick<Job, 'confirms' | 'confirmTarget'>, confirmations: Confirmation[]) => {
  const summaries = [await task.run()];
  const confirmed = new Set<string>();
  for (;;) {
    const label = confirmationLabel(summaries.at(-1)!);
    if (!confirms || label === undefined) return summaries;
    const given = confirms.test(label) && !confirmed.has(label) && confirmed.size < MAX_CONFIRMATIONS_PER_CALL;
    confirmations.push({ label, given });
    if (!given) return summaries;
    confirmed.add(label);
    task.update({ confirmIrreversible: true, confirmTarget });
    summaries.push(await task.run());
  }
};

// A dropped DevTools connection is replaced between runs; past this many replacements the suite stops.
const MAX_RECONNECTS = 3;
const CONNECTION_CLOSED = 'Browser connection closed';

export interface RunJobsOptions {
  /** Names the env knobs and the output folder: `grafana` reads `JEV_GRAFANA_RUNS` and writes `verify/out/grafana-…/`. */
  name: string;
  /** The report heading, given how many jobs were selected. */
  title: (jobCount: number) => string;
  startUrl: string;
  browser: BrowserSource;
  jobs: Job[];
  /** Runs on each fresh tab before the task starts, given the job about to run. A throw aborts the whole suite, not only that run. */
  before?: (tab: Tab, job: Job) => Promise<void>;
  /** Puts the app back in its seeded state before each run (write suites). A throw aborts the whole suite, like `before`. */
  reset?: (job: Job, run: number) => Promise<void>;
}

export const runJobs = async ({ name, title, startUrl, browser, jobs, before, reset }: RunJobsOptions) => {
  const knob = (suffix: string) => `JEV_${name.toUpperCase()}_${suffix}`;
  const { profile, screenshots } = resolveModel();
  const ask = createAsk(profile);
  const runs = Number(process.env[knob('RUNS')] ?? 3);
  const only = process.env[knob('ONLY')]?.split(',');
  const deviceName = process.env[knob('DEVICE')] ?? 'desktop';
  if (!Object.hasOwn(DEVICES, deviceName)) {
    throw new Error(`Unknown ${knob('DEVICE')} "${deviceName}": use one of ${Object.keys(DEVICES).join(', ')}.`);
  }
  const device = DEVICES[deviceName as DeviceName];
  const phrasing = (process.env[knob('PHRASING')] ?? 'as-written') as Phrasing;
  if (phrasing !== 'as-written' && phrasing !== 'terse') {
    throw new Error(`Unknown ${knob('PHRASING')} "${phrasing}": use as-written or terse.`);
  }
  // Terse phrasing only covers the jobs that have a terseGoal.
  const selectedJobs = jobs.filter((j) => (!only || only.includes(j.id)) && (phrasing === 'as-written' || j.terseGoal));
  const outDir = new URL(`../out/${name}-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`model: ${profile.name} (${profile.model}) · screenshots: ${screenshots} · ${runs} runs each · device ${device.name} · phrasing ${phrasing} · ${browser}\n`);

  let chrome = await connectChrome(browser);
  let reconnects = 0;
  let connectionLost = false;
  let stoppedBecause: string | undefined;
  const results: JobResult[] = [];
  try {
    suite: for (const job of selectedJobs) {
      const result: JobResult = { job, runs: [] };
      results.push(result);
      for (let run = 1; run <= runs; run++) {
        if (connectionLost || chrome.cdp.closed) {
          const closed = chrome.cdp.closed;
          if (reconnects === MAX_RECONNECTS) {
            stoppedBecause = `the browser connection closed again after ${MAX_RECONNECTS} reconnects`;
            break suite;
          }
          reconnects++;
          process.stdout.write(
            `↻ browser connection closed${closed ? ` (code ${closed.code}${closed.reason ? `: ${closed.reason}` : ''})` : ''}, reconnecting (${reconnects}/${MAX_RECONNECTS})\n`,
          );
          try {
            await chrome.close().catch(() => undefined);
            chrome = await connectChrome(browser);
            connectionLost = false;
          } catch (error) {
            stoppedBecause = `cannot reconnect to the browser: ${(error as Error).message}`;
            break suite;
          }
        }
        const dir = `${job.id}/run-${run}/`;
        let tab: Tab | undefined;
        let ready = false;
        try {
          await reset?.(job, run).catch((error: Error) => {
            throw new Error(`reset failed: ${error.message}`);
          });
          tab = await Tab.open(chrome.cdp, startUrl, { device });
          // Each run starts clean: apps remember date ranges and views in storage, which leaked one run's choices into
          // the next. Cleared from inside the page because the browser-level Storage.clearDataForOrigin fails with
          // "Internal error" on launched headless Chrome. Login cookies stay.
          await tab.evaluate('localStorage.clear(); sessionStorage.clear()');
          await tab.navigate(startUrl);
          await before?.(tab, job);
          ready = true;
          const task = new BrowserTask(tab, ask, {
            ...profileOptions(profile),
            goal: goalFor(job, phrasing),
            values: job.values,
            secretKeys: job.secretKeys,
            doneWhen: job.firstDoneWhen ?? job.doneWhen,
            maxSteps: 20,
            screenshots,
            recordDir: new URL(dir, outDir).pathname,
          });
          const confirmations: Confirmation[] = [];
          const summaries = await runCall(task, job, confirmations);
          // Two-call jobs: like a calling agent, read what the first call left behind (the page's table, a mailbox) and continue the same session.
          const firstCallDone = summaries.at(-1)!.status === 'done';
          const { next, rows } = (job.followUp && (await readFollowUp(tab, job.followUp, firstCallDone))) || {};
          const followUpMissing = Boolean(job.followUp && firstCallDone && !next);
          if (next) {
            // `navigate` and `prepare` are the harness's part of the second call, not task options.
            const { navigate, prepare, confirms, confirmTarget, ...patch } = next;
            if (navigate) await tab.navigate(navigate);
            await prepare?.(tab);
            task.update({ ...patch, doneWhen: job.doneWhen });
            summaries.push(...(await runCall(task, { confirms, confirmTarget }, confirmations)));
          }
          const summary = summaries.at(-1)!;
          // Ground truth comes from a separate read of the page, not from the task's summary.
          const url = new URL(String(await tab.evaluate('location.href')));
          const text = String(await tab.evaluate('document.body?.innerText ?? ""'));
          const reached = await job.passes(url, text, summaries);
          // A pass needs both: the check holds and the run ended with an expected status (default done). Holding with another status is only "reached".
          const passed = reached && (job.expect ?? ['done']).includes(summary.status);
          writeFileSync(new URL(`${dir}trace.json`, outDir), JSON.stringify(task.trace, null, 1));
          result.runs.push({ run, dir, passed, reached, url: url.href, summaries, ...(next && { followUp: next.values }), ...(confirmations.length && { confirmations }), ...(followUpMissing && { followUpMissing, rowsRead: sampleRows(rows ?? []) }) });
          const whyNot = followUpMissing ? `no matching row for the second call (read ${rows?.length} rows)` : summary.reason;
          process.stdout.write(
            `${passed ? '✔' : reached ? '◐' : '✘'} ${job.id} #${run} — ${summaries.map((s) => s.status).join(' → ')} in ${summaries.reduce((t, s) => t + s.elapsed_ms, 0)}ms · ${summaries.reduce((t, s) => t + s.steps.length, 0)} actions · ${summaries.reduce((t, s) => t + s.jev.requests, 0)} requests${confirmations.map((c) => ` · ${c.given ? 'confirmed' : 'handed back'} "${c.label}"`).join('')}${passed ? '' : ` · ${whyNot} · ${url.href}`}\n`,
          );
        } catch (error) {
          const { message } = error as Error;
          result.runs.push({ run, dir, passed: false, reached: false, url: '', summaries: [], error: message });
          process.stdout.write(`✘ ${job.id} #${run} — ${message}\n`);
          if (message.includes(CONNECTION_CLOSED)) connectionLost = true;
          // The app isn't usable (e.g. not signed in): every later run would fail the same way.
          else if (!ready) {
            stoppedBecause = `${job.id} #${run} could not get ready (${message})`;
            break suite;
          }
        } finally {
          await tab?.close().catch(() => undefined);
        }
      }
    }
  } finally {
    await chrome.close();
  }

  if (stoppedBecause) {
    // Runs the suite never got to still count against the pass rate, and show in the report as not run.
    for (const job of selectedJobs) {
      let result = results.find((r) => r.job === job);
      if (!result) results.push((result = { job, runs: [] }));
      for (let run = result.runs.length + 1; run <= runs; run++) {
        result.runs.push({ run, dir: `${job.id}/run-${run}/`, passed: false, reached: false, url: '', summaries: [], error: 'not run (suite stopped)' });
      }
    }
    process.stdout.write(`suite stopped early: ${stoppedBecause}\n`);
  }

  const report = new URL('report.html', outDir);
  const readSteps = (dir: string) => {
    try {
      return JSON.parse(readFileSync(new URL(`${dir}summary.json`, outDir), 'utf8'));
    } catch {
      return undefined;
    }
  };
  writeFileSync(
    report,
    renderReport({ title: title(results.length), results, model: `${profile.name} (${profile.model})`, screenshots, device: device.name, phrasing, readRecording: readSteps }),
  );
  // A value the job marks secret is written as the marker, as jev-browse itself would show it.
  const written = results.map((result) => ({ ...result, job: { ...result.job, values: result.job.values && shownValues(result.job.values, result.job.secretKeys) } }));
  writeFileSync(new URL('results.json', outDir), JSON.stringify({ device: device.name, phrasing, runsPerJob: runs, results: written }, null, 1));
  const passed = results.flatMap((r) => r.runs).filter((r) => r.passed).length;
  const total = results.flatMap((r) => r.runs).length;
  const { low, high } = wilson(passed, total);
  const flakyJobs = results.filter((r) => isFlaky(r.runs)).map((r) => r.job.id);
  process.stdout.write(`95% CI ${(low * 100).toFixed(1)}–${(high * 100).toFixed(1)}% · flaky: ${flakyJobs.join(', ') || 'none'}\n`);
  process.stdout.write(`${passed}/${total} runs passed · ${report.pathname}\n`);
  if (process.platform === 'darwin' && !process.env.CI) execFile('open', [report.pathname]);
  process.exitCode = passed === total && !stoppedBecause ? 0 : 1;
};
