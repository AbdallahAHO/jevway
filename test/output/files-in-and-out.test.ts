import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookFolderName, safeFileName, uniqueFileName } from '../../src/output/layout.ts';
import { describeFile, readManifest } from '../../src/output/manifest.ts';
import { writeCall, writeLookPdf, writeRunPdf } from '../../src/output/run-folder.ts';

const AT = new Date(2026, 10, 2, 9, 5);
const folder = () => mkdtempSync(join(tmpdir(), 'jevway-files-'));

describe('file names from outside', () => {
  it.each([
    ['invoice-1042.pdf', 'invoice-1042.pdf'],
    ['../../.ssh/config', 'config'],
    ['..\\..\\boot.ini', 'boot.ini'],
    ['.env', 'env'],
    ['a\u0000b:c?.txt', 'a_b_c_.txt'],
    ['', 'cv'],
    ['...', 'cv'],
  ])('makes %j a plain name in one folder: %j', (name, safe) => {
    expect(safeFileName(name, 'cv')).toBe(safe);
  });

  it('cuts a long name, keeping its extension', () => {
    const safe = safeFileName(`${'a'.repeat(300)}.pdf`, 'cv');
    expect(safe.length).toBeLessThanOrEqual(120);
    expect(safe.endsWith('.pdf')).toBe(true);
  });

  it('finds a free name with a numbered suffix', () => {
    const dir = folder();
    expect(uniqueFileName(dir, 'cv.pdf')).toBe(join(dir, 'cv.pdf'));
    writeFileSync(join(dir, 'cv.pdf'), '1');
    writeFileSync(join(dir, 'cv-2.pdf'), '2');
    expect(uniqueFileName(dir, 'cv.pdf')).toBe(join(dir, 'cv-3.pdf'));
    writeFileSync(join(dir, 'README'), '1');
    expect(uniqueFileName(dir, 'README')).toBe(join(dir, 'README-2'));
  });

  it('names a look folder by time and host', () => {
    expect(lookFolderName({ at: AT, host: 'localhost:4321', id: 'ab12cd' })).toBe('2026-11-02_0905_localhost-4321_ab12');
  });
});

describe('the manifest describes files in and out', () => {
  it.each([
    ['downloads/invoice-1042.pdf', 'download', 'Downloaded by a step of the run: invoice-1042.pdf'],
    ['uploads/cv.pdf', 'upload', 'Fetched from a URL the caller gave in files, then uploaded: cv.pdf'],
    ['looks/01-checkout.pdf', 'pdf', 'The page as a PDF, from a look: looks/01-checkout.pdf'],
  ])('%s is a %s', (path, kind, description) => {
    expect(describeFile(path, 'run', new Map())).toEqual({ path, kind, description });
  });
});

describe('a call lists the downloads in its run folder', () => {
  it('as absolute paths with names and sizes, and none when there are none', () => {
    const dir = folder();
    const call = (n: number) => writeCall({ dir, call: n, status: 'done', shot: undefined, summaries: [], recorded: false });
    expect(call(1).downloads).toBeUndefined();
    mkdirSync(join(dir, 'downloads'));
    writeFileSync(join(dir, 'downloads', 'invoice-1042.pdf'), Buffer.alloc(86016));
    const files = call(2);
    expect(files.downloads).toEqual([{ path: join(dir, 'downloads', 'invoice-1042.pdf'), name: 'invoice-1042.pdf', bytes: 86016 }]);
    expect(readManifest(dir).files.find((file) => file.path === 'downloads/invoice-1042.pdf')?.kind).toBe('download');
  });
});

describe('a PDF of the page', () => {
  const PDF = Buffer.from('%PDF-1.4 page');

  it("goes into the session's run folder as looks/NN-<title>.pdf, numbered, and into its manifest", () => {
    const dir = folder();
    const first = writeRunPdf({ dir, pdf: PDF, title: 'Checkout — Staylist' });
    const second = writeRunPdf({ dir, pdf: PDF, title: 'Checkout — Staylist' });
    expect(first).toBe(join(dir, 'looks', '01-checkout-staylist.pdf'));
    expect(second).toBe(join(dir, 'looks', '02-checkout-staylist.pdf'));
    expect(readFileSync(first)).toEqual(PDF);
    expect(readManifest(dir).files.filter((file) => file.kind === 'pdf')).toHaveLength(2);
  });

  it("goes into a look's own folder under the output root when there is no session", () => {
    const root = folder();
    const path = writeLookPdf({ root, pdf: PDF, url: 'http://localhost:4321/docs', at: AT, id: 'ab12cd' });
    expect(path).toBe(join(root, 'looks', '2026-11-02_0905_localhost-4321_ab12', 'page.pdf'));
    expect(readFileSync(path)).toEqual(PDF);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('*\n');
  });
});
