import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type FolderKind = 'run' | 'journey';

export interface ManifestFile {
  /** Relative to the folder, `/`-separated. */
  path: string;
  kind: 'page' | 'summary' | 'video' | 'screenshot' | 'step' | 'screen' | 'journey' | 'manifest' | 'file';
  description: string;
}

export interface Manifest {
  kind: FolderKind;
  files: ManifestFile[];
}

const MANIFEST = 'manifest.json';

/** Every file under `dir`, relative and sorted; dotfiles and dot-folders (`.frames` while encoding) are left out. */
const filesUnder = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name), base) : [relative(base, join(dir, entry.name))]))
    .map((path) => path.split('\\').join('/'))
    .sort();

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** What the folder's own records say about some of its files: step shots from `summary.json`, screens from `journey.json`. */
const notesIn = (dir: string, kind: FolderKind) => {
  const notes = new Map<string, string>();
  if (kind === 'run') {
    const steps: { file?: string; description?: string }[] = readJson(join(dir, 'summary.json'))?.steps ?? [];
    steps.forEach((step, i) => {
      if (!step.file || !step.description) return;
      const finished = step.description.startsWith('Finished:');
      notes.set(step.file, finished ? step.description : `Before step ${i + 1}, its target outlined: ${step.description}`);
    });
  } else {
    const screens: { id: string; type?: string; title?: string; screenshot?: string }[] = readJson(join(dir, 'journey.json'))?.screens ?? [];
    for (const screen of screens) if (screen.screenshot) notes.set(screen.screenshot, `Screen ${screen.id} (${screen.type ?? 'unknown'}): ${screen.title ?? ''}`);
  }
  return notes;
};

/**
 * One file as a manifest line: its kind from its name, and a description from the folder's records where they say more.
 *
 * @example
 * describeFile('calls/02-needs-input.jpg', 'run', new Map()) // { path, kind: 'screenshot', description: 'The page as call 2 ended: needs_input' }
 */
export const describeFile = (path: string, kind: FolderKind, notes: Map<string, string>): ManifestFile => {
  const line = (fileKind: ManifestFile['kind'], description: string): ManifestFile => ({ path, kind: fileKind, description: oneLine(description) });
  const call = /^calls\/(\d+)-(.+)\.jpg$/.exec(path);
  if (path === MANIFEST) return line('manifest', "This list of the folder's files");
  if (path === 'index.html') {
    return kind === 'run'
      ? line('page', 'The run page for people: the video with every step on a timeline, and how each call ended')
      : line('page', 'The journey map viewer: screens, flows and QA findings');
  }
  if (path === 'summary.json') return line('summary', "Each call's summary (status, reason, steps, cost), plus the recorded steps when recorded");
  if (path === 'journey.json') return line('journey', 'The journey map as data: screens, steps, flows and QA findings');
  if (path === 'run.mp4') return line('video', 'Screencast of the whole session (idle stretches shortened)');
  if (path === 'final.jpg') return line('screenshot', 'The page as the latest call ended (viewport, JPEG)');
  if (call) return line('screenshot', `The page as call ${Number(call[1])} ended: ${call[2].replace(/-/g, '_')}`);
  if (path.startsWith('steps/')) return line('step', notes.get(path) ?? 'A recorded step, before its action');
  if (path.startsWith('screens/')) return line('screen', notes.get(path) ?? 'A journey screen');
  return line('file', 'Not described');
};

/** Writes `manifest.json` for what `dir` holds now, itself included. */
export const writeManifest = (dir: string, kind: FolderKind) => {
  const notes = notesIn(dir, kind);
  const paths = [...new Set([...filesUnder(dir), MANIFEST])].sort();
  const manifest: Manifest = { kind, files: paths.map((path) => describeFile(path, kind, notes)) };
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 1));
  return join(dir, MANIFEST);
};

/** Reads a folder's `manifest.json`. */
export const readManifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
