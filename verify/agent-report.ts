// The real-agent suite's report (`pnpm verify:agent`): every chore as a row, and per chore each run's transcript of
// tool calls, the agent's final answer and how the run was judged. Same layout as the jobs report (report.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedStep } from '../src/task/recording.ts';
import { escapeHtml as escape, fact, indexLabel, playerMarkup, plural, statusWord, type Viewport } from '../src/task/recording-page.ts';
import { describeConfirmTarget, type BrowserCall, type ConfirmTarget } from './agent-confirms.ts';
import { figure, startedAt, wilson } from './jobs/report.ts';
import { ARROW, BACK_ARROW, FONT_LINK, HEAD_SCRIPT, SCRIPT, STYLE } from './jobs/report-page.ts';

/** One run of one chore, as the suite saved it in `results.json` `rows`. */
export interface ChoreRun {
  chore: string;
  run: number;
  prompt: string;
  verdict: 'pass' | 'fail' | 'skipped' | 'error';
  check: string;
  passes: string;
  expectsHandBack?: string;
  calls: BrowserCall[];
  handBacks: string[];
  inventedValues: string[];
  /** confirm_irreversible was set in a session that was not acting on a deletion the prompt named. */
  confirmOffTarget: boolean;
  /** One per `confirm_irreversible` call: the target the agent chose, and whether the prompt and the page backed it. */
  confirmTargets: ConfirmTarget[];
  sessionsEnded: number;
  otherTools: string[];
  denials: string[];
  answer: string;
  outcome: string;
  turns: number;
  costUsd: number | null;
  durationMs: number;
  /** The run folder (stream, stderr logs), relative to the report. */
  dir: string;
}

export interface Totals {
  passed: number;
  ran: number;
  costUsd: number;
  /** Runs that never sent a final event: their spend is in neither `costUsd` nor the budget check. */
  runsOfUnknownCost: number;
  handBacks: number;
  /** Gate R4: hand-backs after which the run ended without its goal. */
  unusableHandBacks: number;
  /** For tracking: hand-backs that were not answered by a value or a confirmation. */
  handBacksNeedingReplan: number;
  /** `confirm_irreversible` calls, and how many had no target, a target the prompt does not contain, or one jevway refused. */
  confirmCalls: number;
  /** ...of which jevway honoured, and ignored (a flag outside a first call or an answer is a no-op). */
  confirmCallsHonoured: number;
  confirmCallsIgnored: number;
  confirmsWithoutTarget: number;
  confirmTargetsNotInPrompt: number;
  confirmTargetsRefused: number;
  stoppedBecause?: string;
}

/** One tool call of the agent's transcript, with what it got back. */
export interface ToolCall {
  /** The tool's name without its server prefix, as recorded: `jevway_task`, or `browser_task` before the rename. */
  tool: string;
  args: Record<string, unknown>;
  /** The call's status (`done`, `needs_confirmation` …), `read` for a look, `ended` for an end, `denied` or `error`. */
  status?: string;
  reason?: string;
  /** Actions jevway took in a task call. */
  actions?: number;
  title?: string;
  url?: string;
  error?: string;
}

export interface AgentRunRecord {
  /** Every tool call, from the run's `stream.jsonl`; absent for a folder that kept none. */
  transcript?: ToolCall[];
  /** A browser recording in the run folder (`summary.json`), when the run made one. */
  recording?: { video: string | null; steps: RecordedStep[]; viewport?: Viewport };
}

// --- numbers as the suite logs them (whole seconds, a thousandth of a dollar)

export const seconds = (ms: number) => `${(ms / 1000).toFixed(0)} s`;
export const dollars = (usd: number | null, digits = 3) => (usd === null ? '$? (unknown)' : `$${usd.toFixed(digits)}`);
const percentOf = (part: number, whole: number) => (whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`);

export const handBackSummary = (totals: Totals) =>
  `hand-backs ${totals.handBacks}: unusable (the run then ended without its goal) ${totals.unusableHandBacks} (${percentOf(totals.unusableHandBacks, totals.handBacks)}), needing a re-plan ${totals.handBacksNeedingReplan} (${percentOf(totals.handBacksNeedingReplan, totals.handBacks)})`;

export const confirmSummary = (totals: Totals) =>
  `confirm calls ${totals.confirmCalls} (honoured ${totals.confirmCallsHonoured}, ignored ${totals.confirmCallsIgnored}); of the honoured: without a target ${totals.confirmsWithoutTarget}, target not in the prompt ${totals.confirmTargetsNotInPrompt}, refused by jevway ${totals.confirmTargetsRefused}`;

// --- the transcript, from the stream

const textOf = (content: unknown) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
const isEnd = (tool: string) => /_end$/.test(tool);
const isLook = (tool: string) => /_look$/.test(tool);
const isTask = (tool: string) => /_task$/.test(tool);

/** What a tool's answer says, by the kind of tool (the name's suffix, so names from before the rename read the same). */
const outcomeOf = (tool: string, text: string, isError: boolean): Partial<ToolCall> => {
  if (isError) return { status: /permission|haven't granted|denied|not allowed/i.test(text) ? 'denied' : 'error', error: text };
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    return isEnd(tool) ? { status: 'ended', reason: text } : isTask(tool) || isLook(tool) ? { status: 'error', error: text } : { status: 'returned', reason: text };
  }
  if (isEnd(tool)) return { status: 'ended' };
  if (isLook(tool)) return { status: 'read', title: result?.title, url: result?.url };
  if (isTask(tool)) return { status: result?.status ?? 'error', reason: result?.reason, actions: result?.steps?.length, url: result?.url };
  return { status: result?.status ?? 'returned', reason: result?.reason };
};

/**
 * Every tool call the agent made, in order, with what it got back, read from the `stream-json` events of `claude -p`.
 * A tool the permission layer refused reads `denied`.
 *
 * @example
 * transcriptOf(readFileSync('triage/run-1/stream.jsonl', 'utf8')).map((c) => `${c.tool} ${c.status}`)
 * // ['jevway_look read', 'jevway_task needs_confirmation', 'jevway_task done']
 */
export const transcriptOf = (stream: string): ToolCall[] => {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const line of stream.split('\n')) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      for (const block of blocks.filter((b: any) => b.type === 'tool_use')) {
        const call: ToolCall = { tool: String(block.name).replace(/^mcp__.+?__/, ''), args: block.input ?? {} };
        byId.set(block.id, call);
        calls.push(call);
      }
    } else if (event.type === 'user') {
      for (const block of blocks.filter((b: any) => b.type === 'tool_result')) {
        const call = byId.get(block.tool_use_id);
        if (call) Object.assign(call, outcomeOf(call.tool, textOf(block.content), Boolean(block.is_error)));
      }
    }
  }
  return calls;
};

// The calls results.json kept (jevway_task only), for a run folder without its stream.
const savedCalls = (calls: BrowserCall[]): ToolCall[] =>
  calls.map((call) => ({ tool: 'jevway_task', args: call.args, status: call.result?.status ?? 'error', reason: call.result?.reason, actions: call.result?.steps?.length, error: call.error }));

/**
 * Reads what each run folder of an agent out folder kept: the stream (for the transcript) and a recording, if any.
 *
 * @example
 * renderAgentReport({ rows, totals, model, outFolder, readRun: agentRunReader('verify/out/agent-2026-11-01T18-39-09-098Z') })
 */
export const agentRunReader = (outDir: string) => (dir: string): AgentRunRecord => {
  const read = (file: string) => {
    try {
      return readFileSync(join(outDir, dir, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  const stream = read('stream.jsonl');
  const summary = read('summary.json');
  const recording = summary ? JSON.parse(summary) : undefined;
  return { ...(stream !== undefined && { transcript: transcriptOf(stream) }), ...(recording?.steps?.length && { recording }) };
};

// --- marks and small markup

const TONES = { pass: ['●', 'held'], fail: ['○', 'missed'], error: ['○', 'missed'], skipped: ['○', 'unrun'] } as const;
const mark = (row: ChoreRun) => {
  const [symbol, tone] = TONES[row.verdict];
  return `<span class="${tone}" title="Run ${row.run}: ${row.verdict}">${symbol}</span>`;
};
const marks = (runs: ChoreRun[]) => `<span class="marks" aria-label="${runs.filter((r) => r.verdict === 'pass').length} of ${runs.length} runs passed">${runs.map(mark).join('')}</span>`;
// How a returned status reads: done, a read page and an end held; a hand-back is amber; a refusal or an error missed.
const toneOf = (status = '') => (['done', 'read', 'ended', 'returned'].includes(status) ? 'held' : status.startsWith('needs_') ? 'reached' : 'missed');
// The run's calls in a line: a task call by its status, a look or an end by its kind, anything else by name and status.
const callWord = (call: ToolCall) =>
  isTask(call.tool) ? statusWord(call.status ?? 'no answer') : isLook(call.tool) && call.status === 'read' ? 'look' : isEnd(call.tool) && call.status === 'ended' ? 'end' : `${call.tool} ${statusWord(call.status ?? 'no answer')}`;
const statusChain = (row: ChoreRun, record: AgentRunRecord) => (record.transcript ?? savedCalls(row.calls)).map(callWord).join(' → ') || 'no calls';
const quoted = (text: string) => `“${escape(text)}”`;
const valueText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
const featuredRun = (runs: ChoreRun[]) => runs.find((r) => r.verdict === 'pass') ?? runs[0];

// --- the transcript as hairline rows

const PRIMARY = ['goal', 'url', 'session'];
const argumentLines = (args: Record<string, unknown>, primary: string | undefined) =>
  Object.entries(args)
    .filter(([key]) => key !== primary && key !== 'confirm_irreversible' && key !== 'confirm_target')
    .map(([key, value]) => {
      const body =
        key === 'values' && value && typeof value === 'object'
          ? Object.entries(value as Record<string, unknown>).map(([name, typed]) => `${escape(name)} ${quoted(valueText(typed))}`).join(' · ')
          : escape(valueText(value));
      return `<span class="arg"><span class="kv">${escape(key)}</span>${body}</span>`;
    })
    .join('');

const callItem = (call: ToolCall, i: number, confirm: ConfirmTarget | undefined) => {
  const primary = PRIMARY.find((key) => typeof call.args[key] === 'string');
  const confirmLine =
    call.args.confirm_irreversible === true
      ? `<p class="confirm"><span class="kv">confirm_irreversible</span>${typeof call.args.confirm_target === 'string' ? `for ${quoted(call.args.confirm_target)}` : 'no confirm_target'}${confirm ? ` · ${escape(describeConfirmTarget(confirm))}` : ''}</p>`
      : '';
  const status = call.status ?? 'no answer';
  const detail = [call.title, call.reason, call.error].filter(Boolean).map((line) => escape(String(line))).join('<br>');
  return `<li class="call grid4">
<p class="meta">${indexLabel(i)} · <code class="tool">${escape(call.tool)}</code></p>
<div class="c2s2 call-body"><p>${primary ? escape(String(call.args[primary])) : '<span class="kv">no arguments</span>'}</p>${argumentLines(call.args, primary) ? `<p class="args">${argumentLines(call.args, primary)}</p>` : ''}${confirmLine}</div>
<p class="c4 end call-status"><span class="${toneOf(call.status)}">${escape(statusWord(status))}</span>${call.actions === undefined ? '' : `<br><span class="meta">${plural(call.actions, 'action')}</span>`}</p>
${detail ? `<p class="small c2s3 call-detail">${detail}</p>` : ''}
</li>`;
};

const transcript = (row: ChoreRun, record: AgentRunRecord) => {
  const calls = record.transcript ?? savedCalls(row.calls);
  const source = record.transcript ? `${plural(calls.length, 'tool call')}, in order, from stream.jsonl` : `${plural(calls.length, 'jevway_task call')} from results.json (this run kept no stream.jsonl)`;
  // The k-th flagged task call is the k-th confirm the suite judged.
  let flagged = 0;
  const items = calls.map((call, i) => callItem(call, i, isTask(call.tool) && call.args.confirm_irreversible === true ? row.confirmTargets[flagged++] : undefined));
  return `<section class="transcript" aria-label="Transcript of run ${row.run}">
<div class="transcript-head grid4"><p class="meta">Transcript</p><p class="small c2s3">${source}</p></div>
${items.length ? `<ol class="calls">${items.join('\n')}</ol>` : '<p class="small no-calls">No tool calls.</p>'}
</section>`;
};

// --- one chore: each run's player (when it recorded one), transcript, answer and judgement

const runSwitcher = (runs: ChoreRun[], current: ChoreRun) =>
  `<div class="textlinks c1s3" role="group" aria-label="Runs">${runs.map((r) => `<button type="button" data-show-run="${r.run}" aria-pressed="${r === current}">Run ${r.run} ${mark(r)} ${escape(r.verdict)}</button>`).join('')}</div>`;

const runFacts = (row: ChoreRun) => {
  const rows = [
    fact('Final answer', row.answer ? `<span class="answer">${escape(row.answer)}</span>` : '<span class="unrun">None</span>'),
    fact('Judged', `<span class="${TONES[row.verdict][1]}">${escape(row.verdict)}</span> · ${escape(row.check)}`),
    fact('Passes when', escape(row.passes)),
    ...(row.expectsHandBack ? [fact('Expected hand-back', escape(row.expectsHandBack))] : []),
    ...(row.handBacks.length ? [fact('Hand-backs', row.handBacks.map(escape).join('<br>'))] : []),
    ...(row.inventedValues.length ? [fact('Values not in the prompt', `<span class="missed">${escape(row.inventedValues.join(', '))}</span>`)] : []),
    ...(row.confirmTargets.length
      ? [fact('Confirm calls', row.confirmTargets.map((c) => `<span class="${c.honoured && (c.target === undefined || !c.inPrompt) ? 'missed' : ''}">${escape(describeConfirmTarget(c))}</span>`).join('<br>'))]
      : []),
    ...(row.confirmOffTarget ? [fact('Warning', '<span class="missed">confirm_irreversible honoured on something the request did not name</span>')] : []),
    ...(row.otherTools.length || row.denials.length
      ? [fact('Other tools', `<span class="missed">used ${escape(row.otherTools.join(', ') || 'none')} · denied ${escape(row.denials.join(', ') || 'none')}</span>`)]
      : []),
    fact('Run', `<span class="num">${escape(row.outcome)} · ${plural(row.turns, 'turn')} · ${dollars(row.costUsd)} · ${seconds(row.durationMs)} · ${plural(row.calls.length, 'jevway_task call')} · ${plural(row.sessionsEnded, 'session')} ended</span>`),
    fact('Files', `<a href="${escape(`${row.dir}stream.jsonl`)}">${escape(row.dir)}stream.jsonl</a> · <a href="${escape(`${row.dir}claude-stderr.log`)}">claude-stderr.log</a> · <a href="${escape(`${row.dir}claude-debug.log`)}">claude-debug.log</a> · <a href="${escape(`${row.dir}mcp-stderr.log`)}">mcp-stderr.log</a>`),
  ];
  return `<dl class="facts">${rows.join('\n')}</dl>`;
};

const runPanel = (row: ChoreRun, runs: ChoreRun[], featured: ChoreRun, record: AgentRunRecord) => {
  const bar = `<div class="player-bar grid4">${runSwitcher(runs, row)}<span class="meta clock c4 end"></span></div>`;
  const recording = record.recording;
  const top = recording?.steps.length
    ? playerMarkup({ dir: row.dir, video: recording.video, steps: recording.steps, label: `run ${row.run}`, featured: row === featured, viewport: recording.viewport, bar })
    : bar.replace('class="player-bar grid4"', 'class="player-bar bar-only grid4"');
  const headline = row.verdict === 'skipped' ? 'Skipped' : `${row.verdict === 'pass' ? 'Passed' : row.verdict === 'error' ? 'Error' : 'Failed'}, ${plural((record.transcript ?? row.calls).length, 'tool call')} in ${plural(row.turns, 'turn')}`;
  return `<div class="run player${row === featured ? ' current' : ''}" data-run="${row.run}">
${top}
<div class="run-head grid4"><p class="small c2">Run ${row.run}<br>${escape(row.outcome)}</p><h2 class="section-title c3s2">${headline} · ${dollars(row.costUsd)} · ${seconds(row.durationMs)}</h2></div>
${transcript(row, record)}
${runFacts(row)}
</div>`;
};

const choreView = (runs: ChoreRun[], index: number, next: ChoreRun[], readRun: (dir: string) => AgentRunRecord) => {
  const [first] = runs;
  const passed = runs.filter((r) => r.verdict === 'pass').length;
  const featured = featuredRun(runs);
  const known = runs.filter((r) => r.costUsd !== null);
  const spent = known.length ? ` · ${dollars(known.reduce((t, r) => t + r.costUsd!, 0))}` : '';
  return `<section class="view job-view" id="${escape(first.chore)}" aria-labelledby="title-${escape(first.chore)}">
<div class="wrapper">
<header class="job-head grid4">
<p class="meta"><a class="back" href="#chores">${BACK_ARROW} All chores</a><br>Chore ${indexLabel(index)}</p>
<h1 class="job-title c2s2" id="title-${escape(first.chore)}">${escape(first.chore)}</h1>
<p class="meta c4 end">${marks(runs)}<br>${passed}/${runs.length} passed${spent}</p>
<p class="small story c2s2">${quoted(first.prompt)}</p>
</header>
${runs.map((r) => runPanel(r, runs, featured, readRun(r.dir))).join('\n')}
<nav class="next" aria-label="Next chore"><div class="next-row grid4"><p class="meta">Next chore</p><a class="row-title c2s2" href="#${escape(next[0].chore)}">${escape(next[0].chore)}</a><a class="action c4 end" href="#${escape(next[0].chore)}">Next chore ${ARROW}</a></div></nav>
</div>
</section>`;
};

// --- the overview

const choreRow = (runs: ChoreRun[], readRun: (dir: string) => AgentRunRecord) => {
  const [first] = runs;
  const featured = featuredRun(runs);
  const passed = runs.filter((r) => r.verdict === 'pass').length;
  const href = `#${first.chore}`;
  const runLines = runs
    .map((r) => {
      const facts = r.verdict === 'skipped' ? escape(r.check) : `${escape(statusChain(r, readRun(r.dir)))} · ${dollars(r.costUsd)} · ${seconds(r.durationMs)} · ${plural(r.turns, 'turn')} · ${escape(r.outcome)}`;
      return `<div class="run-line grid4"><p class="meta">Run ${r.run} ${mark(r)} ${escape(r.verdict)}</p><p class="small c2s3 num">${facts}${r.handBacks.length ? `<br>${r.handBacks.map(escape).join('<br>')}` : ''}</p></div>`;
    })
    .join('\n');
  return `<article class="job-row">
<div class="grid4">
<p class="meta">${marks(runs)}<br>${passed}/${runs.length} passed</p>
<h3 class="row-title c2"><a href="${escape(href)}">${escape(first.chore)}</a></h3>
<p class="small c3">${escape(first.prompt)}</p>
<a class="action c4 end" href="${escape(`${href}-r${featured.run}`)}">Open run ${featured.run} ${ARROW}</a>
</div>
${runLines}
</article>`;
};

const METHOD = [
  ['Agent', 'Claude Code runs headless (claude -p) in an empty folder, with jevway as its only MCP server and only its task, look and end tools: no built-in tools, skills or user settings. It is told exactly the prompt shown.'],
  ['Judge', 'A run passes on the app’s own state (Forgejo’s API, the Langfuse prompt page), the calls it recorded and the final answer. The agent’s own status is never the judge.'],
  ['Consent', 'confirm_irreversible counts only for the action and target the request names. A repository deleted that the request did not name stops the suite.'],
];

/**
 * The real-agent suite's report as one self-contained page, in the jobs report's layout: an overview (the pass rate
 * with its 95% CI, the spend, the hand-back and confirm-call totals, every chore as a row with each run's statuses) and
 * one view per chore (`#<chore>`, a run at `#<chore>-r<run>`): each run's browser recording first when it made one,
 * then its transcript of tool calls with their arguments, confirm flags and statuses, then the final answer and how
 * it was judged. Pure: the time shown is the out folder's start time.
 *
 * @example
 * writeFileSync('report.html', renderAgentReport({ rows, totals, model: 'sonnet', outFolder: 'agent-2026-11-01T18-39-09-098Z',
 *   readRun: agentRunReader(outDir) }));
 */
export const renderAgentReport = ({ rows, totals, model, outFolder, readRun }: { rows: ChoreRun[]; totals: Totals; model: string; outFolder?: string; readRun: (dir: string) => AgentRunRecord }) => {
  const chores = [...new Set(rows.map((r) => r.chore))].map((chore) => rows.filter((r) => r.chore === chore));
  const { low, high } = wilson(totals.passed, totals.ran);
  const skipped = rows.filter((r) => r.verdict === 'skipped').length;
  const priced = rows.filter((r) => r.costUsd !== null).map((r) => r.costUsd!).sort((a, b) => a - b);
  const median = priced.length ? priced[Math.floor(priced.length / 2)] : null;
  const counts = [...new Set(chores.map((c) => c.length))];
  const runsEach = counts.length === 1 ? `${plural(counts[0], 'run')} each` : `${Math.min(...counts)}–${Math.max(...counts)} runs each`;
  const title = `Real agent suite: ${plural(chores.length, 'chore')}`;
  const overview = `<section class="view" id="overview" aria-label="Overview">
<div class="wrapper">
<div class="intro grid4"><h1 class="hero c3s2">${plural(chores.length, 'chore')} for Claude Code (${escape(model)}) with only jevway’s tools. ${totals.passed} of ${plural(totals.ran, 'judged run')} passed${skipped ? `; ${skipped} skipped` : ''}.</h1></div>
<div class="figures grid4" aria-label="Totals">
${figure(`${totals.passed}/${totals.ran}`, `judged runs passed · 95% CI ${Math.round(low * 100)}–${Math.round(high * 100)}%`)}
${figure(dollars(totals.costUsd, 2), `Claude spend${median === null ? '' : ` · ${dollars(median)} median run`}${totals.runsOfUnknownCost ? ` · + ${plural(totals.runsOfUnknownCost, 'run')} of unknown cost` : ''}`)}
${figure(String(totals.handBacks), `hand-backs · ${totals.unusableHandBacks} unusable, ${totals.handBacksNeedingReplan} needing a re-plan`)}
${figure(String(totals.confirmCalls), `confirm calls · ${totals.confirmCallsHonoured} honoured, ${totals.confirmCallsIgnored} ignored`)}
</div>
<div class="totals">
<div class="method-row grid4"><p class="meta">Hand-backs</p><p class="small c2s3">${escape(handBackSummary(totals))}</p></div>
<div class="method-row grid4"><p class="meta">Confirm calls</p><p class="small c2s3">${escape(confirmSummary(totals))}</p></div>
${totals.stoppedBecause ? `<div class="method-row grid4"><p class="meta missed">Stopped early</p><p class="small c2s3 missed">${escape(totals.stoppedBecause)}</p></div>` : ''}
</div>
<section class="section" id="chores" aria-labelledby="chores-title">
<div class="section-head grid4"><p class="small c2">Chores<br>${runsEach}</p><h2 class="section-title c3s2" id="chores-title">What the agent was asked to do</h2></div>
${chores.map((runs) => choreRow(runs, readRun)).join('\n')}
</section>
<section class="section" id="method" aria-labelledby="method-title">
<div class="section-head grid4"><p class="small c2">Method<br>How a run is judged</p><h2 class="section-title c3s2" id="method-title">The app’s state, not the agent’s word</h2></div>
${METHOD.map(([label, body]) => `<div class="method-row grid4"><p class="meta">${label}</p><p class="small c2s3">${body}</p></div>`).join('\n')}
</section>
</div>
</section>`;
  const views = chores.map((runs, i) => choreView(runs, i, chores[(i + 1) % chores.length], readRun));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escape(title)}</title>
<meta name="description" content="${escape(`${title}: Claude Code drives jevway over MCP; every run judged by the app's state, with its transcript of tool calls.`)}">
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link rel="stylesheet" href="${FONT_LINK}">
${HEAD_SCRIPT}
<style>${STYLE}${AGENT_STYLE}</style>
</head><body>
<nav class="top" aria-label="Report"><div class="wrapper"><a href="#overview">jevway / verify:agent</a><div class="links"><a href="#chores">Chores</a><a href="#method">Method</a></div></div></nav>
<main>
${overview}
${views.join('\n')}
</main>
<footer><div class="wrapper"><span>Claude Code (${escape(model)}) · jevway over MCP · ${startedAt(outFolder)}</span><span>${outFolder ? `verify/out/${escape(outFolder)}` : 'out folder unknown'}</span></div></footer>
${SCRIPT}
</body></html>
`;
};

const AGENT_STYLE = `
.totals { margin-top: 2.5rem; }
.run-line { margin-top: 1rem; }
.job-row > .run-line:first-of-type { margin-top: 1.5rem; }
.bar-only { margin-top: 2rem; }
.bar-only + .run-head { margin-top: 2.5rem; }
.transcript-head { margin-bottom: 1rem; }
.call .tool { font-size: 0.75rem; text-transform: none; letter-spacing: 0; }
.calls { margin: 0; padding: 0; list-style: none; }
.call { border-top: 1px solid var(--muted); padding-block: 1.25rem; }
.call-body p { font-size: 0.9375rem; line-height: 1.5rem; overflow-wrap: anywhere; }
.call-body .args { display: flex; flex-wrap: wrap; gap: 0.125rem 1.25rem; margin-top: 0.375rem; font-size: 0.8125rem; line-height: 1.25rem; color: var(--muted-foreground); }
.call-body .args .kv, .confirm .kv { font-family: var(--font-mono); font-size: 0.75rem; }
.call-body .confirm { margin-top: 0.375rem; font-size: 0.8125rem; line-height: 1.25rem; }
.call-status { font-size: 0.875rem; line-height: 1.5rem; }
.call-detail { overflow-wrap: anywhere; }
.no-calls { border-top: 1px solid var(--muted); padding-block: 1.25rem; }
.answer { white-space: pre-wrap; }
.transcript + .facts { margin-top: 3rem; }
`;
