import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { RecordedStep } from '../../src/recording/recording.ts';
import { clock } from '../../src/recording/recording-page.ts';
import { renderRunPage, type RunRecord } from '../../src/recording/run-page.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import type { TaskStatus, TaskSummary } from '../../src/task/run-task.ts';
import { fakeTab, page as fakePage, scriptedJev } from '../fakes.ts';

// The index.html a recorded run folder holds: what a person opens, and what an agent fetching the folder reads.

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

type SummaryStep = TaskSummary['steps'][number];
const summary = (status: TaskStatus, reason: string, steps: Partial<SummaryStep>[], over: Partial<TaskSummary> = {}): TaskSummary => ({
  status,
  reason,
  url: 'http://app.test/ada/app/issues/4',
  title: 'Crash on save · Issue #4',
  page_text: '',
  elapsed_ms: 2500,
  steps: steps.map((s) => ({ element: '', confidence: 0.9, ...s })) as SummaryStep[],
  jev: { requests: 4, input_tokens: 40_000, median_latency_ms: 350, screenshots: 0, model: 'jev-1.14.0', est_cost_usd: 0.00168 },
  ...over,
});
const step = (n: number, slug: string, operation: string, description: string, video_at?: number, over: Partial<RecordedStep> = {}): RecordedStep => ({
  file: `steps/${String(n).padStart(2, '0')}-${slug}.jpg`,
  operation,
  description,
  confidence: 0.9,
  url: n === 1 ? 'http://app.test/ada/app/issues' : 'http://app.test/ada/app/issues/new',
  at: 1793628000 + n,
  ...(video_at !== undefined && { video_at }),
  ...over,
});

const STEPS = [
  step(1, 'click-new-issue', 'CLICK', 'Click "New issue"', 0.48),
  step(2, 'type-title', 'TYPE_TEXT', 'Type the "title" value into "Title"', 0.91),
  step(3, 'click-save-rule', 'CLICK', 'Click "Save rule"', 1.58, { unreachable: true, attempts: 2 }),
  step(4, 'finished-needs-confirmation', 'needs_confirmation', 'Finished: needs_confirmation. Clicking "Create issue" looks irreversible.', 2.66),
  step(5, 'click-create-issue', 'CLICK', 'Click "Create issue"', 3.14),
  step(6, 'finished-done', 'done', 'Finished: done. Completion condition verified.', 6.76),
];
const SUMMARIES = [
  summary('needs_confirmation', 'Clicking "Create issue" looks irreversible.', [
    { operation: 'CLICK', element: 'New issue' },
    { operation: 'TYPE_TEXT', element: 'Title', value_key: 'title' },
    { operation: 'CLICK', element: 'Save rule', not_executed: 'could not be reached: another layer covers it; close that layer first' },
    { operation: 'DONE', element: '', not_executed: 'rejected: "the issue page" is not visible yet' },
  ]),
  summary('done', 'Completion condition verified.', [{ operation: 'CLICK', element: 'Create issue (new tab opened: http://app.test/ada/app/issues/4)' }]),
];
const ASKED = [
  { goal: 'File the crash as a new issue titled "Crash on save"', done_when: 'The new issue page is open' },
  { goal: 'File the crash as a new issue titled "Crash on save"', done_when: 'The new issue page is open' },
];
const RECORD: RunRecord = { summaries: SUMMARIES, video: 'run.mp4', steps: STEPS, viewport: { width: 1120, height: 780 }, asked: ASKED };
const page = renderRunPage(RECORD);

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = (fragment: string) => fragment.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
const text = (fragment: string) => decode(fragment.replace(/<script\b[\s\S]*?<\/script>/g, ' ').replace(/<style\b[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const headings = (html: string) => [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map(([, level, inner]) => `h${level} ${text(inner).trim()}`);
const embedded = (html: string, id: string) => {
  const match = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html);
  return match ? JSON.parse(match[1]) : undefined;
};
const section = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start));
};
const stepItem = (html: string, n: number) => {
  const match = new RegExp(`<li [^>]*id="s${n}"[\\s\\S]*?</li>`).exec(html);
  return match ? match[0] : '';
};

describe("a run's index.html: the top says what was asked, how it ended and why", () => {
  it('declares its language, a title naming the outcome and the goal, and the generator', () => {
    expect(page).toMatch(/^<!doctype html>\s*<html lang="en"/);
    expect(decode(/<title>([^<]*)<\/title>/.exec(page)![1])).toBe('Done: File the crash as a new issue titled "Crash on save" · jevway run');
    expect(page).toContain(`<meta name="generator" content="jevway ${version}">`);
  });

  it('opens on the goal as the page heading, then the outcome as a plain word with the reason', () => {
    const top = text(page.slice(page.indexOf('<header'), page.indexOf('</header>')));
    expect(headings(page)[0]).toBe('h1 File the crash as a new issue titled "Crash on save"');
    expect(top).toContain('Done when The new issue page is open');
    expect(top).toMatch(/Outcome Done Completion condition verified\./);
  });

  it('says when it ran, how long it took, what it cost, and where it started and ended', () => {
    const top = text(page.slice(page.indexOf('<header'), page.indexOf('</header>')));
    expect(top).toContain('2026-11-02 14:00 UTC');
    expect(top).toContain('5.0 s');
    expect(top).toContain('est. $0.0034');
    expect(top).toContain('2 calls · 3 actions');
    expect(top).toContain('Start page http://app.test/ada/app/issues');
    expect(top).toContain('End page http://app.test/ada/app/issues/4');
  });

  it('keeps its headings in order: one h1, then sections, then calls', () => {
    const levels = headings(page).map((h) => Number(h[1]));
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    levels.forEach((level, i) => expect(level - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1));
    expect(headings(page)).toEqual(expect.arrayContaining(['h2 Recording', 'h2 Steps', 'h2 Details', 'h2 Files', 'h3 Call 1 · needs confirmation', 'h3 Call 2 · done']));
    expect(page).toMatch(/<header[\s\S]*<main[\s\S]*<section id="recording"[\s\S]*<section id="steps"[\s\S]*<footer/);
  });

  it('says so when an old recording kept no goal, without guessing one', () => {
    const old = renderRunPage({ ...RECORD, asked: undefined });
    expect(headings(old)[0]).toBe('h1 Goal not recorded');
    expect(decode(/<title>([^<]*)<\/title>/.exec(old)![1])).toBe('Done · jevway run');
  });

  it('names a later call\'s different goal with that call', () => {
    const changed = renderRunPage({ ...RECORD, asked: [ASKED[0], { goal: 'Now confirm it' }] });
    expect(text(section(changed, 'steps'))).toContain('Asked: Now confirm it');
  });
});

describe('the steps read as the story the agent got', () => {
  it('tells each step as a past-tense sentence, the same as the summary story', () => {
    const steps = text(section(page, 'steps'));
    expect(text(stepItem(page, 1))).toContain('Clicked "New issue".');
    expect(text(stepItem(page, 2))).toContain('Typed the "title" value into "Title".');
    expect(text(stepItem(page, 3))).toContain('Did not click "Save rule": could not be reached: another layer covers it; close that layer first.');
    expect(text(stepItem(page, 5))).toContain('Clicked "Create issue"; a new tab opened: http://app.test/ada/app/issues/4.');
    // A step with no shot (a rejected done) still shows, in its place.
    expect(steps.indexOf('Did not finish yet')).toBeGreaterThan(steps.indexOf('Did not click "Save rule"'));
    expect(steps.indexOf('Did not finish yet')).toBeLessThan(steps.indexOf('Needs confirmation: Clicking "Create issue"'));
  });

  it('ends each call with how it ended', () => {
    expect(text(stepItem(page, 4))).toContain('Needs confirmation: Clicking "Create issue" looks irreversible.');
    expect(text(stepItem(page, 6))).toContain('Done: Completion condition verified.');
  });

  it('links every step to its shot file and its time in the video', () => {
    STEPS.forEach((s, i) => {
      const item = stepItem(page, i + 1);
      expect(item).toContain(`href="${s.file}"`);
      expect(item).toMatch(new RegExp(`<a [^>]*href="#s${i + 1}"[^>]*>${clock(s.video_at!).replace('.', '\\.')}</a>`));
    });
  });

  it('falls back to the recorded wording in the past tense when no summary step matches', () => {
    const lone = renderRunPage({ summaries: [summary('done', 'Ok.', [])], video: null, steps: [step(1, 'scroll-down', 'SCROLL_DOWN', 'Scroll down to reveal more of the page'), step(2, 'finished-done', 'done', 'Finished: done. Ok.')] });
    expect(text(stepItem(lone, 1))).toContain('Scrolled down to reveal more of the page.');
  });

  it('describes each shot in its alt text, and names the shot file on its card', () => {
    expect(page).toContain('alt="Clicked &quot;New issue&quot;."');
    const recording = section(page, 'recording');
    expect(recording).toMatch(/<a [^>]*href="steps\/01-click-new-issue\.jpg"[^>]*>01-click-new-issue\.jpg<\/a>/);
    for (const [, alt] of page.matchAll(/<img [^>]*alt="([^"]*)"/g)) expect(alt.trim()).not.toBe('');
  });
});

describe('the player and deep links', () => {
  it('opens on the video, before the steps and the details', () => {
    expect(page.indexOf('<video src="run.mp4"')).toBeGreaterThan(-1);
    expect(page.indexOf('<video')).toBeLessThan(page.indexOf('<section id="steps"'));
    expect(page.indexOf('<video')).toBeLessThan(page.indexOf('<section id="details"'));
  });

  it('puts one numbered tick per step on the timeline, in video order', () => {
    const ticks = [...page.matchAll(/aria-label="Play from step (\d+)" data-at="([\d.]+)"/g)];
    expect(ticks.map((t) => Number(t[1]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ticks.map((t) => Number(t[2]))).toEqual(STEPS.map((s) => s.video_at));
  });

  it('opens #sN at that step: the script reads the hash and seeks without playing', () => {
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, source]) => source).join('\n');
    expect(scripts).toMatch(/\^s\(\\d\+\)\$/);
    expect(scripts).toContain('seek-step');
  });

  it('shows the first shot without a video, a note, and no timeline; the steps still link their shots', () => {
    const still = renderRunPage({ ...RECORD, video: null, steps: STEPS.map(({ video_at: _, ...s }) => s) });
    expect(still).not.toContain('<video');
    expect(still).toMatch(/<img data-frame src="steps\/01-click-new-issue\.jpg"/);
    expect(still).not.toContain('Play from step');
    expect(text(still)).toContain('No video for this run');
    expect(stepItem(still, 2)).toContain('href="steps/02-type-title.jpg"');
    expect(stepItem(still, 2)).not.toMatch(/\d:\d\d\.\d/);
  });

  it('frames a phone recording in its own aspect', () => {
    const phone = renderRunPage({ ...RECORD, viewport: { width: 393, height: 852 } });
    expect(phone).toMatch(/<div class="screen portrait" style="aspect-ratio:393 \/ 852"/);
    expect(phone).toMatch(/class="strip[^"]*" style="--shot-aspect:393 \/ 852"/);
  });
});

describe('for agents and offline readers', () => {
  it('embeds the recorded summary.json, exactly, as JSON the page never has to be scraped for', () => {
    expect(embedded(page, 'jevway-summary')).toEqual(JSON.parse(JSON.stringify(RECORD)));
  });

  it('keeps the embedded JSON inert even when a page title closes a script', () => {
    const hostile = renderRunPage({ ...RECORD, summaries: [summary('done', 'ok', [], { title: '</script><script>alert(1)</script>' })] });
    expect(embedded(hostile, 'jevway-summary').summaries[0].title).toBe('</script><script>alert(1)</script>');
    expect(hostile).not.toContain('<script>alert(1)');
  });

  it('links the folder\'s files, and every relative link points at a file the folder holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-run-page-'));
    for (const file of [...STEPS.map((s) => s.file), 'run.mp4', 'summary.json', 'manifest.json']) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), 'x');
    }
    const links = [...page.matchAll(/(?:href|src)="([^"#:]+?)"/g)].map(([, path]) => decode(path));
    expect(links).toEqual(expect.arrayContaining(['summary.json', 'manifest.json', 'run.mp4']));
    for (const link of links) expect(existsSync(join(dir, link)), link).toBe(true);
    expect(page).toContain('<link rel="alternate" type="application/json" href="summary.json"');
  });

  it('needs no network font: the system stack is the font, and the web font never blocks the first paint', () => {
    expect(page).not.toContain('preconnect');
    expect(page).toMatch(/<link rel="stylesheet" href="https:\/\/api\.fontshare\.com[^"]*" media="print" onload="this\.media='all'">/);
    expect(page).toMatch(/--font-sans: [^;]*system-ui/);
  });

  it('follows the reader\'s colour scheme, prints without the player, and outlines focus', () => {
    expect(page).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(page).toMatch(/:root\[data-theme="dark"\]/);
    expect(page).toMatch(/@media print \{[\s\S]*\.timeline-scroll[\s\S]*display: none/);
    expect(page).toContain(':focus-visible');
  });

  it('escapes descriptions, reasons and addresses, and keeps the scripts parseable', () => {
    const hostile = renderRunPage({
      summaries: [summary('blocked', `It said <script>alert('reason')</script>`, [{ operation: 'CLICK', element: '<b>bold</b>' }])],
      video: 'run.mp4',
      steps: [step(1, 'click-bold', 'CLICK', 'Click "<b>bold</b>"', 0.2, { url: 'http://app.test/?q="><script>alert(2)</script>' }), step(2, 'finished-blocked', 'blocked', 'Finished: blocked.', 1)],
      asked: [{ goal: 'Find <img src=x onerror=alert(3)>' }],
    });
    expect(hostile).not.toContain('<b>bold</b>');
    expect(hostile).not.toContain('<script>alert');
    expect(hostile).not.toContain('<img src=x');
    const scripts = [...hostile.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, source]) => source);
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    for (const source of scripts) expect(() => new vm.Script(source)).not.toThrow();
  });
});

describe('what each call was asked, as the recording keeps it', () => {
  it('records the goal and done-when per call, and a secret value in them never reaches summary.json or index.html', async () => {
    const TOKEN = 'tok Zq/81x';
    const { ask } = scriptedJev([{ operation: 'BLOCKED' }, { operation: 'DONE' }]);
    const { asTab } = fakeTab([fakePage({ fingerprint: 'a' }), fakePage({ fingerprint: 'b' })]);
    const dir = mkdtempSync(join(tmpdir(), 'jev-asked-'));
    const task = new BrowserTask(asTab, ask, {
      goal: `Paste the token ${TOKEN} into settings`,
      doneWhen: `The page lists ${TOKEN}`,
      values: { token: TOKEN },
      secretKeys: ['token'],
      output: { dir, record: true },
      changeWaitMs: 0,
    });
    await task.run();
    task.update({ goal: 'Save it' });
    await task.run();
    const record = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(record.asked).toEqual([
      { goal: 'Paste the token [secret:token] into settings', done_when: 'The page lists [secret:token]' },
      { goal: 'Save it', done_when: 'The page lists [secret:token]' },
    ]);
    for (const file of ['summary.json', 'index.html']) expect(readFileSync(join(dir, file), 'utf8').toLowerCase()).not.toContain(TOKEN.toLowerCase());
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('Paste the token [secret:token] into settings');
  });
});
