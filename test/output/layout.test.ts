import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrubberFor } from '../../src/jev/secrets.ts';
import {
  callShotName,
  ensureOutRoot,
  folderStamp,
  journeyFolderName,
  outRoot,
  runFolderName,
  screenFileName,
  slugify,
  stepFileName,
} from '../../src/output/layout.ts';
import { readManifest, writeManifest } from '../../src/output/manifest.ts';

const AT = new Date(2026, 10, 2, 9, 5);
const ID = '3f9a71c2-0b8e-4d6a-9c1e-5a2b7d4e8f10';

describe('output root', () => {
  it('is ./.jevway in the working directory unless JEVWAY_OUT_DIR names another', () => {
    expect(outRoot({}, '/work/app')).toBe('/work/app/.jevway');
    expect(outRoot({ JEVWAY_OUT_DIR: 'out/jevway' }, '/work/app')).toBe('/work/app/out/jevway');
    expect(outRoot({ JEVWAY_OUT_DIR: '/var/jevway' }, '/work/app')).toBe('/var/jevway');
  });

  it('gets a .gitignore that ignores everything, written once and never over the owner\'s own', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'jev-out-')), '.jevway');
    ensureOutRoot(root);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('*\n');
    writeFileSync(join(root, '.gitignore'), '*\n!keep/\n');
    ensureOutRoot(root);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('*\n!keep/\n');
  });
});

describe('folder and file names', () => {
  it('names a run by when it started, its goal and its session', () => {
    expect(folderStamp(AT)).toBe('2026-11-02_0905');
    expect(runFolderName({ at: AT, goal: 'Book a stay in Lisbon for 2 guests', id: ID })).toBe(
      '2026-11-02_0905_book-a-stay-in-lisbon-for-2-guests_3f9a',
    );
  });

  it('names a journey by its host', () => {
    expect(journeyFolderName({ at: AT, host: 'en.wikipedia.org', id: ID })).toBe('2026-11-02_0905_en.wikipedia.org_3f9a');
    expect(journeyFolderName({ at: AT, host: '127.0.0.1:3311', id: ID })).toBe('2026-11-02_0905_127.0.0.1-3311_3f9a');
  });

  it('slugs to lowercase ASCII words joined by hyphens, at most 40 characters cut at a word', () => {
    expect(slugify('Réserver à São Paulo — 2 guests!')).toBe('reserver-a-sao-paulo-2-guests');
    expect(slugify('Open the Gödel incompleteness article and copy its first sentence')).toBe('open-the-godel-incompleteness-article');
    expect(slugify('Open the Gödel incompleteness article and copy its first sentence').length).toBeLessThanOrEqual(40);
    expect(slugify('日本語のみ')).toBe('run');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
  });

  it('never puts a secret value in a name: it is scrubbed to its marker first', () => {
    const scrub = scrubberFor({ token: 'ghp_Q9xLm2' }, ['token']);
    const name = runFolderName({ at: AT, goal: 'Paste GHP_Q9XLM2 into Settings', id: ID, scrub });
    expect(name).toBe('2026-11-02_0905_paste-secret-token-into-settings_3f9a');
    expect(name.toLowerCase()).not.toContain('q9xlm2');
  });

  it('numbers step shots, call shots and journey screens so they sort in order', () => {
    expect(stepFileName(1, 'type-destination')).toBe('steps/01-type-destination.jpg');
    expect(stepFileName(12, '')).toBe('steps/12-step.jpg');
    expect(callShotName(2, 'needs_input')).toBe('calls/02-needs-input.jpg');
    expect(screenFileName('s01', 'home')).toBe('screens/s01-home.png');
    expect(screenFileName('s02', 'Search results')).toBe('screens/s02-search-results.png');
  });
});

describe('manifest', () => {
  it('lists every file in a run folder with its relative path, kind and a one-line description', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-manifest-'));
    mkdirSync(join(dir, 'steps'));
    mkdirSync(join(dir, 'calls'));
    for (const file of ['final.jpg', 'calls/01-done.jpg', 'run.mp4', 'index.html', 'steps/01-type-destination.jpg', 'steps/02-finished-done.jpg', 'notes.txt']) {
      writeFileSync(join(dir, file), 'x');
    }
    writeFileSync(
      join(dir, 'summary.json'),
      JSON.stringify({
        summaries: [],
        steps: [
          { file: 'steps/01-type-destination.jpg', description: 'Type the "destination" value into "Destination"' },
          { file: 'steps/02-finished-done.jpg', description: 'Finished: done. Completion condition verified' },
        ],
      }),
    );
    writeManifest(dir, 'run');
    const manifest = readManifest(dir);
    expect(manifest.kind).toBe('run');
    expect(manifest.files.map((file) => file.path)).toEqual([
      'calls/01-done.jpg',
      'final.jpg',
      'index.html',
      'manifest.json',
      'notes.txt',
      'run.mp4',
      'steps/01-type-destination.jpg',
      'steps/02-finished-done.jpg',
      'summary.json',
    ]);
    const byPath = Object.fromEntries(manifest.files.map((file) => [file.path, file]));
    expect(byPath['steps/01-type-destination.jpg']).toEqual({
      path: 'steps/01-type-destination.jpg',
      kind: 'step',
      description: 'Before step 1, its target outlined: Type the "destination" value into "Destination"',
    });
    expect(byPath['steps/02-finished-done.jpg'].description).toBe('Finished: done. Completion condition verified');
    expect(byPath['calls/01-done.jpg']).toMatchObject({ kind: 'screenshot', description: 'The page as call 1 ended: done' });
    expect(byPath['final.jpg']).toMatchObject({ kind: 'screenshot' });
    expect(byPath['run.mp4']).toMatchObject({ kind: 'video' });
    expect(byPath['notes.txt']).toMatchObject({ kind: 'file' });
    for (const file of manifest.files) expect(file.description).not.toContain('\n');
  });

  it('describes a journey\'s screens by their id, type and title', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-manifest-'));
    mkdirSync(join(dir, 'screens'));
    writeFileSync(join(dir, 'screens/s01-home.png'), 'x');
    writeFileSync(join(dir, 'index.html'), 'x');
    writeFileSync(
      join(dir, 'journey.json'),
      JSON.stringify({ screens: [{ id: 's01', type: 'home', title: 'Staylist', screenshot: 'screens/s01-home.png' }] }),
    );
    writeManifest(dir, 'journey');
    const files = readManifest(dir).files;
    expect(files.find((file) => file.path === 'screens/s01-home.png')).toEqual({
      path: 'screens/s01-home.png',
      kind: 'screen',
      description: 'Screen s01 (home): Staylist',
    });
    expect(files.find((file) => file.path === 'journey.json')).toMatchObject({ kind: 'journey' });
    expect(files.find((file) => file.path === 'index.html')?.description).toMatch(/journey map/i);
  });
});
