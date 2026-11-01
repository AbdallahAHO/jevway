import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderReport, wilson, type JobResult, type RunResult } from '../verify/jobs/report.ts';
import { reportFromResults } from '../verify/jobs/rerender.ts';
import type { RecordedStep } from '../src/task/recording.ts';
import type { TaskStatus, TaskSummary } from '../src/task/run-task.ts';

// --- fixtures: a suite as the runner hands it over, and the recordings its run folders hold

const summary = (status: TaskStatus, reason: string, actions: number, over: Partial<TaskSummary> = {}): TaskSummary => ({
  status,
  reason,
  url: 'http://app.test/ada/app',
  title: 'App',
  page_text: '',
  elapsed_ms: 2000,
  steps: Array.from({ length: actions }, () => ({ operation: 'CLICK', confidence: 0.9 })) as unknown as TaskSummary['steps'],
  jev: { requests: 4, input_tokens: 40_000, median_latency_ms: 350, screenshots: 0, model: 'jev-1.14.0', est_cost_usd: 0.00168 },
  ...over,
});
// A call saved before summaries carried a cost (an old out folder): no model, no est_cost_usd.
const oldSummary = (status: TaskStatus, reason: string) =>
  summary(status, reason, 1, { jev: { requests: 4, input_tokens: 40_000, median_latency_ms: 350, screenshots: 0 } as TaskSummary['jev'] });

const step = (n: number, operation: string, description: string, video_at?: number, over: Partial<RecordedStep> = {}): RecordedStep => ({
  file: `${String(n).padStart(2, '0')}.jpg`,
  operation,
  description,
  confidence: 0.9,
  url: 'http://app.test/ada/app/issues/new',
  at: 1000 + n,
  ...(video_at !== undefined && { video_at }),
  ...over,
});

const run = (n: number, jobId: string, over: Partial<RunResult> = {}): RunResult => ({
  run: n,
  dir: `${jobId}/run-${n}/`,
  passed: true,
  reached: true,
  url: 'http://app.test/ada/app/issues/4',
  summaries: [summary('done', 'Completion condition verified.', 3)],
  ...over,
});

const job = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  job: `When I need ${title.toLowerCase()}, I want it done, so I can move on.`,
  goal: `Do: ${title}.`,
  doneWhen: `${title} is done.`,
  check: `The app's API shows ${title.toLowerCase()}`,
  passes: () => true,
  ...over,
});

const SECRET = 'hunter2-very-secret';

// Steps of a confirmed write: four actions, a needs_confirmation hand-back, the confirmed click, the end.
const writeSteps = [
  step(1, 'CLICK', 'Click "New issue"', 0.48),
  step(2, 'TYPE_TEXT', 'Type the "title" value into "Title"', 0.91),
  step(3, 'CLICK', 'Click "Labels"', 1.58),
  step(4, 'needs_confirmation', 'Finished: needs_confirmation. Clicking "Create issue" looks irreversible (risk 0.82).', 2.66),
  step(5, 'CLICK', 'Click "Create issue"', 3.14),
  step(6, 'done', 'Finished: done. Completion condition verified.', 6.76),
];

const RECORDINGS: Record<string, { video: string | null; steps: RecordedStep[] }> = {
  'new-issue/run-1/': { video: 'run.mp4', steps: writeSteps },
  'new-issue/run-2/': { video: 'run.mp4', steps: writeSteps },
  'flaky/run-1/': { video: 'run.mp4', steps: [step(1, 'CLICK', 'Click "Settings"', 0.5), step(2, 'done', 'Finished: done. Verified.', 1.9)] },
  'flaky/run-2/': {
    video: 'run.mp4',
    steps: [
      step(1, 'CLICK', 'Click "Save rule"', 0.4, { unreachable: true, attempts: 2 }),
      step(2, 'blocked', 'Finished: blocked. "Save rule" could not be reached 3 times.', 2.2),
    ],
  },
  'flaky/run-3/': { video: 'run.mp4', steps: [step(1, 'CLICK', 'Click "Settings"', 0.5), step(2, 'done', 'Finished: done. Verified.', 1.9)] },
  'reached/run-1/': { video: 'run.mp4', steps: [step(1, 'CLICK', 'Click "Wiki"', 0.3), step(2, 'blocked', 'Finished: blocked. Stuck.', 1.2)] },
  'no-video/run-1/': { video: null, steps: [step(1, 'CLICK', 'Click "Labels"'), step(2, 'done', 'Finished: done. Verified.')] },
  'already/run-1/': { video: 'run.mp4', steps: [step(1, 'done', 'Finished: done. Already met.', 0)] },
  'sign-up/run-1/': {
    video: 'run.mp4',
    steps: [
      step(1, 'TYPE_TEXT', `Type the "username" value into "Username" (${SECRET} echoed)`, 0.4),
      step(2, 'done', 'Finished: done. Check your email.', 1.5),
      step(3, 'CLICK', 'Click "Save"', 2.4),
      step(4, 'done', 'Finished: done. Profile updated.', 4.1),
    ],
  },
  'sign-up/run-2/': { video: 'run.mp4', steps: [step(1, 'done', 'Finished: done. Check your email.', 0.2)] },
  'escape/run-1/': { video: 'run.mp4', steps: [step(1, 'CLICK', 'Click "<b>bold</b>"', 0.2), step(2, 'blocked', 'Finished: blocked. <script>alert(1)</script>', 1)] },
};
const readRecording = (dir: string) => RECORDINGS[dir];

const RESULTS: JobResult[] = [
  {
    job: job('new-issue', 'Open a labelled issue', {
      values: { title: 'Crash on save', label: 'bug' },
      confirms: /create issue/i,
      confirmTarget: 'Crash on save',
    }),
    runs: [
      run(1, 'new-issue', {
        summaries: [summary('needs_confirmation', 'Clicking "Create issue" looks irreversible.', 3), summary('done', 'Completion condition verified.', 1)],
        confirmations: [{ label: 'Create issue', given: true }],
      }),
      run(2, 'new-issue', {
        summaries: [summary('needs_confirmation', 'Clicking "Create issue" looks irreversible.', 3), summary('done', 'Completion condition verified.', 1)],
        confirmations: [{ label: 'Create issue', given: true }],
      }),
    ],
  },
  {
    job: job('flaky', 'Protect the main branch', { values: { branch: 'main' } }),
    runs: [
      run(1, 'flaky'),
      run(2, 'flaky', {
        passed: false,
        reached: false,
        url: 'http://app.test/ada/app/settings/branches',
        summaries: [summary('blocked', '"Save rule" could not be reached 3 times: something on the page covers it', 1)],
      }),
      run(3, 'flaky'),
    ],
  },
  {
    job: job('reached', 'Turn the wiki off'),
    runs: [run(1, 'reached', { passed: false, reached: true, summaries: [summary('blocked', 'Stuck on the settings page.', 1)] })],
  },
  {
    job: job('errored', 'Close an issue'),
    runs: [
      run(1, 'errored', { passed: false, reached: false, url: '', summaries: [], error: 'Browser connection closed (code 1006)' }),
      run(2, 'errored', { passed: false, reached: false, url: '', summaries: [], error: 'not run (suite stopped)' }),
    ],
  },
  { job: job('no-video', 'Add a label'), runs: [run(1, 'no-video')] },
  { job: job('already', 'Already starred'), runs: [run(1, 'already', { summaries: [summary('done', 'Already met.', 0)] })] },
  {
    job: job('delete-repo', 'Hand back a repository deletion', { expect: ['needs_confirmation'] }),
    runs: [run(1, 'delete-repo', { summaries: [summary('needs_confirmation', 'Clicking "Delete" looks irreversible.', 2)] })],
  },
  {
    job: job('sign-up', 'Sign up and set the full name', {
      values: { username: 'signup-1', password: SECRET },
      secretKeys: ['password'],
      firstDoneWhen: 'The page says to check your email.',
      followUp: () => undefined,
      confirms: /register/i,
    }),
    runs: [
      run(1, 'sign-up', {
        summaries: [summary('done', 'Check your email.', 1), summary('done', `Profile updated for ${SECRET}.`, 1)],
        followUp: { full_name: 'Grace Hopper', password: SECRET },
        confirmations: [
          { label: 'Register account', given: true },
          { label: 'Delete account', given: false },
        ],
      }),
      run(2, 'sign-up', {
        passed: false,
        reached: false,
        summaries: [summary('done', 'Check your email.', 0)],
        followUpMissing: true,
        rowsRead: [{ Name: 'ada', Email: 'ada@example.test' }],
      }),
    ],
  },
  {
    job: job('escape', 'Quote "this" & <script>alert("title")</script>'),
    runs: [
      run(1, 'escape', {
        passed: false,
        reached: false,
        url: 'http://app.test/?q="><script>alert(2)</script>',
        summaries: [summary('blocked', `It said <script>alert('reason')</script> and "quoted" things`, 1)],
      }),
    ],
  },
];

const render = (over: Partial<Parameters<typeof renderReport>[0]> = {}) =>
  renderReport({
    title: 'Forgejo: 9 write jobs with jev-browse',
    results: RESULTS,
    model: 'jev (jev-1.14.0)',
    screenshots: 'never',
    device: 'desktop',
    phrasing: 'as-written',
    readRecording,
    outFolder: 'forgejo-2026-11-01T15-43-33-653Z',
    writes: true,
    ...over,
  });

const html = render();
const ALL_RUNS = RESULTS.flatMap((r) => r.runs);
const PASSED = ALL_RUNS.filter((r) => r.passed).length;

// The HTML of one job's view: from its section to the next view.
const viewOf = (page: string, id: string) => {
  const start = page.indexOf(`<section class="view job-view" id="${id}"`);
  expect(start, `a view for ${id}`).toBeGreaterThan(-1);
  const next = page.indexOf('<section class="view', start + 1);
  return page.slice(start, next === -1 ? page.indexOf('</main>') : next);
};
// One run's panel inside a job view.
const panelOf = (view: string, runNumber: number) => {
  const start = view.indexOf(`data-run="${runNumber}"`);
  expect(start, `a panel for run ${runNumber}`).toBeGreaterThan(-1);
  const next = view.indexOf('data-run="', start + 1);
  return view.slice(start, next === -1 ? undefined : next);
};
const overview = html.slice(html.indexOf('id="overview"'), html.indexOf('<section class="view job-view"'));
// What a reader sees of a fragment: its text, entities decoded, whitespace collapsed.
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (fragment: string) =>
  fragment.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]).replace(/\s+/g, ' ');

describe('the overview', () => {
  it('states the suite and how many runs ended the way their job expects', () => {
    expect(text(overview)).toContain(`Nine write jobs on Forgejo. ${PASSED} of ${ALL_RUNS.length} runs ended the way the job expects.`);
  });

  it('gives the pass rate with its 95% Wilson interval, flaky jobs, median time and requests', () => {
    const { low, high } = wilson(PASSED, ALL_RUNS.length);
    const figures = text(overview);
    expect(figures).toContain(`${PASSED}/${ALL_RUNS.length}`);
    expect(figures).toContain(`95% CI ${Math.round(low * 100)}–${Math.round(high * 100)}%`);
    expect(figures).toMatch(/2 flaky jobs of 9/i);
    expect(figures).toMatch(/median run/i);
    expect(figures).toMatch(/Jev requests per run, 350 ms each/i);
  });

  it('gives the estimated cost: the median run and the total, over the runs that ran', () => {
    const figures = text(overview);
    // Twelve runs ran: three of two calls ($0.00336), nine of one ($0.00168); the two errored runs never ran.
    expect(figures).toContain('$0.0017 est. cost per run, median · $0.025 total');
  });

  it('says the cost is unknown for runs saved before summaries carried one, and leaves them out of the median and total', () => {
    const old = { job: job('old', 'An old run'), runs: [run(1, 'old', { summaries: [oldSummary('done', 'Verified.')] })] };
    expect(text(render({ results: [old] }))).toContain('unknown est. cost per run');
    const mixed = text(render({ results: [RESULTS[1], old] }));
    expect(mixed).toContain('$0.0017 est. cost per run, median of 3 priced runs · $0.0050 total');
  });

  it('lists every job with its marks, pass count and kind, linking to its view', () => {
    expect(overview).toContain('href="#new-issue"');
    expect(text(overview)).toContain('2/2 · Write');
    expect(text(overview)).toContain('1/1 · Hand-back');
    expect(text(overview)).toMatch(/Watch run 1/);
  });

  it('marks a run that reached the page but ended with another status apart from a pass and a miss', () => {
    const reachedRow = overview.slice(overview.indexOf('href="#reached"') - 600, overview.indexOf('href="#reached"'));
    expect(reachedRow).toContain('◐');
    const flakyRow = overview.slice(overview.indexOf('href="#flaky"') - 600, overview.indexOf('href="#flaky"'));
    expect(flakyRow).toMatch(/●[\s\S]*○[\s\S]*●/);
  });

  it('shows the featured run\'s steps under each job, ending on its Finished card', () => {
    expect(overview).toContain('Click &quot;New issue&quot;');
    expect(text(overview)).toContain('Finished: done');
    expect(overview).toContain('new-issue/run-1/01.jpg');
  });

  it('offers the Flaky and Failed filters only when a job is flaky or never passed', () => {
    expect(overview).toContain('data-filter="flaky"');
    expect(overview).toContain('data-filter="failed"');
    const clean = render({ results: [RESULTS[0]] });
    expect(clean).not.toContain('data-filter="flaky"');
    expect(clean).not.toContain('data-filter="failed"');
    expect(clean).toContain('data-filter="held"');
  });

  it('names the model, screenshots, device, phrasing, start time and out folder in the footer', () => {
    const footer = text(html.slice(html.indexOf('<footer')));
    for (const fact of ['jev (jev-1.14.0)', 'screenshots never', 'desktop', 'as-written', '2026-11-01 15:43 UTC', 'forgejo-2026-11-01T15-43-33-653Z']) {
      expect(footer).toContain(fact);
    }
    expect(text(render({ outFolder: undefined }).slice(html.indexOf('<footer')))).toContain('time unknown');
  });

  it('calls a suite that does not write a read suite', () => {
    expect(text(render({ writes: false, results: [RESULTS[1]] }))).toContain('2/3 · Read');
  });
});

describe('a job view', () => {
  it('exists for every job, and opens on the video before any fact', () => {
    for (const { job } of RESULTS) {
      const view = viewOf(html, job.id);
      if (!RECORDINGS[`${job.id}/run-1/`]?.video) continue;
      expect(view.indexOf('<video'), job.id).toBeGreaterThan(-1);
      expect(view.indexOf('<video'), job.id).toBeLessThan(view.indexOf('<dl'));
    }
  });

  it('puts one numbered tick per step on the timeline, in video order', () => {
    const panel = panelOf(viewOf(html, 'new-issue'), 1);
    const ticks = [...panel.matchAll(/aria-label="Play from step (\d+)" data-at="([\d.]+)"/g)];
    expect(ticks.map((t) => Number(t[1]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ticks.map((t) => Number(t[2]))).toEqual(writeSteps.map((s) => s.video_at));
  });

  it('loads no video until asked, and only the featured run fetches a poster', () => {
    const videos = html.match(/<video\b[^>]*>/g)!;
    expect(videos.length).toBeGreaterThan(5);
    for (const video of videos) expect(video).toContain('preload="none"');
    const view = viewOf(html, 'flaky');
    expect(panelOf(view, 1)).toMatch(/<video[^>]*\sposter="flaky\/run-1\/01\.jpg"/);
    expect(panelOf(view, 3)).not.toMatch(/<video[^>]*\sposter=/);
    expect(panelOf(view, 3)).toContain('data-poster="flaky/run-3/01.jpg"');
  });

  it('switches between every run, saying how each ended', () => {
    const view = text(viewOf(html, 'flaky'));
    expect(view).toMatch(/Run 1 ● done/);
    expect(view).toMatch(/Run 2 ○ blocked/);
    expect(view).toMatch(/Run 3 ● done/);
  });

  it('lists the run facts: goal, values, done when, check held or missed, calls, reason and cost', () => {
    const facts = text(panelOf(viewOf(html, 'new-issue'), 1));
    expect(facts).toContain('Do: Open a labelled issue.');
    expect(facts).toContain('Crash on save');
    expect(facts).toContain('Open a labelled issue is done.');
    expect(facts).toMatch(/held/);
    expect(facts).toContain('needs confirmation → done');
    expect(facts).toContain('Completion condition verified.');
    expect(facts).toMatch(/8 Jev requests · 80\.0k input tokens · 4\.0 s · 350 ms median request · est\. \$0\.0034/);
    expect(text(panelOf(viewOf(html, 'flaky'), 2))).toMatch(/missed/);
  });

  it('shows the confirmation rule and, per run, which clicks were confirmed or handed back', () => {
    expect(text(viewOf(html, 'new-issue'))).toContain('/create issue/i');
    expect(text(viewOf(html, 'new-issue'))).toContain('for “Crash on save”');
    const signUp = text(panelOf(viewOf(html, 'sign-up'), 1));
    expect(signUp).toContain('confirmed “Register account”');
    expect(signUp).toContain('handed back “Delete account”');
  });

  it('lists every failed run with its reason and address', () => {
    const view = text(viewOf(html, 'flaky'));
    expect(view).toContain('Run 2 blocked: "Save rule" could not be reached 3 times');
    expect(view).toContain('http://app.test/ada/app/settings/branches');
  });

  it('links to the next job, and the last one back to the first', () => {
    expect(viewOf(html, 'new-issue')).toMatch(/href="#flaky"[^>]*>[^<]*Protect the main branch/);
    expect(viewOf(html, 'escape')).toContain('href="#new-issue"');
  });

  it('links every step to its full-size shot in a new tab, outside the button that seeks the video', () => {
    for (const [id, steps] of [['new-issue', writeSteps], ['no-video', RECORDINGS['no-video/run-1/'].steps]] as const) {
      const panel = panelOf(viewOf(html, id), 1);
      for (const s of steps) {
        expect(panel, `${id} ${s.file}`).toMatch(new RegExp(`<a [^>]*href="${id}/run-1/${s.file}" target="_blank" rel="noopener"[^>]*>Full size</a>`));
      }
      for (const [button] of panel.matchAll(/<button\b[\s\S]*?<\/button>/g)) expect(button).not.toContain('<a ');
    }
  });

  it('says None for a job without values', () => {
    expect(text(panelOf(viewOf(html, 'reached'), 1))).toMatch(/Values None/);
  });
});

describe('edge cases', () => {
  it('shows a run that errored without a recording as a quiet panel with the error, and no video', () => {
    const panel = panelOf(viewOf(html, 'errored'), 1);
    expect(panel).not.toContain('<video');
    expect(text(panel)).toContain('Browser connection closed (code 1006)');
    expect(text(viewOf(html, 'errored'))).toMatch(/Run 1 ○ error/);
  });

  it('shows a run the suite never got to as not run', () => {
    const view = viewOf(html, 'errored');
    expect(text(panelOf(view, 2))).toContain('Not run: the suite stopped before this run.');
    expect(text(view)).toMatch(/Run 2 ○ not run/);
  });

  it('shows a recording without video as its first shot, with the steps and no timeline', () => {
    const panel = panelOf(viewOf(html, 'no-video'), 1);
    expect(panel).not.toContain('<video');
    expect(panel).toMatch(/<img[^>]*src="no-video\/run-1\/01\.jpg"/);
    expect(panel).not.toContain('aria-label="Play from step');
    expect(text(panel)).toContain('No video for this run (it needs ffmpeg)');
  });

  it('marks a step whose target was never reached, with how many times', () => {
    expect(text(panelOf(viewOf(html, 'flaky'), 2))).toContain('not reached ×2: covered');
  });

  it('says a run that needed no action was already met at start', () => {
    expect(text(panelOf(viewOf(html, 'already'), 1))).toContain('already met at start');
  });

  it('marks reached but not passed with its own mark and says what Jev reported', () => {
    const view = text(viewOf(html, 'reached'));
    expect(view).toMatch(/Run 1 ◐ blocked/);
    expect(view).toContain('reached the right page, but Jev reported blocked: Stuck on the settings page.');
  });

  it('shows a two-call job\'s first done when, the second call\'s values, and a missing row with the rows read', () => {
    const view = viewOf(html, 'sign-up');
    expect(text(view)).toContain('The page says to check your email.');
    expect(text(panelOf(view, 1))).toContain('Grace Hopper');
    const missing = text(panelOf(view, 2));
    expect(missing).toContain('the table had no row to continue with');
    expect(missing).toContain('ada@example.test');
  });

  it('never shows a secret value, wherever the run echoed it', () => {
    expect(html).not.toContain(SECRET);
    expect(text(panelOf(viewOf(html, 'sign-up'), 1))).toContain('[secret:password]');
  });

  it('keeps every inline script parseable, with hostile titles and reasons on the page', () => {
    const hostile = render({ title: '</script><script>alert("t")</script> `${x}` \\ \u2028 end' });
    const scriptsOf = (page: string) => [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(([, source]) => source);
    const scripts = scriptsOf(hostile);
    // Only the page's own scripts: a title or reason that broke out would add one (a valid one, so count them).
    expect(scripts.length).toBe(scriptsOf(render()).length);
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const source of scripts) expect(() => new vm.Script(source), source.slice(0, 80)).not.toThrow();
  });

  it('escapes page text, titles, reasons and addresses', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('Quote &quot;this&quot; &amp; &lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(\'reason\')&lt;/script&gt;');
    expect(html).not.toMatch(/="[^"]*"><script>alert\(2\)/);
  });
});

describe('re-rendering a saved results.json', () => {
  const saved = {
    device: 'desktop',
    phrasing: 'as-written',
    runsPerJob: 1,
    results: [
      { job: { id: 'a', title: 'A', job: 'j', goal: 'g', doneWhen: 'd', check: 'c', confirms: {} }, runs: [run(1, 'a')] },
      { job: { id: 'b', title: 'B', job: 'j', goal: 'g', doneWhen: 'd', check: 'c', confirms: '/save/i' }, runs: [run(1, 'b')] },
    ],
  };

  it('names an old folder\'s suite from the folder and its job count, and leaves unknown facts unknown', () => {
    const input = reportFromResults(saved, 'forgejo-2026-11-01T15-43-33-653Z');
    expect(input.title).toBe('Forgejo: 2 jobs with jev-browse');
    expect(input.model).toBe('unknown');
    expect(input.screenshots).toBe('unknown');
    expect(input.outFolder).toBe('forgejo-2026-11-01T15-43-33-653Z');
  });

  it('renders an old folder whose summaries carry no cost, the cost unknown and never $0', () => {
    const old = { ...saved, results: [{ job: saved.results[0].job, runs: [run(1, 'a', { summaries: [oldSummary('done', 'Verified.')] })] }] };
    const page = text(renderReport({ ...reportFromResults(old, 'forgejo-x'), readRecording: () => undefined }));
    expect(page).toContain('350 ms median request · est. cost unknown');
    expect(page).toContain('unknown est. cost per run');
    expect(page).not.toContain('$0 ');
  });

  it('keeps a saved title, model and confirmation pattern, and infers a write suite from confirmations', () => {
    const input = reportFromResults({ ...saved, title: 'Forgejo: 2 write jobs with jev-browse', model: 'jev (jev-1.14.0)', screenshots: 'never' }, 'forgejo-x');
    expect(input.title).toBe('Forgejo: 2 write jobs with jev-browse');
    expect(input.model).toBe('jev (jev-1.14.0)');
    expect(input.writes).toBe(true);
    expect(String(input.results[1].job.confirms)).toBe('/save/i');
    expect(input.results[0].job.confirms).toBeUndefined();
  });
});
