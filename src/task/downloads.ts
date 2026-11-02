import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Download } from '../browser/downloads.ts';
import { safeFileName, uniqueFileName } from '../output/layout.ts';

/** A download as the run reports it: where its file is now (completed only), its size, and how it ended. */
export interface KeptDownload {
  name: string;
  bytes: number;
  state: Download['state'];
  path?: string;
}

/**
 * Puts a finished download into `<dir>/downloads/` under the site's name made safe (`-2`, `-3` on a collision): moved
 * out of jevway's staging folder, copied from the person's own folder so their Chrome still finds it. Without a run
 * folder, or for a download that did not complete, the file stays where it is.
 *
 * @example
 * keepDownload(download, '/runs/2026-11-02_0905_invoice_3f9a') // { name: 'invoice-1042.pdf', bytes: 86016, state: 'completed', path: '…/downloads/invoice-1042.pdf' }
 */
export const keepDownload = (download: Download, dir: string | undefined): KeptDownload => {
  const name = safeFileName(download.name, 'download');
  const ended = { name, bytes: download.bytes, state: download.state };
  if (download.state !== 'completed' || !download.filePath) return ended;
  if (!dir) return { ...ended, path: download.filePath };
  const folder = join(dir, 'downloads');
  mkdirSync(folder, { recursive: true });
  const path = uniqueFileName(folder, name);
  if (download.staged) moveFile(download.filePath, path);
  else copyFileSync(download.filePath, path);
  return { ...ended, path };
};

// A rename, or a copy and delete when the run folder is on another volume.
const moveFile = (from: string, to: string) => {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
};

/**
 * A size as people say it: bytes under 1 KB, whole KB under 1 MB, then MB with one decimal.
 *
 * @example
 * sizeWords(86016) // '84 KB'
 */
export const sizeWords = (bytes: number) => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * What the step that started a download says about it, in its history note.
 *
 * @example
 * downloadNote({ name: 'invoice-1042.pdf', bytes: 86016, state: 'completed' }) // 'downloaded invoice-1042.pdf, 84 KB'
 */
export const downloadNote = ({ name, bytes, state }: KeptDownload) => {
  if (state === 'completed') return `downloaded ${name}, ${sizeWords(bytes)}`;
  if (state === 'canceled') return `download of ${name} did not finish`;
  return `download of ${name} still running after 30 s`;
};
