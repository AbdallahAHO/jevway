import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PageAction, PageState, Tab } from '../browser/tab.ts';
import {
  BASE_STYLE,
  clock,
  dollars,
  escapeHtml,
  fact,
  FONT_LINK,
  playerMarkup,
  plural,
  PLAYER_SCRIPT,
  seconds,
  statusWord,
  thousands,
  type Viewport,
} from './recording-page.ts';
import type { TaskSummary } from '../task/run-task.ts';

/** What Jev is about to do on a screen, in the terms the task loop knows. */
export interface StepIntent {
  operation: string;
  element?: string;
  valueKey?: string;
  option?: string;
  confidence?: number;
}

export interface RecordedStep {
  file: string;
  operation: string;
  /** One plain sentence: what happens next on this screen, or how the run ended. */
  description: string;
  confidence?: number;
  url: string;
  /** Wall clock (epoch seconds) when the shot was taken. */
  at: number;
  /** Where this step sits in `run.mp4`, in seconds. */
  video_at?: number;
  /** Set when the action never ran because its target couldn't be reached; `attempts` counts identical misses. */
  unreachable?: boolean;
  attempts?: number;
}

interface Frame {
  jpeg: string;
  /** Epoch seconds, from the screencast's own clock. */
  at: number;
}

const VIDEO = 'run.mp4';
// The video shows what changed, not how long anyone waited: no frame holds longer than this.
const LONGEST_FRAME_S = 1.5;
const SHORTEST_FRAME_S = 1 / 30;

/**
 * How long each screencast frame stays on screen: until the next one, clamped so idle stretches
 * (a slow request, the agent between calls) don't freeze the video. The last frame holds the longest.
 *
 * @example
 * frameDurations([10, 10.2, 19]) // [0.2, 1.5, 1.5]
 */
export const frameDurations = (times: number[]) =>
  times.map((at, i) =>
    i === times.length - 1 ? LONGEST_FRAME_S : Math.min(LONGEST_FRAME_S, Math.max(SHORTEST_FRAME_S, times[i + 1] - at)),
  );

/** Seconds into the encoded video at which the wall-clock moment `at` appears. */
export const videoOffset = (times: number[], durations: number[], at: number) =>
  times.reduce((offset, time, i) => (time < at ? offset + durations[i] : offset), 0);

// Row labels carry a whole table row; a sentence needs its first words.
const shorten = (label: string, max = 70) => {
  const text = label.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
};

/**
 * A step as one plain sentence for people reading a recording.
 *
 * @example
 * describeStep({ operation: 'TYPE_TEXT', element: 'Search traces', valueKey: 'search_query' })
 * // 'Type the "search_query" value into "Search traces"'
 */
export const describeStep = ({ operation, element = '', valueKey, option }: StepIntent) => {
  const target = `"${shorten(element)}"`;
  switch (operation) {
    case 'CLICK':
      return `Click ${target}`;
    case 'CLICK_AT':
      return `Click the control at ${target} by its on-screen position`;
    case 'TYPE_TEXT':
      return `Type the "${valueKey}" value into ${target}`;
    case 'SELECT':
      return option ? `Choose "${option}" in ${target}` : `Choose an option in ${target}`;
    case 'PRESS_ENTER':
      return `Press Enter in ${target} to submit it`;
    case 'PRESS_ESCAPE':
      return 'Press Escape to close the open menu or popup';
    case 'SCROLL_DOWN':
      return 'Scroll down to reveal more of the page';
    case 'SCROLL_UP':
      return 'Scroll back up';
    case 'WAIT':
      return 'Wait for the page to finish updating';
    default:
      return `${operation} ${target}`;
  }
};

/**
 * A human-facing record of a run: a screencast video (`run.mp4`, needs ffmpeg), a sharp screenshot before every
 * executed action with its target outlined and a one-sentence description, the final page, `summary.json`
 * and an `index.html` viewer. Separate from what the model sees.
 *
 * @example
 * const task = new BrowserTask(tab, ask, { goal, recordDir: 'runs/langfuse' });
 * await task.run(); // runs/langfuse/run.mp4, 01.jpg … index.html
 */
export class Recording {
  readonly steps: RecordedStep[] = [];
  readonly summaries: TaskSummary[] = [];
  #dir: string;
  #frames: Frame[] = [];
  /** The page size the screencast reports (CSS pixels): the run page and the reports shape the video's frame by it. */
  #viewport: Viewport | undefined;
  #stopListening: (() => void) | undefined;
  /** Takes the caller's secret values out of what is written (labels and addresses can echo them); screenshots are pixels and show what the page shows. */
  #scrub: (text: string) => string;

  constructor(dir: string, scrub: (text: string) => string = (text) => text) {
    this.#dir = dir;
    this.#scrub = scrub;
    mkdirSync(dir, { recursive: true });
  }

  /** Starts the screencast; each frame is acknowledged at once, or Chrome stops sending them. */
  async start(tab: Tab) {
    if (this.#stopListening) return;
    this.#stopListening = tab.onEvent((method, params) => {
      if (method !== 'Page.screencastFrame') return;
      this.#frames.push({ jpeg: params.data, at: params.metadata.timestamp });
      const { deviceWidth, deviceHeight } = params.metadata;
      if (!this.#viewport && deviceWidth > 0 && deviceHeight > 0) this.#viewport = { width: Math.round(deviceWidth), height: Math.round(deviceHeight) };
      tab.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
    });
    await tab.send('Page.enable');
    await tab.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 2560, maxHeight: 1600 });
  }

  async step(tab: Tab, page: PageState, intent: StepIntent, target?: PageAction['rect']) {
    const marks = target ? [{ label: intent.operation, rect: target }] : [];
    const file = `${String(this.steps.length + 1).padStart(2, '0')}.jpg`;
    writeFileSync(join(this.#dir, file), Buffer.from(await tab.markedScreenshot(marks, page, { sharp: true }), 'base64'));
    this.steps.push({
      file,
      operation: intent.operation,
      description: this.#scrub(describeStep(intent)),
      ...(intent.confidence !== undefined && { confidence: intent.confidence }),
      url: this.#scrub(page.url),
      at: Date.now() / 1000,
    });
  }

  /** The action shot just taken never ran (the page moved first); the retry takes its place. */
  discardLast() {
    this.steps.pop();
  }

  /** The action shot just taken never ran: its target couldn't be reached. Repeats of the same miss fold into one. */
  markUnreachable() {
    const [previous, last] = this.steps.slice(-2);
    if (!last) return;
    if (previous?.unreachable && previous.description === last.description) {
      previous.attempts = (previous.attempts ?? 1) + 1;
      this.steps.pop();
      return;
    }
    last.unreachable = true;
    last.attempts = 1;
  }

  // A session can run several times (missing value, confirmation); each run ends with its own final shot,
  // and the video is re-encoded to cover every run so far.
  async finish(tab: Tab, summary: TaskSummary) {
    const page = await tab.observe();
    await this.step(tab, page, { operation: summary.status });
    this.steps.at(-1)!.description = `Finished: ${summary.status}. ${summary.reason}`;
    this.summaries.push(summary);
    await tab.send('Page.stopScreencast').catch(() => undefined);
    this.#stopListening?.();
    this.#stopListening = undefined;
    const video = (await this.#encode()) ?? null;
    const viewport = this.#viewport;
    writeFileSync(join(this.#dir, 'summary.json'), JSON.stringify({ summaries: this.summaries, video, steps: this.steps, ...(viewport && { viewport }) }, null, 1));
    writeFileSync(join(this.#dir, 'index.html'), renderSteps(this.steps, this.summaries, video, viewport));
  }

  // Frames → H.264 through ffmpeg's concat list, each frame held for its duration. Without ffmpeg: no video.
  async #encode(): Promise<string | undefined> {
    if (!this.#frames.length) return undefined;
    const framesDir = join(this.#dir, '.frames');
    mkdirSync(framesDir, { recursive: true });
    try {
      const times = this.#frames.map((f) => f.at);
      const durations = frameDurations(times);
      const list = this.#frames.map((frame, i) => {
        const file = join(framesDir, `${String(i).padStart(5, '0')}.jpg`);
        writeFileSync(file, Buffer.from(frame.jpeg, 'base64'));
        return `file '${file}'\nduration ${durations[i].toFixed(3)}`;
      });
      // The concat demuxer ignores the last entry's duration unless that file is listed once more.
      writeFileSync(join(framesDir, 'list.txt'), `${list.join('\n')}\n${list.at(-1)!.split('\n')[0]}\n`);
      await promisify(execFile)('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(framesDir, 'list.txt'),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-r', '30',
        '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', join(this.#dir, VIDEO),
      ]);
      for (const step of this.steps) step.video_at = Number(videoOffset(times, durations, step.at).toFixed(2));
      return VIDEO;
    } catch {
      return undefined;
    } finally {
      rmSync(framesDir, { recursive: true, force: true });
    }
  }
}

export { escapeHtml };

// What a run's calls cost, summed: requests, input tokens, time, and the estimate unless a call has none.
const costLine = (summaries: TaskSummary[]) => {
  const sum = (pick: (s: TaskSummary) => number) => summaries.reduce((total, s) => total + pick(s), 0);
  const cost = summaries.reduce<number | null>((total, s) => (total === null || s.jev.est_cost_usd == null ? null : total + s.jev.est_cost_usd), 0);
  return `${plural(sum((s) => s.jev.requests), 'Jev request')} · ${thousands(sum((s) => s.jev.input_tokens))} input tokens · ${seconds(sum((s) => s.elapsed_ms))} · ${cost === null ? 'est. cost unknown' : `est. ${dollars(cost)}`}`;
};

// epoch seconds → "2026-11-01 18:39 UTC"
const recordedAt = (at: number) => `${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * A run's own page (`index.html` in its record folder), in the reports' layout: how it ended, then the screencast with
 * its steps on a timeline and a strip kept in sync, then the facts. One self-contained file next to its shots and
 * video; it reads without JS (the script only syncs the player).
 *
 * @example
 * writeFileSync('runs/a/index.html', renderSteps(steps, summaries, 'run.mp4', { width: 1120, height: 780 }));
 */
export const renderSteps = (steps: RecordedStep[], summaries: TaskSummary[], video: string | null = null, viewport?: Viewport) => {
  const last = summaries.at(-1);
  const ending = last ? `Finished: ${statusWord(last.status)}` : 'jevway run';
  const actions = summaries.reduce((total, s) => total + s.steps.length, 0);
  const bar = `<div class="player-bar grid4"><p class="meta c1s3">${plural(steps.length, 'step')}${video ? ' · pick one to play from there' : ''}</p><span class="meta clock c4 end">${video ? clock(0) : ''}</span></div>`;
  const player = steps.length
    ? playerMarkup({ dir: '', video, steps, label: 'this run', featured: true, viewport, bar, preload: 'metadata' })
    : '<div class="screen quiet"><p class="small">No step was recorded.</p></div>';
  const facts = [
    ...(summaries.length ? [fact('Calls', `${escapeHtml(summaries.map((s) => statusWord(s.status)).join(' → '))} · ${plural(actions, 'action')}`)] : []),
    ...(last ? [fact('Final reason', escapeHtml(last.reason)), fact('Final address', `<span class="address">${escapeHtml(last.url)}</span>`), fact('Page title', escapeHtml(last.title))] : []),
    ...(summaries.length ? [fact('Cost', `<span class="num">${costLine(summaries)}</span>`)] : []),
    fact('Files', `<a href="summary.json">summary.json</a>${video ? ` · <a href="${escapeHtml(video)}">${escapeHtml(video)}</a>` : ''}`),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(`jevway run: ${last ? statusWord(last.status) : 'recorded'}`)}</title>
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link rel="stylesheet" href="${FONT_LINK}">
<style>${BASE_STYLE}
.run-page { padding-bottom: 4rem; }
.run-page .facts { margin-top: 4rem; }
</style>
</head><body>
<main class="wrapper run-page">
<header class="job-head grid4">
<p class="meta">jevway run<br>${steps.length ? recordedAt(steps[0].at) : ''}</p>
<h1 class="job-title c2s2">${escapeHtml(ending)}</h1>
<p class="meta c4 end">${plural(summaries.length, 'call')} · ${plural(actions, 'action')}</p>
${last ? `<p class="small story c2s2">${escapeHtml(last.reason)}</p>` : ''}
</header>
<div class="run player current">
${player}
</div>
<dl class="facts">${facts.join('\n')}</dl>
</main>
<footer><div class="wrapper"><span>Recorded by jevway for people to read; the model never sees these shots.</span><span>${plural(steps.length, 'step')}${video ? ` · ${escapeHtml(video)}` : ' · no video (needs ffmpeg)'}</span></div></footer>
${PLAYER_SCRIPT}
</body></html>
`;
};
