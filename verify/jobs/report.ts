// The jobs report: one self-contained page next to the run folders it links to.
import { DEVICES } from '../../src/browser/devices.ts';
import type { Tab } from '../../src/browser/tab.ts';
import { scrubberFor, shownValues } from '../../src/jev/secrets.ts';
import type { RecordedStep } from '../../src/recording/recording.ts';
import { clock, dollars, escapeHtml as escape, fact, indexLabel, playerMarkup, plural, seconds, shotCard, statusWord, stripOpening, thousands, type Viewport } from '../../src/recording/recording-page.ts';
import type { TaskStatus, TaskSummary } from '../../src/task/run-task.ts';
import { ARROW, BACK_ARROW, FONT_LINK, HEAD_SCRIPT, SCRIPT, STYLE } from './report-page.ts';

/**
 * A calling agent's second call on the same session: what it asks next, from whatever the first call left behind
 * (a table, a mailbox).
 *
 * @example
 * // After sign-up the agent reads the activation mail, opens its link, types the password itself, and continues.
 * { goal: 'Finish activating the account.', values: {}, navigate: activationLink, prepare: fillPassword }
 */
export interface FollowUp {
  goal: string;
  values: Record<string, string>;
  /** A URL the calling agent opens in the same tab before the second call, as it would follow a link from an email. */
  navigate?: string;
  /** A fixed harness script run on the tab after `navigate`, before the second call: what the calling agent's own browser tool does (e.g. types a password, which jevway never does). */
  prepare?: (tab: Tab) => Promise<void>;
  /** The label of the click the second call's request names (see `Job.confirms`). */
  confirms?: RegExp;
  /** The words the second call's request uses for what that click acts on (see `Job.confirmTarget`). */
  confirmTarget?: string;
}

/** A `needs_confirmation` hand-back on a click, and whether the calling agent confirmed it (its label matched `confirms`). */
export interface Confirmation {
  label: string;
  given: boolean;
}

export interface Job {
  id: string;
  title: string;
  /** The job to be done: "When …, I want …, so I can …". */
  job: string;
  goal: string;
  /** How a busy engineer would type the goal: only the jobs that have one run under `terse` phrasing. */
  terseGoal?: string;
  values?: Record<string, string>;
  /** Keys of `values` the calling agent marks secret (`secret_keys`). */
  secretKeys?: string[];
  doneWhen: string;
  /** Two-call jobs: what the first call's success looks like (it only gets the agent to the page to read). */
  firstDoneWhen?: string;
  /** How a pass is judged, for readers of the report. */
  check: string;
  /** Ground truth from the final page or the app's own state (e.g. its API), never the task's own status. `summaries` are the run's calls, for a check on what jevway did (e.g. a value it must not have typed). */
  passes: (url: URL, text: string, summaries: TaskSummary[]) => boolean | Promise<boolean>;
  /**
   * The label of the irreversible click the user's request names, e.g. `/register/i`. A call that ends `needs_confirmation`
   * on a click whose label matches is confirmed once and continues, as the skill tells a calling agent to; any other
   * click ends the call as a hand-back, since the agent would ask the user about anything the request did not name.
   */
  confirms?: RegExp;
  /** With `confirms`: the words of the user's request that name what the click acts on, passed as `confirm_target`; the page must show them. */
  confirmTarget?: string;
  /** The statuses that count as success (default `['done']`). A destructive job expects `needs_confirmation`; a deliberately invalid request expects a hand-back. */
  expect?: TaskStatus[];
  /**
   * Two-call jobs: what the calling agent asks next, from the first table on the page (`rows`) and the page's URL after
   * the first call. May be async (e.g. to read a mailbox). Called once even when the first call did not end `done`;
   * `undefined` means there is nothing to continue with.
   */
  followUp?: (rows: Record<string, string>[], context: { url: URL }) => FollowUp | undefined | Promise<FollowUp | undefined>;
}

export type Phrasing = 'as-written' | 'terse';

/** The goal for the first call: the terse wording when asked for and the job has one. */
export const goalFor = (job: Pick<Job, 'goal' | 'terseGoal'>, phrasing: Phrasing) => (phrasing === 'terse' && job.terseGoal) || job.goal;

export interface RunResult {
  run: number;
  /** The run's recording folder, relative to the report. */
  dir: string;
  /** The ground-truth check held and the run ended with an expected status. */
  passed: boolean;
  /** The ground-truth check alone. */
  reached: boolean;
  url: string;
  /** One per `run()` call on the session: two for a follow-up job. */
  summaries: TaskSummary[];
  /** The values the calling agent passed in its second call. */
  followUp?: Record<string, string>;
  /** Jobs with `confirms`: every `needs_confirmation` click of the run, confirmed or handed back. */
  confirmations?: Confirmation[];
  /** Two-call jobs: the first call ended done but the table had no row to continue with, so the second call never ran. */
  followUpMissing?: boolean;
  /** Two-call jobs with no matching row: the first rows the table showed, to see why none matched. */
  rowsRead?: Record<string, string>[];
  error?: string;
}

export interface JobResult {
  job: Job;
  runs: RunResult[];
}

/**
 * A job as the report reads it: `Job` without its functions, so a job read back from `results.json` (where `confirms`
 * is saved as its source, e.g. "/register/i") renders the same as the live one.
 */
export type ReportJob = Omit<Job, 'passes' | 'followUp' | 'confirms'> & {
  confirms?: RegExp | string;
  /** Present (as a function) on a live two-call job; absent once saved. */
  followUp?: unknown;
};

export interface ReportResult {
  job: ReportJob;
  runs: RunResult[];
}

interface Recording {
  video: string | null;
  steps: RecordedStep[];
  /** The page size it was recorded at; absent in recordings made before it was saved. */
  viewport?: Viewport;
}

/**
 * The 95% Wilson score interval for a pass rate: how far the true reliability of a job can be from what a handful
 * of runs showed. A job that passed 9 of 10 runs could still be a 60% job; one that passed 3 of 3 could be a 44% job.
 *
 * @example
 * wilson(9, 10); // { low: 0.596, high: 0.982 }
 */
export const wilson = (passed: number, total: number) => {
  if (total === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const rate = passed / total;
  const scale = 1 + z ** 2 / total;
  const center = (rate + z ** 2 / (2 * total)) / scale;
  const margin = (z * Math.sqrt((rate * (1 - rate)) / total + z ** 2 / (4 * total ** 2))) / scale;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
};

const percent = (rate: number) => `${Math.round(rate * 100)}`;
const interval = (passed: number, total: number) => {
  const { low, high } = wilson(passed, total);
  return `95% CI ${percent(low)}–${percent(high)}%`;
};
// Flaky: it passed sometimes and failed sometimes, so a single run says little about it.
export const isFlaky = (runs: RunResult[]) => {
  const passed = runs.filter((r) => r.passed).length;
  return passed > 0 && passed < runs.length;
};

// --- numbers a reader compares

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
const counted = (n: number) => NUMBER_WORDS[n] ?? String(n);

const ran = (r: RunResult) => r.summaries.length > 0;
const elapsed = (r: RunResult) => r.summaries.reduce((t, s) => t + s.elapsed_ms, 0);
const requests = (r: RunResult) => r.summaries.reduce((t, s) => t + s.jev.requests, 0);
const inputTokens = (r: RunResult) => r.summaries.reduce((t, s) => t + s.jev.input_tokens, 0);
// Unknown (null) when any call has no estimate: a model without a price, or a summary saved before summaries carried one.
const estCost = (r: RunResult) => r.summaries.reduce<number | null>((t, s) => (t === null || s.jev.est_cost_usd == null ? null : t + s.jev.est_cost_usd), 0);
const costWords = (cost: number | null) => (cost === null ? 'est. cost unknown' : `est. ${dollars(cost)}`);
const actions = (r: RunResult) => r.summaries.reduce((t, s) => t + s.steps.length, 0);
const passCount = (runs: RunResult[]) => runs.filter((r) => r.passed).length;

// --- how a run ended, in words and marks

const NOT_RUN = 'not run (suite stopped)';
const notRun = (r: RunResult) => r.error === NOT_RUN;
/** The run's end as one word or two: its last status, or why it has none. */
const ending = (r: RunResult) => (ran(r) ? statusWord(r.summaries.at(-1)!.status) : notRun(r) ? 'not run' : 'error');
// ● the check held and the status was expected; ◐ the check held, the status was not; ○ missed (muted when never run).
const markOf = (r: RunResult) =>
  r.passed ? { mark: '●', tone: 'held', word: 'passed' } : r.reached ? { mark: '◐', tone: 'reached', word: 'check held, status not expected' } : { mark: '○', tone: notRun(r) ? 'unrun' : 'missed', word: notRun(r) ? 'not run' : 'missed' };
const mark = (r: RunResult) => {
  const { mark: symbol, tone, word } = markOf(r);
  return `<span class="${tone}" title="Run ${r.run}: ${word}">${symbol}</span>`;
};
const marks = (runs: RunResult[]) => `<span class="marks" aria-label="${passCount(runs)} of ${runs.length} runs passed">${runs.map(mark).join('')}</span>`;

const noRowForSecondCall = 'The first call ended done but the table had no row to continue with, so the second call never ran.';
/** Why a run did not pass, in one sentence. */
const whyMissed = (r: RunResult) => {
  if (notRun(r)) return 'Not run: the suite stopped before this run.';
  if (r.error) return r.error;
  if (r.followUpMissing) return noRowForSecondCall;
  const last = r.summaries.at(-1)!;
  return r.reached ? `reached the right page, but Jev reported ${statusWord(last.status)}: ${last.reason}` : `${statusWord(last.status)}: ${last.reason}`;
};

// --- what a job is

type Kind = 'Write' | 'Read' | 'Hand-back';
const kindOf = (job: ReportJob, suiteWrites: boolean): Kind => (job.expect ? 'Hand-back' : suiteWrites ? 'Write' : 'Read');
const isTwoCall = (job: ReportJob, runs: RunResult[]) => Boolean(job.followUp || job.firstDoneWhen || runs.some((r) => r.followUp || r.followUpMissing));
const confirmRule = (job: ReportJob) => (job.confirms instanceof RegExp ? String(job.confirms) : typeof job.confirms === 'string' ? job.confirms : undefined);
/** The run a reader sees first: one that passed, else one that ran, else the first. */
const featuredRun = (runs: RunResult[]) => runs.find((r) => r.passed) ?? runs.find(ran) ?? runs[0];

// --- the suite, from its title and out folder

/**
 * The hero's first sentence from a suite title like "Forgejo: 11 write jobs with jevway".
 *
 * @example
 * suiteSentence('Forgejo: 11 write jobs with jevway', 11) // 'Eleven write jobs on Forgejo.'
 */
const suiteSentence = (title: string, jobCount: number) => {
  const parts = /^(.+?):\s+(\d+)\s+(.*?)jobs?\s+with (?:jevway|jev-browse)$/.exec(title.trim());
  if (!parts) return `${title.replace(/\.$/, '')}.`;
  const [, app, count, kind] = parts;
  const n = Number(count) || jobCount;
  return `${counted(n)} ${kind}${n === 1 ? 'job' : 'jobs'} on ${app}.`;
};
// verify/out/<suite>-<ISO time with - for : and .>: the suite and when it started.
const FOLDER = /^(?:(.+)-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-\d{2}-\d{3}Z$/;
export const startedAt = (outFolder?: string) => {
  const parts = outFolder && FOLDER.exec(outFolder);
  return parts ? `started ${parts[2]} ${parts[3]}:${parts[4]} UTC` : 'time unknown';
};
const suiteName = (title: string, outFolder?: string) => {
  const parts = outFolder && FOLDER.exec(outFolder);
  return parts && parts[1] ? `verify:${parts[1]}` : title;
};

/** The suite's device as a viewport: the frame's shape for a recording that doesn't name its own (desktop is 1120×780). */
const deviceViewport = (deviceName: string): Viewport => {
  const { width, height } = Object.hasOwn(DEVICES, deviceName) ? DEVICES[deviceName as keyof typeof DEVICES] : DEVICES.desktop;
  return { width, height };
};

// --- small pieces of markup

const quoted = (text: string) => `“${escape(text)}”`;
const keyValues = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `<span class="kv">${escape(key)}</span>${escape(value)}`)
    .join('<br>');
// --- the overview

/** One figure of an overview's totals row: the number large, what it counts small under it. */
export const figure = (value: string, label: string) => `<p><span class="figure">${value}</span> <span class="meta">${label}</span></p>`;

const overviewRow = (result: ReportResult, recording: Recording | undefined, suiteWrites: boolean, featured: RunResult, device: Viewport) => {
  const { job, runs } = result;
  const passed = passCount(runs);
  const kinds = [passed === runs.length && 'held', isFlaky(runs) && 'flaky', job.expect && 'handback', passed === 0 && 'failed'].filter(Boolean).join(' ');
  const href = `#${job.id}`;
  const strip = recording?.steps.length
    ? `${stripOpening(`run ${featured.run}`, recording.viewport ?? device)}${recording.steps.map((s, i) => shotCard(s, i, featured.dir, { href: `${href}-r${featured.run}-s${i + 1}` })).join('')}</div>`
    : `<p class="small no-recording">No recording for run ${featured.run}${featured.error ? `: ${escape(featured.error)}` : '.'}</p>`;
  return `<article class="job-row" data-kinds="${kinds}">
<div class="grid4">
<p class="meta">${marks(runs)}<br>${passed}/${runs.length} · ${kindOf(job, suiteWrites)}${recording?.steps.length ? ` · ${plural(recording.steps.length, 'step')}` : ''}</p>
<h3 class="row-title c2"><a href="${escape(href)}">${escape(job.title)}</a></h3>
<p class="small c3">${escape(job.job)}</p>
<a class="action c4 end" href="${escape(href)}">Watch run ${featured.run} ${ARROW}</a>
</div>
${strip}
</article>`;
};

const METHOD = [
  ['Start', 'Each run opens a fresh tab on the app’s start page with its storage cleared; write suites first put the app back in its seeded state. Runs don’t share anything but the sign-in.'],
  ['Judge', 'A run passes when the ground-truth check holds (the final page, or the app’s own API) and the run ended with the status the job expects: done, or a hand-back for jobs that must stop. ● passed, ◐ the check held but the run ended with another status, ○ missed. Jev’s own status is never the judge.'],
  ['Record', 'Every action is shot before it runs, with its target outlined, and the whole run is a screencast. The shots are for people only and never reach the model.'],
];

const overviewView = (
  { title, results, suiteWrites, runsPerJob, device }: { title: string; results: ReportResult[]; suiteWrites: boolean; runsPerJob: string; device: Viewport },
  recordingOf: (r: RunResult) => Recording | undefined,
) => {
  const runs = results.flatMap((r) => r.runs);
  const passed = passCount(runs);
  const finished = runs.filter(ran);
  const flaky = results.filter((r) => isFlaky(r.runs)).length;
  const held = results.filter((r) => passCount(r.runs) === r.runs.length).length;
  const failed = results.filter((r) => passCount(r.runs) === 0).length;
  const handBacks = results.filter((r) => r.job.expect).length;
  const latency = median(runs.flatMap((r) => r.summaries.map((s) => s.jev.median_latency_ms)));
  const priced = finished.map(estCost).filter((cost) => cost !== null);
  const pricedOf = priced.length < finished.length ? ` of ${plural(priced.length, 'priced run')}` : '';
  const cost = priced.length
    ? figure(dollars(median(priced)), `est. cost per run, median${pricedOf} · ${dollars(priced.reduce((t, c) => t + c, 0))} total`)
    : figure('unknown', 'est. cost per run');
  const filters = [
    ['all', 'All', results.length],
    ['held', 'Every run held', held],
    ...(flaky ? [['flaky', 'Flaky', flaky]] : []),
    ...(handBacks ? [['handback', 'Hand-backs', handBacks]] : []),
    ...(failed ? [['failed', 'Failed', failed]] : []),
  ] as [string, string, number][];
  const rows = results.map((result) => {
    const featured = featuredRun(result.runs);
    return overviewRow(result, featured && recordingOf(featured), suiteWrites, featured, device);
  });
  return `<section class="view" id="overview" aria-label="Overview">
<div class="wrapper">
<div class="intro grid4"><h1 class="hero c3s2">${escape(suiteSentence(title, results.length))} ${passed} of ${plural(runs.length, 'run')} ended the way the job expects.</h1></div>
<div class="figures grid4" aria-label="Totals">
${figure(`${passed}/${runs.length}`, `runs passed · ${interval(passed, runs.length)}`)}
${figure(String(flaky), `flaky ${flaky === 1 ? 'job' : 'jobs'} of ${results.length}`)}
${figure(seconds(median(finished.map(elapsed))), `median run · ${plural(median(finished.map(requests)), 'Jev request')} per run, ${latency} ms each`)}
${cost}
</div>
<section class="section" id="jobs" aria-labelledby="jobs-title">
<div class="section-head grid4"><p class="small c2">Jobs<br>${runsPerJob}</p><h2 class="section-title c3s2" id="jobs-title">What jevway was asked to do</h2></div>
<div class="filters grid4 needs-js"><p class="meta">Show</p><div class="textlinks c2s3" role="group" aria-label="Filter jobs">${filters
    .map(([key, label, count]) => `<button type="button" data-filter="${key}" aria-pressed="${key === 'all'}">${label} <span class="num">${count}</span></button>`)
    .join('')}</div></div>
${rows.join('\n')}
</section>
<section class="section" id="method" aria-labelledby="method-title">
<div class="section-head grid4"><p class="small c2">Method<br>How a run is judged</p><h2 class="section-title c3s2" id="method-title">Ground truth, not the agent’s word</h2></div>
${METHOD.map(([label, body]) => `<div class="method-row grid4"><p class="meta">${label}</p><p class="small c2s3">${body}</p></div>`).join('\n')}
</section>
</div>
</section>`;
};

// --- one job: its runs' players first, then each run's facts

const runSwitcher = (runs: RunResult[], current: RunResult) =>
  `<div class="textlinks c1s3" role="group" aria-label="Runs">${runs
    .map((r) => `<button type="button" data-show-run="${r.run}" aria-pressed="${r === current}">Run ${r.run} ${mark(r)} ${escape(ending(r))}</button>`)
    .join('')}</div>`;

/** The video (or the first shot without one, or a quiet note without a recording), its timeline, the run switcher, the steps. */
const player = (r: RunResult, recording: Recording | undefined, runs: RunResult[], featured: boolean, device: Viewport) => {
  const steps = recording?.steps ?? [];
  const bar = `<div class="player-bar grid4">${runSwitcher(runs, r)}<span class="meta clock c4 end">${recording?.video ? clock(0) : ''}</span></div>`;
  if (!steps.length) {
    const note = notRun(r) ? 'Not run: the suite stopped before this run.' : r.error ? `This run ended in an error before it recorded anything: ${escape(r.error)}` : `No recording was found for run ${r.run}.`;
    return `<div class="screen quiet"><p class="meta">Run ${r.run}</p><p class="small">${note}</p></div>\n${bar}`;
  }
  return playerMarkup({ dir: r.dir, video: recording!.video, steps, label: `run ${r.run}`, featured, viewport: recording!.viewport ?? device, bar });
};

/** The run's facts as hairline rows: what Jev was given, how the run was judged, what it did and what it cost. */
const runFacts = (job: ReportJob, r: RunResult, runs: RunResult[], phrasing: Phrasing) => {
  const values = job.values && Object.keys(job.values).length ? keyValues(shownValues(job.values, job.secretKeys)) : 'None';
  const expected = job.expect ? `Pass: ends ${escape(job.expect.map(statusWord).join(' or '))}, and the check holds: ` : '';
  const judged = ran(r) ? (r.reached ? ' <span class="held">· held</span>' : ' <span class="missed">· missed</span>') : ' <span class="unrun">· not judged</span>';
  const rows = [
    fact('Goal given to Jev', escape(goalFor(job, phrasing))),
    fact('Values', values),
    ...(job.firstDoneWhen ? [fact('First done when', escape(job.firstDoneWhen))] : []),
    fact('Done when', escape(job.doneWhen)),
  ];
  const rule = confirmRule(job);
  if (rule || job.confirmTarget || r.confirmations?.length) {
    const asked = `The calling agent confirms only the click the user’s request names${rule ? ` (<code>${escape(rule)}</code>)` : ''}${job.confirmTarget ? `, for ${quoted(job.confirmTarget)}` : ''}.`;
    const given = r.confirmations?.length ? ` This run: ${r.confirmations.map((c) => `${c.given ? 'confirmed' : 'handed back'} ${quoted(c.label)}`).join(', ')}.` : ran(r) ? ' This run asked for none.' : '';
    rows.push(fact('Confirmation', asked + given));
  }
  if (isTwoCall(job, runs)) {
    const second = r.followUp
      ? `The calling agent read what the first call left behind and continued the same session${Object.keys(r.followUp).length ? ` with<br>${keyValues(shownValues(r.followUp, job.secretKeys))}` : ', with no new values'}.`
      : r.followUpMissing
        ? `${noRowForSecondCall}${r.rowsRead?.length ? ` Rows read:<br>${r.rowsRead.map((row) => keyValues(row).replaceAll('<br>', ' · ')).join('<br>')}` : ' The table had no rows.'}`
        : ran(r)
          ? 'Not made: the first call did not end done.'
          : 'Not made.';
    rows.push(fact('Second call', second));
  }
  rows.push(fact('Checked by', `${expected}${escape(job.check)}${judged}`));
  if (ran(r)) {
    const already = actions(r) === 0 ? ' · already met at start: no action was needed' : '';
    rows.push(fact('Calls', `${escape(r.summaries.map((s) => statusWord(s.status)).join(' → '))} · ${plural(actions(r), 'action')}${already}`));
    rows.push(fact('Final reason', escape(r.summaries.at(-1)!.reason)));
  }
  if (r.error) rows.push(fact('Error', escape(r.error)));
  if (r.url) rows.push(fact('Final address', `<span class="address">${escape(r.url)}</span>`));
  if (ran(r)) {
    const latency = median(r.summaries.map((s) => s.jev.median_latency_ms));
    rows.push(fact('Cost', `<span class="num">${plural(requests(r), 'Jev request')} · ${thousands(inputTokens(r))} input tokens · ${seconds(elapsed(r))} · ${latency} ms median request · ${costWords(estCost(r))}</span>`));
    rows.push(fact('Files', `<a href="${escape(`${r.dir}index.html`)}">${escape(r.dir)}index.html</a> · <a href="${escape(`${r.dir}summary.json`)}">summary.json</a> · <a href="${escape(`${r.dir}trace.json`)}">trace.json</a>`));
  }
  return `<dl class="facts">${rows.join('\n')}</dl>`;
};

const runPanel = (job: ReportJob, r: RunResult, recording: Recording | undefined, runs: RunResult[], featured: RunResult, { phrasing, device }: { phrasing: Phrasing; device: Viewport }) => {
  const verdict = r.passed ? 'Passed' : r.reached ? 'Check held, status not expected' : notRun(r) ? 'Not run' : 'Missed';
  const headline = ran(r) ? `${escape(ending(r))}, in ${seconds(elapsed(r))}` : escape(ending(r));
  return `<div class="run player${r === featured ? ' current' : ''}" data-run="${r.run}">
${player(r, recording, runs, r === featured, device)}
<div class="run-head grid4"><p class="small c2">Run ${r.run}<br>${verdict}</p><h2 class="section-title c3s2">${headline}</h2></div>
${runFacts(job, r, runs, phrasing)}
</div>`;
};

const jobView = (
  { job, runs }: ReportResult,
  index: number,
  next: ReportResult,
  { suiteWrites, phrasing, device }: { suiteWrites: boolean; phrasing: Phrasing; device: Viewport },
  recordingOf: (r: RunResult) => Recording | undefined,
) => {
  const passed = passCount(runs);
  const featured = featuredRun(runs);
  const finished = runs.filter(ran);
  const missed = runs.filter((r) => !r.passed);
  const medians = finished.length ? `median ${seconds(median(finished.map(elapsed)))} · ${plural(median(finished.map(actions)), 'action')} · ${plural(median(finished.map(requests)), 'request')}` : '';
  const failures = missed.length
    ? `<section class="failures" aria-label="Runs that did not pass">
<div class="section-head grid4"><p class="small c2">Failures<br>${missed.length} of ${plural(runs.length, 'run')}</p><h2 class="section-title c3s2">What went wrong</h2></div>
${missed.map((r) => `<div class="fact grid4"><p class="meta">Run ${r.run}</p><p class="c2s3">${escape(whyMissed(r))}${r.url ? ` <span class="address">${escape(r.url)}</span>` : ''}</p></div>`).join('\n')}
</section>`
    : '';
  return `<section class="view job-view" id="${escape(job.id)}" aria-labelledby="title-${escape(job.id)}">
<div class="wrapper">
<header class="job-head grid4">
<p class="meta"><a class="back" href="#jobs">${BACK_ARROW} All jobs</a><br>Job ${indexLabel(index)} · ${kindOf(job, suiteWrites)}</p>
<h1 class="job-title c2s2" id="title-${escape(job.id)}">${escape(job.title)}</h1>
<p class="meta c4 end">${marks(runs)}<br>${passed}/${runs.length} passed · ${interval(passed, runs.length)}${isFlaky(runs) ? ' · flaky' : ''}${medians ? `<br>${medians}` : ''}</p>
<p class="small story c2s2">${escape(job.job)}</p>
</header>
${runs.map((r) => runPanel(job, r, recordingOf(r), runs, featured, { phrasing, device })).join('\n')}
${failures}
<nav class="next" aria-label="Next job"><div class="next-row grid4"><p class="meta">Next job</p><a class="row-title c2s2" href="#${escape(next.job.id)}">${escape(next.job.title)}</a><a class="action c4 end" href="#${escape(next.job.id)}">Next job ${ARROW}</a></div></nav>
</div>
</section>`;
};

/**
 * The whole report as one self-contained page: an overview (the suite in a sentence, its figures, every job as a row
 * with its featured run's step shots) and one view per job, opened by `#<job id>`, that starts with the run's
 * screencast and keeps it, the timeline and the step shots in sync, then lists the run's facts. Every run of a job
 * can be switched to. Pure: the same input gives the same page (the time shown is the out folder's start time).
 *
 * @example
 * writeFileSync('report.html', renderReport({ title: 'Forgejo: 11 write jobs with jevway', results, model, screenshots,
 *   device: 'desktop', phrasing: 'as-written', readRecording, outFolder: 'forgejo-2026-11-01T15-43-33-653Z', writes: true }));
 */
export const renderReport = ({
  title,
  results: given,
  model,
  screenshots,
  device,
  phrasing,
  readRecording,
  outFolder,
  writes,
}: {
  /** The page title, e.g. "Langfuse demo: 16 jobs with jevway"; the hero's first sentence is made from it. */
  title: string;
  results: ReportResult[];
  model: string;
  screenshots: string;
  device: string;
  phrasing: Phrasing;
  readRecording: (dir: string) => Recording | undefined;
  /** The out folder's name, e.g. "forgejo-2026-11-01T15-43-33-653Z": names the suite and its start time. */
  outFolder?: string;
  /** The suite changes the app's state (it resets it before each run); a job of a suite that confirms clicks counts too. */
  writes?: boolean;
}) => {
  // A value the caller marked secret never shows, wherever a run echoed it (a reason, a step, an address).
  const results = given.map(({ job, runs }) => {
    const scrub = scrubberFor(job.values ?? {}, job.secretKeys);
    return { job: { ...scrub({ ...job, values: undefined }), values: job.values }, runs: scrub(runs), scrub };
  });
  const scrubOf = new Map(results.flatMap(({ runs, scrub }) => runs.map((r) => [r, scrub] as const)));
  const recordingOf = (r: RunResult) => {
    const recording = readRecording(r.dir);
    return recording && scrubOf.get(r)!(recording);
  };
  const suiteWrites = Boolean(writes) || results.some((r) => r.job.confirms !== undefined);
  const counts = [...new Set(results.map((r) => r.runs.length))];
  const runsPerJob = counts.length === 1 ? `${plural(counts[0], 'run')} each` : `${Math.min(...counts)}–${Math.max(...counts)} runs each`;
  const views = results.map((result, i) => jobView(result, i, results[(i + 1) % results.length], { suiteWrites, phrasing, device: deviceViewport(device) }, recordingOf));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escape(title)}</title>
<meta name="description" content="${escape(`${title}: every run judged by ground truth, recorded as video and step shots.`)}">
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link rel="stylesheet" href="${FONT_LINK}">
${HEAD_SCRIPT}
<style>${STYLE}</style>
</head><body>
<nav class="top" aria-label="Report"><div class="wrapper"><a href="#overview">jevway / ${escape(suiteName(title, outFolder))}</a><div class="links"><a href="#jobs">Jobs</a><a href="#method">Method</a></div></div></nav>
<main>
${overviewView({ title, results, suiteWrites, runsPerJob, device: deviceViewport(device) }, recordingOf)}
${views.join('\n')}
</main>
<footer><div class="wrapper"><span>${escape(model)} · screenshots ${escape(screenshots)} · ${escape(device)} · phrasing ${escape(phrasing)} · ${startedAt(outFolder)}</span><span>${outFolder ? `verify/out/${escape(outFolder)}` : 'out folder unknown'}</span></div></footer>
${SCRIPT}
</body></html>
`;
};
