import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PageAction, PageState, Tab } from '../browser/tab.ts';
import { escapeHtml } from './recording-page.ts';
import type { TaskSummary } from './run-task.ts';

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
    writeFileSync(join(this.#dir, 'summary.json'), JSON.stringify({ summaries: this.summaries, video, steps: this.steps }, null, 1));
    writeFileSync(join(this.#dir, 'index.html'), renderSteps(this.steps, this.summaries, video));
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

// Clicking a step with a video timestamp seeks the video there.
const SEEK_SCRIPT = `<script>
document.addEventListener('click', (event) => {
  const step = event.target.closest('[data-at]');
  const video = step && document.getElementById(step.dataset.video);
  if (!video) return;
  event.preventDefault();
  video.currentTime = Number(step.dataset.at);
  video.play();
  video.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
</script>`;

export const renderSteps = (steps: RecordedStep[], summaries: TaskSummary[], video: string | null = null, _viewport?: { width: number; height: number }) => {
  const last = summaries.at(-1);
  const requests = summaries.reduce((sum, s) => sum + s.jev.requests, 0);
  const figures = steps
    .map(
      (s, i) => `<figure><figcaption${s.video_at !== undefined && video ? ` data-video="run" data-at="${s.video_at}" title="Play from here"` : ''}>
<b>${i + 1}</b> ${escapeHtml(s.description)}${s.unreachable ? ` <strong class="miss">✘ not reached${(s.attempts ?? 1) > 1 ? ` ×${s.attempts}` : ''}: covered</strong>` : ''}${s.confidence !== undefined ? ` <em>confidence ${s.confidence.toFixed(2)}</em>` : ''}${s.video_at !== undefined && video ? ` <em>▶ ${s.video_at.toFixed(1)} s</em>` : ''}
<small>${escapeHtml(s.url)}</small></figcaption>
<a href="${s.file}"><img src="${s.file}" loading="lazy" alt="Step ${i + 1}: ${escapeHtml(s.description)}"></a></figure>`,
    )
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jevway run</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1400px;padding:16px;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}figure{border-color:#333}}
figure{margin:0 0 28px;border:1px solid #ddd;border-radius:8px;overflow:hidden}
figcaption{padding:10px 14px;overflow-wrap:anywhere}figcaption b{margin-right:8px}figcaption[data-at]{cursor:pointer}
em{font-style:normal;opacity:.65;font-size:13px;margin-left:6px}.miss{color:#c2410c;font-size:13px;margin-left:6px}
small{display:block;opacity:.6;font-size:12px}img,video{display:block;width:100%;height:auto}
video{margin:0 0 28px;border-radius:8px;background:#000}
</style>
<h1>${escapeHtml(last ? `${last.status}: ${last.reason}` : 'jevway run')}</h1>
<p>${steps.length} screenshots · ${requests} Jev requests${video ? ' · click a step to play the video from there' : ' · no video (needs ffmpeg)'}</p>
${video ? `<video id="run" src="${video}" controls muted playsinline></video>` : ''}
${figures}
${SEEK_SCRIPT}
`;
};
