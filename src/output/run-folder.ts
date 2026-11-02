import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { callShotName, ensureOutRoot, lookFolderName, slugify } from './layout.ts';
import { writeManifest } from './manifest.ts';

/** Where a session's files are, as absolute paths: its run folder, the latest end page, and the recording when kept. */
export interface RunFiles {
  run_dir: string;
  /** The page as the latest call ended (JPEG); absent when the capture failed. */
  screenshot?: string;
  /** The recording's `index.html` (with `record`). */
  page?: string;
  /** The recording's `run.mp4` (with `record` and ffmpeg). */
  video?: string;
  manifest: string;
  /** Every file the session's steps downloaded so far (`downloads/`); absent when there are none. */
  downloads?: { path: string; name: string; bytes: number }[];
}

/** The files in `<dir>/downloads/`, by name. */
const downloadsIn = (dir: string) => {
  const folder = join(dir, 'downloads');
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => join(folder, entry.name))
    .sort()
    .map((path) => ({ path, name: path.slice(folder.length + 1), bytes: statSync(path).size }));
};

/**
 * Writes what one call leaves in its run folder: its end page as `calls/NN-<status>.jpg` and `final.jpg` (a failed
 * capture removes an older `final.jpg`, so it never shows another call's page), `summary.json` unless the recording
 * wrote its own, and the manifest. Returns the folder's files.
 *
 * @example
 * writeCall({ dir, call: 2, status: 'done', shot, summaries, recorded: false }) // { run_dir, screenshot: '…/final.jpg', manifest }
 */
export const writeCall = ({
  dir,
  call,
  status,
  shot,
  summaries,
  recorded,
}: {
  dir: string;
  call: number;
  status: string;
  shot: Buffer | undefined;
  summaries: unknown[];
  recorded: boolean;
}): RunFiles => {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const final = join(root, 'final.jpg');
  if (shot) {
    const callShot = join(root, callShotName(call, status));
    mkdirSync(dirname(callShot), { recursive: true });
    writeFileSync(callShot, shot);
    copyFileSync(callShot, final);
  } else rmSync(final, { force: true });
  // A recording that failed before writing its own leaves the folder without one.
  if (!recorded || !existsSync(join(root, 'summary.json'))) writeFileSync(join(root, 'summary.json'), JSON.stringify({ summaries }, null, 1));
  const manifest = writeManifest(root, 'run');
  const page = join(root, 'index.html');
  const video = join(root, 'run.mp4');
  const downloads = downloadsIn(root);
  return {
    run_dir: root,
    ...(shot && { screenshot: final }),
    ...(recorded && existsSync(page) && { page }),
    ...(recorded && existsSync(video) && { video }),
    manifest,
    ...(downloads.length && { downloads }),
  };
};

/**
 * Saves a session look's PDF as `looks/NN-<title>.pdf` in its run folder and refreshes the manifest. Returns its path.
 *
 * @example
 * writeRunPdf({ dir, pdf, title: 'Checkout' }) // '<dir>/looks/01-checkout.pdf'
 */
export const writeRunPdf = ({ dir, pdf, title }: { dir: string; pdf: Buffer; title: string }) => {
  const looks = join(resolve(dir), 'looks');
  mkdirSync(looks, { recursive: true });
  const n = readdirSync(looks).filter((name) => name.endsWith('.pdf')).length + 1;
  const path = join(looks, `${String(n).padStart(2, '0')}-${slugify(title)}.pdf`);
  writeFileSync(path, pdf);
  writeManifest(resolve(dir), 'run');
  return path;
};

/**
 * Saves the PDF of a look with no session as `looks/<stamp>_<host>_<id4>/page.pdf` under the output root. Returns its path.
 *
 * @example
 * writeLookPdf({ root, pdf, url: 'https://stays.example/pricing', at, id }) // '<root>/looks/2026-11-02_0905_stays.example_ab12/page.pdf'
 */
export const writeLookPdf = ({ root, pdf, url, at, id }: { root: string; pdf: Buffer; url: string; at: Date; id: string }) => {
  const host = URL.canParse(url) ? new URL(url).host : '';
  const dir = join(ensureOutRoot(root), 'looks', lookFolderName({ at, host: host || 'page', id }));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'page.pdf');
  writeFileSync(path, pdf);
  return path;
};
