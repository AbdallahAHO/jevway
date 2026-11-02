import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageAction } from '../../src/browser/tab.ts';
import { readManifest } from '../../src/output/manifest.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { fakeTab, page, scriptedJev } from '../fakes.ts';

const runDir = () => join(mkdtempSync(join(tmpdir(), 'jev-run-')), 'runs', '2026-11-02_0905_open_3f9a');
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name],
  );

describe('a task with a run folder', () => {
  it('keeps the end page, the summary and a manifest on every call, and hands back the screenshot', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    const dir = runDir();
    const task = new BrowserTask(asTab, ask, { goal: 'Open', output: { dir } });
    const summary = await task.run();

    expect(summary.status).toBe('done');
    expect(filesIn(dir).sort()).toEqual(['calls/01-done.jpg', 'final.jpg', 'manifest.json', 'summary.json']);
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).summaries.map((s: { status: string }) => s.status)).toEqual(['done']);
    expect(readManifest(dir).files.map((file) => file.path)).toEqual(['calls/01-done.jpg', 'final.jpg', 'manifest.json', 'summary.json']);
    expect(task.lastCall?.files).toEqual({ run_dir: dir, screenshot: join(dir, 'final.jpg'), manifest: join(dir, 'manifest.json') });
    expect(task.lastCall?.screenshot?.toString()).toBe('final page');
    // A light JPEG for agents: quality 70, scaled so a 1280-wide viewport or wider fits in 1280 pixels.
    expect(tab.finalShots).toEqual([{ format: 'jpeg', quality: 70, scale: 1 }]);
    // No recording asked for: no step shots, no video, no page.
    expect(tab.recorded).toBe(0);
  });

  it('numbers each call\'s end page and keeps every summary as the session goes on', async () => {
    // A BLOCKED with empty fields and no value for them hands back needs_input.
    const { ask } = scriptedJev([{ operation: 'BLOCKED' }, { operation: 'DONE' }]);
    const { asTab } = fakeTab();
    const dir = runDir();
    const task = new BrowserTask(asTab, ask, { goal: 'Open', output: { dir }, changeWaitMs: 0 });
    await task.run();
    task.update({ goal: 'Open it now' });
    await task.run();
    expect(filesIn(dir).filter((file) => file.startsWith('calls/')).sort()).toEqual(['calls/01-needs-input.jpg', 'calls/02-done.jpg']);
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).summaries).toHaveLength(2);
  });

  it('scales a wide or sharp viewport down to 1280 pixels', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([page({ w: 1600 })]);
    tab.pixelRatio = 2;
    await new BrowserTask(asTab, ask, { goal: 'Open', output: { dir: runDir() } }).run();
    expect(tab.finalShots[0].scale).toBe(0.4);
  });

  it('leaves the screenshot out when the capture fails, and the run\'s status stands', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE' }]);
    const { tab, asTab } = fakeTab();
    tab.screenshot = async () => {
      throw new Error('Browser connection closed');
    };
    const dir = runDir();
    const task = new BrowserTask(asTab, ask, { goal: 'Open', output: { dir } });
    expect((await task.run()).status).toBe('done');
    expect(existsSync(join(dir, 'final.jpg'))).toBe(false);
    expect(task.lastCall?.files.screenshot).toBeUndefined();
    expect(task.lastCall?.screenshot).toBeUndefined();
  });

  it('records the steps for people when asked, with names that say what each step does', async () => {
    const { ask } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'CLICK', click_target: '1' },
      { operation: 'DONE' },
    ]);
    const { asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' }), page({ fingerprint: 'c' })]);
    const dir = runDir();
    const task = new BrowserTask(asTab, ask, { goal: 'Book', values: { email: 'ada@example.com' }, output: { dir, record: true }, changeWaitMs: 0 });
    await task.run();
    const steps = filesIn(dir).filter((file) => file.startsWith('steps/')).sort();
    expect(steps).toEqual(['steps/01-type-email.jpg', 'steps/02-click-open-full-name.jpg', 'steps/03-finished-done.jpg']);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('src="steps/01-type-email.jpg"');
    expect(task.lastCall?.files.page).toBe(join(dir, 'index.html'));
    const manifest = readManifest(dir);
    expect(manifest.files.find((file) => file.path === 'steps/01-type-email.jpg')?.description).toBe(
      'Before step 1, its target outlined: Type the "email" value into "Email address"',
    );
  });

  it('takes `recordDir` as a run folder with the recording on, as `record_dir` and `--record` pass it', async () => {
    const { ask } = scriptedJev([{ operation: 'DONE' }]);
    const { asTab } = fakeTab();
    const dir = mkdtempSync(join(tmpdir(), 'jev-record-'));
    await new BrowserTask(asTab, ask, { goal: 'Open', recordDir: dir }).run();
    expect(filesIn(dir).sort()).toEqual(['calls/01-done.jpg', 'final.jpg', 'index.html', 'manifest.json', 'steps/01-finished-done.jpg', 'summary.json']);
  });

  it('never names a step shot after a secret value', async () => {
    const TOKEN = 'ghp_Q9xLm2';
    const copy: PageAction = { id: 'copy', kind: 'click', node: 30, role: 'button', label: `Copy ${TOKEN}` };
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { asTab } = fakeTab([page({ actions: [copy], fingerprint: 'a' }), page({ actions: [copy], fingerprint: 'b' })]);
    const dir = runDir();
    await new BrowserTask(asTab, ask, { goal: 'Copy it', values: { token: TOKEN }, secretKeys: ['token'], output: { dir, record: true } }).run();
    const names = filesIn(dir).join('\n').toLowerCase();
    expect(names).toContain('steps/01-click-copy-secret-token.jpg');
    expect(names).not.toContain('q9xlm2');
  });
});

describe('step events', () => {
  it('tells each step of the call as it happens, numbered from 1, with the page it left on', async () => {
    const { ask } = scriptedJev([
      { operation: 'TYPE_TEXT', type_text_target: '2', value_for_2: 'email' },
      { operation: 'CLICK', click_target: '1' },
      { operation: 'DONE' },
    ]);
    const { asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b', url: 'http://fixture/stays/2' }), page({ fingerprint: 'c', url: 'http://fixture/stays/3' })]);
    const told: { n: number; operation: string; url: string }[] = [];
    const task = new BrowserTask(asTab, ask, { goal: 'Book', values: { email: 'ada@example.com' }, changeWaitMs: 0 });
    const summary = await task.run({ onStep: (step, n, url) => told.push({ n, operation: step.operation, url }) });
    expect(told).toEqual([
      { n: 1, operation: 'TYPE_TEXT', url: 'http://fixture/stays/2' },
      { n: 2, operation: 'CLICK', url: 'http://fixture/stays/3' },
    ]);
    expect(told).toHaveLength(summary.steps.length);

    // A later call numbers its own steps from 1 again.
    const again: number[] = [];
    task.update({ goal: 'Book again' });
    await task.run({ onStep: (_step, n) => again.push(n) });
    expect(again.every((n, i) => n === i + 1)).toBe(true);
  });

  it('a callback that throws never changes the run', async () => {
    const { ask } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { asTab } = fakeTab([page({ fingerprint: 'a' }), page({ fingerprint: 'b' })]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open' }).run({
      onStep: () => {
        throw new Error('listener gone');
      },
    });
    expect(summary.status).toBe('done');
  });
});
