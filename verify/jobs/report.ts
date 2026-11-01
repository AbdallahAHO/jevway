// The jobs report: one self-contained page next to the run folders it links to.
import type { Tab } from '../../src/browser/tab.ts';
import { shownValues } from '../../src/jev/secrets.ts';
import { escapeHtml as escape, type RecordedStep } from '../../src/task/recording.ts';
import type { TaskStatus, TaskSummary } from '../../src/task/run-task.ts';

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
  /** A fixed harness script run on the tab after `navigate`, before the second call: what the calling agent's own browser tool does (e.g. types a password, which jev-browse never does). */
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
  /** Ground truth from the final page or the app's own state (e.g. its API), never the task's own status. `summaries` are the run's calls, for a check on what jev-browse did (e.g. a value it must not have typed). */
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
export const goalFor = (job: Job, phrasing: Phrasing) => (phrasing === 'terse' && job.terseGoal) || job.goal;

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

interface Recording {
  video: string | null;
  steps: RecordedStep[];
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

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const elapsed = (r: RunResult) => r.summaries.reduce((t, s) => t + s.elapsed_ms, 0);
const requests = (r: RunResult) => r.summaries.reduce((t, s) => t + s.jev.requests, 0);
const actions = (r: RunResult) => r.summaries.reduce((t, s) => t + s.steps.length, 0);
const statuses = (r: RunResult) => r.summaries.map((s) => s.status).join(' → ');
const verdict = (r: RunResult) => (r.passed ? 'pass' : r.reached ? 'some' : 'fail');

const noRowForSecondCall = 'The first call ended done but the table had no row to continue with, so the second call never ran.';

const runChip = (r: RunResult) => {
  // A run that needed no action started on a page that already met the goal (state saved by an earlier run).
  const already = r.summaries.length && actions(r) === 0 ? ' · already met at start' : '';
  const detail = r.summaries.length ? `${statuses(r)} · ${seconds(elapsed(r))} · ${requests(r)} req${already}` : 'error';
  const mark = r.passed ? '✔' : r.reached ? '◐' : '✘';
  return `<a class="chip ${verdict(r)}" href="${r.dir}index.html" title="${escape(r.followUpMissing ? noRowForSecondCall : (r.summaries.at(-1)?.reason ?? r.error ?? ''))}">${mark} Run ${r.run} · ${detail}</a>`;
};

const stepList = (featured: RunResult, recording: Recording, videoId: string) =>
  recording.steps
    .map(
      (s, i) => `<li${recording.video && s.video_at !== undefined ? ` data-video="${videoId}" data-at="${s.video_at}"` : ''}>
  <a class="thumb" href="${featured.dir}${s.file}"><img src="${featured.dir}${s.file}" loading="lazy" alt=""></a>
  <div><span class="n">${i + 1}</span>${escape(s.description)}${s.unreachable ? ` <span class="miss">✘ not reached${(s.attempts ?? 1) > 1 ? ` ×${s.attempts}` : ''}: covered</span>` : ''}
  <div class="meta">${s.confidence !== undefined ? `confidence ${s.confidence.toFixed(2)} · ` : ''}${recording.video && s.video_at !== undefined ? `▶ ${s.video_at.toFixed(1)} s · ` : ''}<span class="url">${escape(new URL(s.url).pathname + new URL(s.url).search)}</span></div></div>
</li>`,
    )
    .join('\n');

const jobSection = (
  { job, runs }: JobResult,
  readRecording: (dir: string) => Recording | undefined,
  index: number,
  phrasing: Phrasing,
) => {
  const passed = runs.filter((r) => r.passed).length;
  // Show a passing run when there is one; otherwise the first, so the failure is visible.
  const featured = runs.find((r) => r.passed) ?? runs[0];
  const recording = featured && readRecording(featured.dir);
  const videoId = `video-${job.id}`;
  const failures = runs
    .filter((r) => !r.passed)
    .map((r) => {
      const last = r.summaries.at(-1);
      const why =
        r.error ??
        (r.followUpMissing
          ? noRowForSecondCall
          : r.reached
            ? `reached the right page, but Jev reported ${last?.status}: ${last?.reason}`
            : `${last?.status}: ${last?.reason}`);
      return `<li class="${verdict(r)}">Run ${r.run}: ${escape(why)}${r.url ? ` <span class="url">${escape(r.url)}</span>` : ''}</li>`;
    })
    .join('');
  const followUp = featured?.followUp;
  return `<section id="${job.id}">
<header><h2><span class="idx">${index + 1}</span>${escape(job.title)}</h2><span class="score ${passed === runs.length ? 'pass' : passed ? 'some' : 'fail'}">${passed}/${runs.length} <small>· ${interval(passed, runs.length)}${isFlaky(runs) ? ' · flaky' : ''}</small></span></header>
<p class="jtbd">${escape(job.job)}</p>
<dl>
  <dt>Goal given to Jev</dt><dd>${escape(goalFor(job, phrasing))}</dd>
  ${job.values ? `<dt>Values</dt><dd><code>${escape(JSON.stringify(shownValues(job.values, job.secretKeys)))}</code></dd>` : ''}
  <dt>Done when</dt><dd>${escape(job.doneWhen)}</dd>
  ${job.confirms ? `<dt>Confirmation</dt><dd>The calling agent confirms only the click the user asked for: <code>${escape(String(job.confirms))}</code>${job.confirmTarget ? ` for <code>${escape(job.confirmTarget)}</code>` : ''}${featured?.confirmations?.length ? `. Run ${featured.run}: ${featured.confirmations.map((c) => `${c.given ? 'confirmed' : 'handed back'} <code>${escape(c.label)}</code>`).join(', ')}` : ''}.</dd>` : ''}
  ${job.followUp ? `<dt>Second call</dt><dd>The calling agent reads what the first call left behind (a table, a mailbox) and continues the same session${followUp ? ` with <code>${escape(JSON.stringify(followUp))}</code>` : ''}.</dd>` : ''}
  <dt>Checked by</dt><dd>${job.expect ? `Pass: ends ${escape(job.expect.join(' or '))}, and the check holds: ` : ''}${escape(job.check)}</dd>
</dl>
<div class="chips">${runs.map(runChip).join('')}</div>
${failures ? `<ul class="failures">${failures}</ul>` : ''}
${
  recording
    ? `<h3>Run ${featured.run}, step by step</h3>
${recording.video ? `<video id="${videoId}" src="${featured.dir}${recording.video}" controls muted playsinline preload="metadata"></video>` : ''}
<ol class="steps">${stepList(featured, recording, videoId)}</ol>`
    : ''
}
</section>`;
};

/**
 * The whole report: totals, a table of jobs, then each job's statement, goal, check, runs, and its featured
 * run as a video with a described, clickable step list.
 */
export const renderReport = ({
  title,
  results,
  model,
  screenshots,
  device,
  phrasing,
  readRecording,
}: {
  /** The page title and heading, e.g. "Langfuse demo: 16 jobs with jev-browse". */
  title: string;
  results: JobResult[];
  model: string;
  screenshots: string;
  device: string;
  phrasing: Phrasing;
  readRecording: (dir: string) => Recording | undefined;
}) => {
  const runs = results.flatMap((r) => r.runs);
  const passed = runs.filter((r) => r.passed).length;
  const summaries = runs.flatMap((r) => r.summaries);
  const flaky = results.filter((r) => isFlaky(r.runs)).length;
  const rows = results
    .map(({ job, runs }) => {
      const ran = runs.filter((r) => r.summaries.length);
      const ok = runs.filter((r) => r.passed).length;
      const reached = runs.filter((r) => r.reached && !r.passed).length;
      return `<tr><td><a href="#${job.id}">${escape(job.title)}</a></td><td class="${ok === runs.length ? 'pass' : ok ? 'some' : 'fail'}">${ok}/${runs.length}${reached ? ` <small>(+${reached} reached)</small>` : ''}</td><td>${interval(ok, runs.length)}</td><td>${isFlaky(runs) ? '<span class="some">flaky</span>' : ''}</td><td>${seconds(median(ran.map(elapsed)))}</td><td>${median(ran.map(actions))}</td><td>${median(ran.map(requests))}</td></tr>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{--bg:#fafaf9;--card:#fff;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--pass:#15803d;--some:#b45309;--fail:#b91c1c;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0c0a09;--card:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--pass:#4ade80;--some:#fbbf24;--fail:#f87171;--accent:#a5b4fc}}
:root[data-theme="dark"]{--bg:#0c0a09;--card:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--pass:#4ade80;--some:#fbbf24;--fail:#f87171;--accent:#a5b4fc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 80px}
h1{font-size:28px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
.totals{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 24px}
.total{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:140px}
.total b{display:block;font-size:24px}.total span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:0 0 40px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500;font-size:13px}
td a{color:inherit}.pass{color:var(--pass)}.some{color:var(--some)}.fail{color:var(--fail)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin:0 0 32px}
section header{display:flex;justify-content:space-between;align-items:center;gap:12px}
h2{margin:0;font-size:20px;display:flex;align-items:center;gap:10px}
.idx{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--card);font-size:14px}
.score{font-weight:700;font-size:18px}
.jtbd{font-style:italic;color:var(--muted);margin:10px 0 16px}
dl{display:grid;grid-template-columns:150px 1fr;gap:6px 16px;margin:0 0 16px}dt{color:var(--muted);font-size:13px}dd{margin:0}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.chip{border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px;text-decoration:none}
.chip.pass{color:var(--pass)}.chip.fail{color:var(--fail)}
.failures{font-size:14px;margin:0 0 12px;padding-left:20px}.chip.some{color:var(--some)}
.miss{color:var(--fail);font-size:13px;margin-left:6px}
h3{font-size:15px;margin:20px 0 10px}
video{width:100%;border-radius:8px;background:#000;display:block;margin:0 0 16px}
.steps{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.steps li{display:grid;grid-template-columns:220px 1fr;gap:14px;align-items:start;padding:8px;border-radius:8px}
.steps li[data-at]{cursor:pointer}.steps li[data-at]:hover{background:var(--bg)}
.thumb img{width:100%;border-radius:6px;border:1px solid var(--line);display:block}
.n{font-weight:700;margin-right:8px;color:var(--accent)}
.meta{color:var(--muted);font-size:12px;margin-top:4px;overflow-wrap:anywhere}.url{font-family:ui-monospace,monospace}
@media (max-width:640px){dl{grid-template-columns:1fr}.steps li{grid-template-columns:1fr}section{padding:16px}}
</style></head><body><main>
<h1>${escape(title)}</h1>
<p class="sub">Each job starts on the app's start page. ✔ means the ground-truth check held <em>and</em> the run ended with an expected status (done, unless the job expects a hand-back); ◐ means the check held but the run ended with another status. ${escape(model)} · screenshots ${escape(screenshots)} · device ${escape(device)} · phrasing ${escape(phrasing)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
<div class="totals">
  <div class="total"><b class="${passed === runs.length ? 'pass' : 'some'}">${passed}/${runs.length}</b><span>runs passed · ${interval(passed, runs.length)}</span></div>
  <div class="total"><b class="${flaky ? 'some' : 'pass'}">${flaky}</b><span>flaky jobs (of ${results.length})</span></div>
  <div class="total"><b>${seconds(median(runs.filter((r) => r.summaries.length).map(elapsed)))}</b><span>median run time</span></div>
  <div class="total"><b>${median(runs.filter((r) => r.summaries.length).map(requests))}</b><span>median Jev requests</span></div>
  <div class="total"><b>${median(summaries.map((s) => s.jev.median_latency_ms))} ms</b><span>median request latency</span></div>
</div>
<table><thead><tr><th>Job</th><th>Passed</th><th>95% CI</th><th>Flaky</th><th>Median time</th><th>Actions</th><th>Requests</th></tr></thead><tbody>${rows}</tbody></table>
${results.map((r, i) => jobSection(r, readRecording, i, phrasing)).join('\n')}
</main>
<script>
// Clicking a step plays its job's video from that moment.
document.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  const step = event.target.closest('[data-at]');
  const video = step && document.getElementById(step.dataset.video);
  if (!video) return;
  video.currentTime = Number(step.dataset.at);
  video.play();
  video.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
</script>
</body></html>
`;
};
