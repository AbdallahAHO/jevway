import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { callShotName } from './layout.ts';
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
}

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
  return {
    run_dir: root,
    ...(shot && { screenshot: final }),
    ...(recorded && existsSync(page) && { page }),
    ...(recorded && existsSync(video) && { video }),
    manifest,
  };
};
