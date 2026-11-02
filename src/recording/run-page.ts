// A recorded run's own page (`index.html` in its folder): what was asked, how it ended and why, the screencast, and
// every step told as the summary's story with its shot and its time in the video. One self-contained file; it reads
// without JS (the script only syncs the player) and carries its `summary.json` for agents.
import type { TaskSummary } from '../task/run-task.ts';
import {
  BASE_STYLE,
  clock,
  dollars,
  embeddedJson,
  escapeHtml as escape,
  fact,
  FONT_STYLESHEET,
  GENERATOR_META,
  indexLabel,
  JEVWAY_VERSION,
  pathOf,
  playerMarkup,
  plural,
  PLAYER_SCRIPT,
  seconds,
  sentencesOf,
  statusLabel,
  statusTone,
  statusWord,
  storyOfRecording,
  thousands,
  type CallStory,
  type Viewport,
} from './recording-page.ts';
import type { RecordedStep } from './recording.ts';

/** What one call was asked, as the recording keeps it (scrubbed). */
export interface Asked {
  goal: string;
  done_when?: string;
}

/** A recorded run folder's `summary.json`: `asked` is absent in folders recorded before it was kept. */
export interface RunRecord {
  summaries: TaskSummary[];
  video: string | null;
  steps: RecordedStep[];
  viewport?: Viewport;
  asked?: Asked[];
}

const total = (summaries: TaskSummary[], pick: (s: TaskSummary) => number) => summaries.reduce((sum, s) => sum + pick(s), 0);
// Unknown when any call has no estimate (a model without a published rate).
const estimatedCost = (summaries: TaskSummary[]) =>
  summaries.reduce<number | null>((sum, s) => (sum === null || s.jev.est_cost_usd == null ? null : sum + s.jev.est_cost_usd), 0);

// epoch seconds → "2026-11-01 18:39 UTC"
const utc = (at: number) => `${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const RUN_STYLE = `
.run-top { padding-block: 2.5rem 0; display: grid; gap: 1.75rem; }
.run-top .label { padding-top: 0.5rem; }
.done-when { margin-top: 0.75rem; }
.outcome-line { font-size: 1.125rem; line-height: 1.625rem; overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 500; margin-right: 0.5rem; }
.status::before { content: ""; flex: none; width: 0.625rem; height: 0.625rem; border-radius: 99px; background: var(--muted-foreground); }
.status.held::before { background: var(--held); } .status.reached::before { background: var(--reached); } .status.missed::before { background: var(--missed); }
.glance { border-top: 1px solid var(--muted); padding-top: 1.25rem; grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 1.25rem; }
@media (min-width: 64rem) { .glance { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.glance dt { margin-bottom: 0.25rem; }
.glance dd { font-size: 1.125rem; line-height: 1.5rem; font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.glance dd .small { display: block; font-weight: 400; }
.run-top .facts .fact { padding-block: 0.875rem; }
.block { margin-top: 4rem; }
.block-head { margin-bottom: 1.5rem; }
#recording .screen { margin-top: 0; }
.call + .call { margin-top: 1.5rem; }
.call-head { padding-top: 0.875rem; }
.call-asked { margin-top: 0.25rem; }
.story { border-bottom: 1px solid var(--muted); }
.entry { display: grid; grid-template-columns: 2.25rem minmax(0, 1fr); gap: 0.125rem 0.75rem; padding: 0.875rem 0.75rem 0.875rem 0.5rem; border-top: 1px solid var(--muted); scroll-margin-top: 4rem; }
.entry .n { padding-top: 0.2rem; }
.entry .sentence { font-size: 1rem; line-height: 1.5rem; overflow-wrap: anywhere; }
.entry .links { grid-column: 2; display: flex; flex-wrap: wrap; gap: 0.125rem 1rem; font-size: 0.75rem; line-height: 1.25rem; color: var(--muted-foreground); }
.entry .links > * { min-width: 0; }
.entry .where { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry .links a { text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 3px; }
.entry .links a:hover { color: var(--foreground); text-decoration-color: currentColor; }
.entry.unshot .sentence { color: var(--muted-foreground); }
.entry.ended .sentence { font-weight: 500; }
.entry:target, .entry[aria-current="step"] { box-shadow: inset 2px 0 0 var(--foreground); background: color-mix(in oklch, var(--muted) 35%, transparent); }
.entry[aria-current="step"] .n { color: var(--foreground); }
.files dt { text-transform: none; letter-spacing: 0; font-family: var(--font-mono); }
.files dd a { text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 3px; }
.run-page { padding-bottom: 4rem; }
`;

/** One line of a call's story: its number and sentence, then its time in the video, its shot file and its address. */
const storyEntry = ({ sentence, shot }: CallStory['entries'][number], steps: RecordedStep[], video: string | null) => {
  if (shot === undefined) return `<li class="entry unshot"><span class="n meta num" aria-hidden="true">·</span><p class="sentence">${escape(sentence)}</p></li>`;
  const step = steps[shot];
  const id = `s${shot + 1}`;
  const name = step.file.split('/').pop()!;
  const links = [
    ...(video && step.video_at !== undefined ? [`<a class="at num" data-seek="${shot}" href="#${id}" aria-label="Play from step ${shot + 1}, at ${clock(step.video_at)}">${clock(step.video_at)}</a>`] : []),
    `<a href="${escape(step.file)}">${escape(name)}</a>`,
    `<span class="where">${escape(pathOf(step.url))}</span>`,
  ];
  const ended = step.operation === step.operation.toLowerCase();
  return `<li class="entry${ended ? ' ended' : ''}" id="${id}" data-shot="${shot}"><span class="n meta num">${indexLabel(shot)}</span><p class="sentence">${escape(sentence)}</p><p class="links">${links.join('')}</p></li>`;
};

const callStories = (stories: CallStory[], record: RunRecord) => {
  const several = stories.length > 1;
  return stories
    .map((story, n) => {
      const asked = record.asked?.[n];
      const before = record.asked?.[n - 1];
      const differs = n > 0 && asked && before && (asked.goal !== before.goal || asked.done_when !== before.done_when);
      const status = story.status ?? record.summaries[n]?.status;
      const head = several ? `<h3 class="meta">Call ${n + 1}${status ? ` · ${escape(statusWord(status))}` : ''}</h3>` : '';
      return `<div class="call grid4"><div class="call-head">${head}${differs ? `<p class="small call-asked">Asked: ${escape(asked.goal)}${asked.done_when ? `<br>Done when: ${escape(asked.done_when)}` : ''}</p>` : ''}</div><ol class="story c2s3">${story.entries.map((entry) => storyEntry(entry, record.steps, record.video)).join('')}</ol></div>`;
    })
    .join('\n');
};

/**
 * The page for a recorded run folder, from its `summary.json` record. The top says what was asked, how the run ended
 * and why, when, how long, what it cost, and where it started and ended; then the screencast (or the first shot); then
 * each call's story, every step linking its shot file and its video time (`#s<n>`, also a deep link); then the
 * details and the folder's files. The record itself is embedded as `#jevway-summary`.
 *
 * @example
 * writeFileSync('runs/a/index.html', renderRunPage(JSON.parse(readFileSync('runs/a/summary.json', 'utf8'))));
 */
export const renderRunPage = (record: RunRecord) => {
  const { summaries, steps, video, viewport } = record;
  const last = summaries.at(-1);
  const goal = record.asked?.[0]?.goal;
  const doneWhen = record.asked?.[0]?.done_when;
  // Actions that ran: a step told back to Jev as not done (`not_executed`) is in the story, not in the count.
  const actions = total(summaries, (s) => s.steps.filter((step) => !step.not_executed).length);
  const cost = estimatedCost(summaries);
  const stories = storyOfRecording(steps, summaries);
  const outcome = last ? statusLabel(last.status) : 'Recorded';
  const title = `${outcome}${goal ? `: ${goal}` : ''} · jevway run`;

  const bar = `<div class="player-bar grid4"><p class="meta c1s3">${plural(steps.length, 'step')}${video ? ' · pick one to play from there' : ''}</p><span class="meta clock c4 end">${video ? clock(0) : ''}</span></div>`;
  const player = steps.length
    ? playerMarkup({ dir: '', video, steps, label: 'this run', featured: true, viewport, bar, preload: 'metadata', sentences: sentencesOf(stories) })
    : '<div class="screen quiet"><p class="small">No step was recorded.</p></div>';

  const glance = [
    ['Started', steps.length ? utc(steps[0].at) : 'unknown'],
    ['Took', summaries.length ? seconds(total(summaries, (s) => s.elapsed_ms)) : 'unknown'],
    ['Cost', `${cost === null ? 'est. cost unknown' : `est. ${dollars(cost)}`}<span class="small">${plural(total(summaries, (s) => s.jev.requests), 'Jev request')}</span>`],
    ['Steps', `${plural(summaries.length, 'call')} · ${plural(actions, 'action')}`],
  ];
  const header = `<header class="wrapper run-top">
<div class="grid4"><p class="meta label">Asked</p><div class="c2s3"><h1 class="job-title">${goal ? escape(goal) : 'Goal not recorded'}</h1>${
    doneWhen ? `<p class="small done-when"><span class="kv">Done when</span> ${escape(doneWhen)}</p>` : ''
  }${goal ? '' : '<p class="small done-when">This run was recorded before jevway kept the goal in its folder.</p>'}</div></div>
<div class="grid4"><p class="meta label">Outcome</p><p class="c2s3 outcome-line">${
    last ? `<span class="status ${statusTone(last.status)}">${escape(outcome)}</span> ${escape(last.reason)}` : 'No call finished.'
  }</p></div>
<dl class="glance grid4">${glance.map(([label, value]) => `<div><dt class="meta">${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
<dl class="facts">${[
    ...(steps.length ? [fact('Start page', `<span class="address">${escape(steps[0].url)}</span>`)] : []),
    ...(last ? [fact('End page', `<span class="address">${escape(last.url)}</span>${last.title ? ` · ${escape(last.title)}` : ''}`)] : []),
  ].join('\n')}</dl>
</header>`;

  const details = [
    ...(summaries.length ? [fact('Calls', `${escape(summaries.map((s) => statusWord(s.status)).join(' → '))} · ${plural(actions, 'action')}`)] : []),
    ...(last ? [fact('Final page', `${escape(last.title)}<br><span class="address">${escape(last.url)}</span>`)] : []),
    ...(summaries.length
      ? [fact('Cost', `<span class="num">${plural(total(summaries, (s) => s.jev.requests), 'Jev request')} · ${thousands(total(summaries, (s) => s.jev.input_tokens))} input tokens · ${seconds(total(summaries, (s) => s.elapsed_ms))} · ${cost === null ? 'est. cost unknown' : `est. ${dollars(cost)}`}</span>`)]
      : []),
    ...(last?.jev.model ? [fact('Model', escape(last.jev.model))] : []),
    ...(viewport ? [fact('Viewport', `<span class="num">${viewport.width} × ${viewport.height}</span> CSS pixels`)] : []),
  ];
  const files = [
    fact('<a href="summary.json">summary.json</a>', "Each call's summary and the recorded steps: the same data this page embeds as <code>#jevway-summary</code>"),
    fact('<a href="manifest.json">manifest.json</a>', 'Every file in this folder, with what it is'),
    ...(video ? [fact(`<a href="${escape(video)}">${escape(video)}</a>`, 'Screencast of the whole session, idle stretches shortened')] : []),
    fact('steps/', `${plural(steps.length, 'shot')}: one before each action, its target outlined, and one as each call ended; each step above links its own`),
  ];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escape(title)}</title>
<meta name="description" content="${escape(`${goal ?? 'A jevway run'}: ${outcome.toLowerCase()}${last ? `. ${last.reason}` : ''}`)}">
${GENERATOR_META}
<meta name="color-scheme" content="light dark">
<link rel="alternate" type="application/json" href="summary.json" title="This run as data">
${FONT_STYLESHEET}
<style>${BASE_STYLE}${RUN_STYLE}</style>
</head><body>
<nav class="top" aria-label="This page"><div class="wrapper"><span>jevway · run</span><div class="links"><a href="#steps">Steps</a><a href="#details">Details</a><a href="#files">Files</a></div></div></nav>
${header}
<main class="wrapper run-page">
<div class="run player current" data-step-links>
<section id="recording" class="block" aria-labelledby="recording-title"><h2 class="block-head meta" id="recording-title">Recording</h2>
${player}
</section>
<section id="steps" class="block" aria-labelledby="steps-title"><h2 class="section-title block-head" id="steps-title">Steps</h2>
${callStories(stories, record)}
</section>
</div>
<section id="details" class="block" aria-labelledby="details-title"><h2 class="section-title block-head" id="details-title">Details</h2><dl class="facts">${details.join('\n')}</dl></section>
<section id="files" class="block" aria-labelledby="files-title"><h2 class="section-title block-head" id="files-title">Files</h2><dl class="facts files">${files.join('\n')}</dl></section>
</main>
<footer><div class="wrapper"><span>Recorded by jevway ${escape(JEVWAY_VERSION)} for people to read; the model never sees these shots.</span><span>${plural(steps.length, 'step')}${video ? ` · ${escape(video)}` : ' · no video (recording one needs ffmpeg)'}</span></div></footer>
${embeddedJson('jevway-summary', record)}
${PLAYER_SCRIPT}
</body></html>
`;
};
