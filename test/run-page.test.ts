import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderSteps, type RecordedStep } from '../src/recording/recording.ts';
import type { TaskStatus, TaskSummary } from '../src/task/run-task.ts';

// The index.html a run's record folder holds: what a CLI or MCP user with record_dir opens.

const summary = (status: TaskStatus, reason: string, actions: number, over: Partial<TaskSummary> = {}): TaskSummary => ({
  status,
  reason,
  url: 'http://app.test/ada/app/issues/4',
  title: 'Crash on save · Issue #4',
  page_text: '',
  elapsed_ms: 2500,
  steps: Array.from({ length: actions }, () => ({ operation: 'CLICK', confidence: 0.9 })) as unknown as TaskSummary['steps'],
  jev: { requests: 4, input_tokens: 40_000, median_latency_ms: 350, screenshots: 0, model: 'jev-1.14.0', est_cost_usd: 0.00168 },
  ...over,
});
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

const STEPS = [
  step(1, 'CLICK', 'Click "New issue"', 0.48),
  step(2, 'TYPE_TEXT', 'Type the "title" value into "Title"', 0.91),
  step(3, 'CLICK', 'Click "Save rule"', 1.58, { unreachable: true, attempts: 2 }),
  step(4, 'needs_confirmation', 'Finished: needs_confirmation. Clicking "Create issue" looks irreversible.', 2.66),
  step(5, 'CLICK', 'Click "Create issue"', 3.14),
  step(6, 'done', 'Finished: done. Completion condition verified.', 6.76),
];
const SUMMARIES = [summary('needs_confirmation', 'Clicking "Create issue" looks irreversible.', 3), summary('done', 'Completion condition verified.', 1)];
const page = renderSteps(STEPS, SUMMARIES, 'run.mp4');

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (fragment: string) => fragment.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]).replace(/\s+/g, ' ');

describe('a run\'s index.html', () => {
  it('opens on the video, before the facts', () => {
    expect(page.indexOf('<video src="run.mp4"')).toBeGreaterThan(-1);
    expect(page.indexOf('<video')).toBeLessThan(page.indexOf('<dl'));
  });

  it('puts the report\'s fonts and tokens on the page', () => {
    expect(page).toContain('api.fontshare.com');
    expect(page).toContain('--muted-foreground');
    expect(page).toMatch(/:root\[data-theme="dark"\]/);
  });

  it('puts one numbered tick per step on the timeline, in video order, with the strip under it', () => {
    const ticks = [...page.matchAll(/aria-label="Play from step (\d+)" data-at="([\d.]+)"/g)];
    expect(ticks.map((t) => Number(t[1]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ticks.map((t) => Number(t[2]))).toEqual(STEPS.map((s) => s.video_at));
    expect(page.indexOf('class="timeline')).toBeLessThan(page.indexOf('class="strip'));
    expect(page).toMatch(/<a [^>]*href="01\.jpg" target="_blank" rel="noopener"[^>]*>Full size<\/a>/);
  });

  it('says how the run ended and lists its facts: calls, reason, address, cost', () => {
    const facts = text(page.slice(page.indexOf('<dl')));
    expect(text(page)).toContain('Finished: done');
    expect(facts).toContain('needs confirmation → done');
    expect(facts).toContain('Completion condition verified.');
    expect(facts).toContain('http://app.test/ada/app/issues/4');
    expect(facts).toContain('Crash on save · Issue #4');
    expect(facts).toMatch(/8 Jev requests · 80\.0k input tokens · 5\.0 s · est\. \$0\.0034/);
    expect(facts).toContain('summary.json');
  });

  it('marks a step whose target was never reached', () => {
    expect(text(page)).toContain('not reached ×2: covered');
  });

  it('reads without JS: nothing on it waits for a script to be shown', () => {
    expect(page).not.toContain("classList.add('js')");
    expect(page).toMatch(/<div class="run player current"/);
  });

  it('shows the first shot without a video, and no timeline', () => {
    const still = renderSteps(STEPS.map(({ video_at: _, ...s }) => s), SUMMARIES, null);
    expect(still).not.toContain('<video');
    expect(still).toMatch(/<img data-frame src="01\.jpg"/);
    expect(still).not.toContain('Play from step');
    expect(text(still)).toContain('No video for this run');
  });

  it('frames a phone recording in its own aspect, and lets an old one take its poster\'s size', () => {
    const phone = renderSteps(STEPS, SUMMARIES, 'run.mp4', { width: 393, height: 852 });
    expect(phone).toMatch(/<div class="screen portrait" style="aspect-ratio:393 \/ 852"/);
    expect(phone).toMatch(/class="strip[^"]*" style="--shot-aspect:393 \/ 852"/);
    expect(page).toMatch(/<div class="screen intrinsic">/);
  });

  it('escapes descriptions, reasons and addresses, and keeps the scripts parseable', () => {
    const hostile = renderSteps(
      [step(1, 'CLICK', 'Click "<b>bold</b>"', 0.2, { url: 'http://app.test/?q="><script>alert(2)</script>' })],
      [summary('blocked', `It said <script>alert('reason')</script>`, 1)],
      'run.mp4',
    );
    expect(hostile).not.toContain('<b>bold</b>');
    expect(hostile).not.toContain('<script>alert');
    const scripts = [...hostile.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(([, source]) => source);
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    for (const source of scripts) expect(() => new vm.Script(source)).not.toThrow();
  });
});
