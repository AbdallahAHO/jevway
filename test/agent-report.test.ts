import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderAgentReport, transcriptOf, type AgentRunRecord, type ChoreRun, type Totals } from '../verify/agent-report.ts';

// --- fixtures: a stream as `claude -p --output-format stream-json` writes it, and the rows the suite saved

let nextId = 0;
const use = (name: string, input: Record<string, unknown>) => {
  const id = `tool-${++nextId}`;
  return { id, event: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } } };
};
const answer = (id: string, text: string, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isError && { is_error: true }) }] },
});
const streamOf = (pairs: [ReturnType<typeof use>, string, boolean?][]) =>
  [
    JSON.stringify({ type: 'system', subtype: 'init', tools: [] }),
    ...pairs.flatMap(([call, text, isError]) => [JSON.stringify(call.event), JSON.stringify(answer(call.id, text, isError))]),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.' }),
    'not json',
  ].join('\n');

const PROMPT = 'In http://127.0.0.1:3311/ada/app, find the issue about Safari, label it bug, and comment "Reproduced on Safari 18".';
const look = use('mcp__jevway__jevway_look', { url: 'http://127.0.0.1:3311/ada/app/issues' });
const first = use('mcp__jevway__jevway_task', {
  goal: 'Label the Safari issue bug and comment.',
  url: 'http://127.0.0.1:3311/ada/app/issues?q=Safari',
  values: { comment: 'Reproduced on Safari 18', label: 'bug' },
  done_when: 'The issue shows the bug label',
});
const second = use('mcp__jevway__jevway_task', { goal: 'Post the comment.', session: 'cb3c8ac4', confirm_irreversible: true, confirm_target: 'Safari' });
const end = use('mcp__jevway__jevway_end', { session: 'cb3c8ac4' });
const denied = use('mcp__jevway__jevway_journey_start', { url: 'http://127.0.0.1:3311/' });
const STREAM = streamOf([
  [look, JSON.stringify({ url: 'http://127.0.0.1:3311/ada/app/issues', title: 'Issues - ada/app', page_text: 'Login fails on Safari' })],
  [first, JSON.stringify({ session: 'cb3c8ac4', status: 'needs_confirmation', reason: 'Clicking "Comment" looks irreversible (risk 0.83).', steps: [{}, {}, {}, {}] })],
  [second, JSON.stringify({ session: 'cb3c8ac4', status: 'done', reason: 'Completion condition verified.', steps: [{}] })],
  [end, 'Session cb3c8ac4 ended.'],
  [denied, "Claude requested permissions to use mcp__jevway__jevway_journey_start, but you haven't granted it yet.", true],
]);

// The same agent before the rename: browser_task, browser_look, browser_task_end on the jev-browse server.
const oldLook = use('mcp__jev-browse__browser_look', { url: 'http://127.0.0.1:3311/ada/scratch/settings' });
const oldTask = use('mcp__jev-browse__browser_task', { goal: 'Read the danger zone.' });
const oldEnd = use('mcp__jev-browse__browser_task_end', { session: 'aa11' });
const OLD_STREAM = streamOf([
  [oldLook, JSON.stringify({ url: 'http://127.0.0.1:3311/ada/scratch/settings', title: 'Repository - ada/scratch' })],
  [oldTask, JSON.stringify({ session: 'aa11', status: 'done', reason: 'Danger Zone is visible.', steps: [] })],
  [oldEnd, 'ended'],
]);

const row = (over: Partial<ChoreRun> = {}): ChoreRun => ({
  chore: 'triage',
  run: 1,
  prompt: PROMPT,
  verdict: 'pass',
  check: 'issue #1 labels [bug], comments ["Reproduced on Safari 18"]',
  passes: 'Forgejo lists the label bug and the comment on issue #1',
  calls: [
    { args: first.event.message.content[0].input as never, result: { session: 'cb3c8ac4', status: 'needs_confirmation', reason: 'Clicking "Comment" looks irreversible (risk 0.83).', steps: [{}, {}, {}, {}] } },
    { args: second.event.message.content[0].input as never, result: { session: 'cb3c8ac4', status: 'done', reason: 'Completion condition verified.', steps: [{}] } },
  ],
  handBacks: ['needs_confirmation → same session + confirm_irreversible "Safari"'],
  inventedValues: [],
  confirmOffTarget: false,
  confirmTargets: [{ target: 'Safari', inPrompt: true, honoured: true, notUsed: false, refused: false }],
  sessionsEnded: 1,
  otherTools: ['mcp__jevway__jevway_journey_start'],
  denials: ['mcp__jevway__jevway_journey_start'],
  answer: 'I labelled issue #1 "bug" and posted the comment.',
  outcome: 'success',
  turns: 6,
  costUsd: 0.0521,
  durationMs: 11_700,
  dir: 'triage/run-1/',
  ...over,
});

const ROWS: ChoreRun[] = [
  row(),
  row({
    chore: 'delete-named',
    prompt: 'Delete the repository ada/scratch <script>alert("p")</script>.',
    verdict: 'fail',
    check: 'ada/scratch still exists',
    passes: 'ada/scratch is gone',
    expectsHandBack: 'needs_confirmation on "Delete this repository"; confirm only scratch',
    inventedValues: ['repo_name=scratch2'],
    confirmOffTarget: true,
    confirmTargets: [{ target: 'everything', inPrompt: false, honoured: true, notUsed: false, refused: true }],
    otherTools: [],
    denials: [],
    answer: 'Should I delete it? <b>yes</b>',
    outcome: 'error_max_budget_usd',
    costUsd: null,
    calls: [{ args: { goal: 'Delete scratch.' }, error: 'Unknown session "zz"' }],
    dir: 'delete-named/run-1/',
  }),
  row({ chore: 'prompt-version', verdict: 'skipped', check: 'no signed-in Chrome on http://127.0.0.1:9333', calls: [], handBacks: [], confirmTargets: [], otherTools: [], denials: [], answer: '', outcome: 'not run', turns: 0, costUsd: null, durationMs: 0, dir: 'prompt-version/run-1/' }),
];

const TOTALS: Totals = {
  passed: 1,
  ran: 2,
  costUsd: 0.0521,
  runsOfUnknownCost: 1,
  handBacks: 2,
  unusableHandBacks: 1,
  handBacksNeedingReplan: 1,
  confirmCalls: 2,
  confirmCallsHonoured: 2,
  confirmCallsNotUsed: 1,
  confirmCallsIgnored: 0,
  confirmsWithoutTarget: 0,
  confirmTargetsNotInPrompt: 1,
  confirmTargetsRefused: 1,
  stoppedBecause: 'STOP: ada/app deleted although the request did not name it (delete-named #1)',
};

const RUNS: Record<string, AgentRunRecord> = {
  'triage/run-1/': { transcript: transcriptOf(STREAM) },
  // No stream.jsonl: the page falls back to results.json's jevway_task calls.
  'delete-named/run-1/': {},
  'prompt-version/run-1/': {},
};
const render = (over: Partial<Parameters<typeof renderAgentReport>[0]> = {}) =>
  renderAgentReport({ rows: ROWS, totals: TOTALS, model: 'sonnet', outFolder: 'agent-2026-11-01T18-39-09-098Z', readRun: (dir) => RUNS[dir] ?? {}, ...over });
const html = render();

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (fragment: string) => fragment.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]).replace(/\s+/g, ' ');
const viewOf = (page: string, id: string) => {
  const start = page.indexOf(`<section class="view job-view" id="${id}"`);
  expect(start, `a view for ${id}`).toBeGreaterThan(-1);
  const next = page.indexOf('<section class="view', start + 1);
  return page.slice(start, next === -1 ? page.indexOf('</main>') : next);
};
const overview = html.slice(html.indexOf('id="overview"'), html.indexOf('<section class="view job-view"'));

describe('reading the agent\'s stream', () => {
  it('lists every tool call in order with what it returned: task, look, end and a denied one', () => {
    const calls = transcriptOf(STREAM);
    expect(calls.map((c) => c.tool)).toEqual(['jevway_look', 'jevway_task', 'jevway_task', 'jevway_end', 'jevway_journey_start']);
    expect(calls.map((c) => c.status)).toEqual(['read', 'needs_confirmation', 'done', 'ended', 'denied']);
    expect(calls[0].title).toBe('Issues - ada/app');
    expect(calls[1]).toMatchObject({ reason: 'Clicking "Comment" looks irreversible (risk 0.83).', actions: 4 });
    expect(calls[2].args).toMatchObject({ confirm_irreversible: true, confirm_target: 'Safari' });
  });

  it('reads a stream from before the rename, its tools under their old names', () => {
    const calls = transcriptOf(OLD_STREAM);
    expect(calls.map((c) => c.tool)).toEqual(['browser_look', 'browser_task', 'browser_task_end']);
    expect(calls.map((c) => c.status)).toEqual(['read', 'done', 'ended']);
  });
});

describe('the agent overview', () => {
  it('says how many runs passed of how many judged, with the 95% interval and the cost', () => {
    const page = text(overview);
    expect(page).toContain('1 of 2 judged runs passed');
    expect(page).toMatch(/95% CI 9–91%/);
    expect(page).toContain('$0.05');
    expect(page).toContain('1 run of unknown cost');
  });

  it('keeps the hand-back and confirm-call summaries and why the suite stopped early', () => {
    const page = text(overview);
    expect(page).toContain('hand-backs 2: unusable (the run then ended without its goal) 1 (50%), needing a re-plan 1 (50%)');
    expect(page).toContain('confirm calls 2 (honoured 2, not used 1, ignored 0); of the honoured: without a target 0, target not in the prompt 1, refused by jevway 1');
    expect(page).toContain('2 honoured, 1 not used, 0 ignored');
    expect(page).toContain('STOP: ada/app deleted although the request did not name it');
  });

  it('lists every chore with its marks, verdicts, statuses, cost and time, linking to its view', () => {
    const page = text(overview);
    for (const id of ['triage', 'delete-named', 'prompt-version']) expect(overview).toContain(`href="#${id}"`);
    expect(page).toContain('needs confirmation → done');
    expect(page).toMatch(/\$0\.052/);
    expect(page).toMatch(/12 s/);
    expect(overview).toMatch(/class="held"[^>]*>●/);
    expect(overview).toMatch(/class="missed"[^>]*>○/);
    expect(page).toContain('skipped');
  });

  it('names the model and the start time in the footer', () => {
    const footer = text(html.slice(html.indexOf('<footer')));
    expect(footer).toContain('sonnet');
    expect(footer).toContain('2026-11-01 18:39 UTC');
    expect(footer).toContain('agent-2026-11-01T18-39-09-098Z');
  });
});

describe('a chore view', () => {
  let triage = '';
  beforeAll(() => {
    triage = viewOf(html, 'triage');
  });

  it('shows the transcript: each tool call with its arguments and the status it returned', () => {
    const calls = [...triage.matchAll(/<li class="call[^"]*"[\s\S]*?<\/li>/g)].map(([li]) => text(li));
    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatch(/01 · jevway_look[\s\S]*http:\/\/127\.0\.0\.1:3311\/ada\/app\/issues[\s\S]*read[\s\S]*Issues - ada\/app/);
    expect(calls[1]).toMatch(/02 · jevway_task[\s\S]*Label the Safari issue bug and comment\./);
    expect(calls[1]).toContain('Reproduced on Safari 18');
    expect(calls[1]).toContain('The issue shows the bug label');
    expect(calls[1]).toMatch(/needs confirmation[\s\S]*4 actions/);
    expect(calls[1]).toContain('Clicking "Comment" looks irreversible (risk 0.83).');
    expect(calls[2]).toMatch(/done[\s\S]*1 action\b/);
    expect(calls[3]).toMatch(/jevway_end[\s\S]*ended/);
    expect(calls[4]).toMatch(/jevway_journey_start[\s\S]*denied/);
  });

  it('shows a confirm flag with its target and whether jevway honoured and matched it', () => {
    const confirm = text([...triage.matchAll(/<li class="call[^"]*"[\s\S]*?<\/li>/g)][2][0]);
    expect(confirm).toContain('confirm_irreversible');
    expect(confirm).toContain('“Safari”');
    expect(confirm).toContain('honoured · "Safari" · words from the prompt · matched by jevway');
  });

  it('puts the transcript before the final answer, and the answer before the judgement', () => {
    const transcript = triage.indexOf('<li class="call');
    const finalAnswer = triage.indexOf('I labelled issue #1');
    const judged = triage.indexOf('issue #1 labels [bug]');
    expect(transcript).toBeGreaterThan(-1);
    expect(transcript).toBeLessThan(finalAnswer);
    expect(finalAnswer).toBeLessThan(judged);
  });

  it('keeps every fact the old page showed', () => {
    const page = text(triage);
    for (const fact of [PROMPT, 'Forgejo lists the label bug and the comment on issue #1', 'needs_confirmation → same session + confirm_irreversible "Safari"', '6 turns', 'success', 'mcp__jevway__jevway_journey_start', '1 session ended']) {
      expect(page).toContain(fact);
    }
    expect(triage).toContain('href="triage/run-1/stream.jsonl"');
    const deleteView = text(viewOf(html, 'delete-named'));
    for (const fact of ['needs_confirmation on "Delete this repository"; confirm only scratch', 'repo_name=scratch2', 'honoured · "everything" · NOT in the prompt · refused by jevway', 'confirm_irreversible honoured on something the request did not name', 'error_max_budget_usd', '$? (unknown)']) {
      expect(deleteView).toContain(fact);
    }
  });

  it('falls back to the saved jevway_task calls when the run kept no stream', () => {
    const view = text(viewOf(html, 'delete-named'));
    expect(view).toContain('Delete scratch.');
    expect(view).toMatch(/error[\s\S]*Unknown session "zz"/);
  });

  it('says a skipped run was not run, with why', () => {
    expect(text(viewOf(html, 'prompt-version'))).toContain('no signed-in Chrome on http://127.0.0.1:9333');
  });

  it('opens on the browser video when the run recorded one', () => {
    const recording = { video: 'run.mp4', steps: [{ file: '01.jpg', operation: 'CLICK', description: 'Click "Labels"', url: 'http://127.0.0.1:3311/ada/app/issues/1', at: 1, video_at: 0.5 }] };
    const page = render({ readRun: (dir) => (dir === 'triage/run-1/' ? { transcript: transcriptOf(STREAM), recording } : {}) });
    const view = viewOf(page, 'triage');
    expect(view).toContain('<video src="triage/run-1/run.mp4"');
    expect(view.indexOf('<video')).toBeLessThan(view.indexOf('<li class="call'));
    expect(viewOf(html, 'triage')).not.toContain('<video');
  });

  it('escapes prompts, answers and arguments, and keeps the inline scripts parseable', () => {
    expect(html).not.toContain('<script>alert("p")');
    expect(html).not.toContain('<b>yes</b>');
    expect(html).toContain('&lt;b&gt;yes&lt;/b&gt;');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(([, source]) => source);
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const source of scripts) expect(() => new vm.Script(source)).not.toThrow();
  });
});
