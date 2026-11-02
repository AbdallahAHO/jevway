import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PageAction, PageState, Tab } from '../browser/tab.ts';
import { safeSlug, stepFileName } from '../output/layout.ts';
import type { TaskSummary } from '../task/run-task.ts';
import { describeStep, type StepIntent } from './describe-step.ts';
import { escapeHtml, type Viewport } from './recording-page.ts';
import { renderRunPage, type Asked } from './run-page.ts';

export { describeStep, escapeHtml, type StepIntent };

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

// A step shot's name: the verb and what it acts on, short enough to read in a file list.
const stepWords = ({ operation, element = '', valueKey, fileKey, option }: StepIntent) => {
  switch (operation) {
    case 'CLICK':
    case 'CLICK_AT':
      return `click ${element}`;
    case 'TYPE_TEXT':
      return `type ${valueKey ?? element}`;
    case 'UPLOAD':
      return `upload ${fileKey ?? element}`;
    case 'SELECT':
      return `select ${option ?? element}`;
    case 'PRESS_ENTER':
    case 'PRESS_ESCAPE':
    case 'SCROLL_DOWN':
    case 'SCROLL_UP':
    case 'WAIT':
      return operation.replace('_', ' ');
    default:
      return `finished ${operation}`;
  }
};

/**
 * A human-facing record of a run: a screencast video (`run.mp4`, needs ffmpeg), a sharp screenshot before every
 * executed action with its target outlined and a one-sentence description, the final page, `summary.json`
 * and an `index.html` viewer. Separate from what the model sees.
 *
 * @example
 * const task = new BrowserTask(tab, ask, { goal, output: { dir: 'runs/langfuse', record: true } });
 * await task.run(); // runs/langfuse/run.mp4, steps/01-click-traces.jpg … index.html
 */
export class Recording {
  readonly steps: RecordedStep[] = [];
  readonly summaries: TaskSummary[] = [];
  /** What each call was asked, scrubbed, one per summary. */
  readonly asked: Asked[] = [];
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
    const file = stepFileName(this.steps.length + 1, safeSlug(stepWords(intent), this.#scrub));
    mkdirSync(join(this.#dir, 'steps'), { recursive: true });
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
    this.#remove(this.steps.pop());
  }

  /** The action shot just taken never ran: its target couldn't be reached. Repeats of the same miss fold into one. */
  markUnreachable() {
    const [previous, last] = this.steps.slice(-2);
    if (!last) return;
    if (previous?.unreachable && previous.description === last.description) {
      previous.attempts = (previous.attempts ?? 1) + 1;
      this.#remove(this.steps.pop());
      return;
    }
    last.unreachable = true;
    last.attempts = 1;
  }

  // A shot named for a step that never ran would sit in the folder with no step to explain it.
  #remove(step: RecordedStep | undefined) {
    if (step) rmSync(join(this.#dir, step.file), { force: true });
  }

  // A session can run several times (missing value, confirmation); each run ends with its own final shot,
  // and the video is re-encoded to cover every run so far.
  async finish(tab: Tab, summary: TaskSummary, asked?: { goal: string; doneWhen?: string }) {
    const page = await tab.observe();
    await this.step(tab, page, { operation: summary.status });
    this.steps.at(-1)!.description = `Finished: ${summary.status}. ${summary.reason}`;
    this.summaries.push(summary);
    if (asked) this.asked.push({ goal: this.#scrub(asked.goal), ...(asked.doneWhen && { done_when: this.#scrub(asked.doneWhen) }) });
    await tab.send('Page.stopScreencast').catch(() => undefined);
    this.#stopListening?.();
    this.#stopListening = undefined;
    const video = (await this.#encode()) ?? null;
    const viewport = this.#viewport;
    const record = { summaries: this.summaries, video, steps: this.steps, ...(viewport && { viewport }), ...(this.asked.length && { asked: this.asked }) };
    writeFileSync(join(this.#dir, 'summary.json'), JSON.stringify(record, null, 1));
    writeFileSync(join(this.#dir, 'index.html'), renderRunPage(record));
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
