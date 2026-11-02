import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Download } from '../../src/browser/downloads.ts';
import { downloadNote, keepDownload, sizeWords } from '../../src/task/downloads.ts';

const folder = (prefix = 'jevway-run-') => mkdtempSync(join(tmpdir(), prefix));

/** A finished download where Chrome left it: under its guid in jevway's staging folder, or by name in the person's own folder. */
const finished = ({ name = 'invoice-1042.pdf', staged = true, bytes = 86016 }: { name?: string; staged?: boolean; bytes?: number } = {}): Download => {
  const where = folder('jevway-downloads-');
  const filePath = join(where, staged ? 'b6c1-guid' : name);
  writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return { guid: 'b6c1-guid', name, url: 'https://shop.example/invoice/1042', state: 'completed', bytes, filePath, staged };
};

describe('a download kept in the run folder', () => {
  it("moves a file out of jevway's staging folder into downloads/, under the name the site gave", () => {
    const run = folder();
    const download = finished();
    const kept = keepDownload(download, run);
    expect(kept).toEqual({ name: 'invoice-1042.pdf', bytes: 86016, state: 'completed', path: join(run, 'downloads', 'invoice-1042.pdf') });
    expect(existsSync(download.filePath!)).toBe(false);
    expect(readFileSync(kept.path!).length).toBe(86016);
  });

  it("copies a file from the person's own Downloads folder, leaving theirs where their Chrome expects it", () => {
    const run = folder();
    const download = finished({ staged: false });
    const kept = keepDownload(download, run);
    expect(kept.path).toBe(join(run, 'downloads', 'invoice-1042.pdf'));
    expect(existsSync(download.filePath!)).toBe(true);
  });

  it('adds a suffix when the name is taken', () => {
    const run = folder();
    keepDownload(finished(), run);
    expect(keepDownload(finished(), run).path).toBe(join(run, 'downloads', 'invoice-1042-2.pdf'));
    expect(keepDownload(finished(), run).path).toBe(join(run, 'downloads', 'invoice-1042-3.pdf'));
  });

  it('never writes outside downloads/, whatever name the site suggests', () => {
    const run = folder();
    expect(keepDownload(finished({ name: '../../.bashrc' }), run).path).toBe(join(run, 'downloads', 'bashrc'));
  });

  it('leaves the file where Chrome saved it when the run keeps no folder', () => {
    const download = finished({ staged: false });
    expect(keepDownload(download, undefined).path).toBe(download.filePath);
  });

  it('reports a cancelled or unfinished download without a file', () => {
    const run = folder();
    const base = { guid: 'g', name: 'big.zip', url: 'https://x.example/big.zip', bytes: 1200, staged: true };
    expect(keepDownload({ ...base, state: 'canceled' }, run)).toEqual({ name: 'big.zip', bytes: 1200, state: 'canceled' });
    expect(keepDownload({ ...base, state: 'inProgress' }, run)).toEqual({ name: 'big.zip', bytes: 1200, state: 'inProgress' });
  });
});

describe('what a step says about its download', () => {
  it.each([
    [512, '512 bytes'],
    [86016, '84 KB'],
    [5 * 1024 * 1024 + 300 * 1024, '5.3 MB'],
  ])('sizes %i as %s', (bytes, words) => {
    expect(sizeWords(bytes)).toBe(words);
  });

  it('names the file and its size, or what became of it', () => {
    expect(downloadNote({ name: 'invoice-1042.pdf', bytes: 86016, state: 'completed', path: '/x' })).toBe('downloaded invoice-1042.pdf, 84 KB');
    expect(downloadNote({ name: 'big.zip', bytes: 1200, state: 'canceled' })).toBe('download of big.zip did not finish');
    expect(downloadNote({ name: 'big.zip', bytes: 1200, state: 'inProgress' })).toBe('download of big.zip still running after 30 s');
  });
});
