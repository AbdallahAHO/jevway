import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Download } from '../../src/browser/downloads.ts';
import type { PageAction } from '../../src/browser/tab.ts';
import { readManifest } from '../../src/output/manifest.ts';
import { storyOf } from '../../src/task/present.ts';
import { BrowserTask } from '../../src/task/run-task.ts';
import { fakeTab, page, scriptedJev } from '../fakes.ts';

const DOWNLOAD_LINK: PageAction = { id: 'e1', kind: 'click', node: 1, role: 'link', label: 'Download invoice 1042' };
const invoicePage = (fingerprint: string) => page({ url: 'http://fixture/orders/1042', title: 'Order 1042', text: 'Order 1042', actions: [DOWNLOAD_LINK], fingerprint });

/** A finished download in jevway's staging folder, as a launched browser leaves it. */
const stagedInvoice = (): Download => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'jevway-downloads-')), 'b6c1-guid');
  writeFileSync(filePath, Buffer.alloc(86016, 1));
  return { guid: 'b6c1-guid', name: 'invoice-1042.pdf', url: 'http://fixture/orders/1042/invoice', state: 'completed', bytes: 86016, filePath, staged: true };
};

describe('a download a step started', () => {
  it('lands in the run folder, is told in the story and the files, and leads the page text Jev reads next', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { tab, asTab } = fakeTab([invoicePage('a'), invoicePage('a')]);
    const download = stagedInvoice();
    tab.downloadOnAct = download;
    const dir = join(mkdtempSync(join(tmpdir(), 'jevway-run-')), 'run');
    const task = new BrowserTask(asTab, ask, { goal: 'Download the invoice for order 1042', output: { dir }, changeWaitMs: 0 });
    const summary = await task.run();

    const kept = join(dir, 'downloads', 'invoice-1042.pdf');
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(download.filePath!)).toBe(false);
    expect(summary.steps[0].element).toBe('Download invoice 1042 (downloaded invoice-1042.pdf, 84 KB)');
    expect(storyOf(summary.steps)[0]).toBe('Clicked "Download invoice 1042"; downloaded invoice-1042.pdf (84 KB).');
    expect(requests[1].state.page.text.split('\n')[0]).toBe('[Downloaded this call] invoice-1042.pdf (84 KB)');
    expect(task.lastCall?.files.downloads).toEqual([{ path: kept, name: 'invoice-1042.pdf', bytes: 86016 }]);
    expect(readManifest(dir).files.find((file) => file.path === 'downloads/invoice-1042.pdf')?.kind).toBe('download');
  });

  it('changes nothing in a run that downloads nothing', async () => {
    const { ask, requests } = scriptedJev([{ operation: 'CLICK', click_target: '1' }, { operation: 'DONE' }]);
    const { asTab } = fakeTab([invoicePage('a'), invoicePage('b')]);
    const summary = await new BrowserTask(asTab, ask, { goal: 'Open the order', changeWaitMs: 0 }).run();
    expect(summary.steps[0].element).toBe('Download invoice 1042');
    expect(requests[1].state.page.text).toBe('Order 1042');
  });
});
