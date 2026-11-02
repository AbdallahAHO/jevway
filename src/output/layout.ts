import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SLUG_CHARS = 40;
const unchanged = (text: string) => text;

/** Where jevway writes runs and journeys: `$JEVWAY_OUT_DIR`, else `./.jevway`, resolved against `cwd`. */
export const outRoot = (env: Record<string, string | undefined> = process.env, cwd = process.cwd()) =>
  resolve(cwd, env.JEVWAY_OUT_DIR || '.jevway');

/** Creates the root with a `.gitignore` of `*`, written only when absent so an owner's own rules stand. */
export const ensureOutRoot = (root: string) => {
  mkdirSync(root, { recursive: true });
  const ignore = join(root, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return root;
};

/**
 * Lowercase ASCII words joined by hyphens, at most 40 characters cut at a word; `run` when nothing is left.
 *
 * @example
 * slugify('Réserver à São Paulo — 2 guests!') // 'reserver-a-sao-paulo-2-guests'
 */
export const slugify = (text: string, max = SLUG_CHARS) => {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!words) return 'run';
  if (words.length <= max) return words;
  const cut = words.slice(0, max);
  const lastBreak = cut.lastIndexOf('-');
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
};

/** A slug that never holds a secret value: scrubbed before slugging, and the slug scrubbed and slugged once more. */
export const safeSlug = (text: string, scrub: (text: string) => string = unchanged) => slugify(scrub(slugify(scrub(text))));

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as `2026-11-02_0905`: folders are browsed by people, and sort by start time. */
export const folderStamp = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_${pad(at.getHours())}${pad(at.getMinutes())}`;

/** `<stamp>_<goal-slug>_<first 4 of the session id>`. */
export const runFolderName = ({ at, goal, id, scrub }: { at: Date; goal: string; id: string; scrub?: (text: string) => string }) =>
  `${folderStamp(at)}_${safeSlug(goal, scrub)}_${id.slice(0, 4)}`;

/** `<stamp>_<host>_<first 4 of the journey id>`; a port's colon becomes a hyphen. */
export const journeyFolderName = ({ at, host, id }: { at: Date; host: string; id: string }) =>
  `${folderStamp(at)}_${host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}_${id.slice(0, 4)}`;

/** A recorded step's shot, relative to its folder: `steps/01-type-destination.jpg`. */
export const stepFileName = (n: number, slug: string) => `steps/${pad(n)}-${slug || 'step'}.jpg`;

/** A call's end page, relative to its folder: `calls/02-needs-input.jpg`. */
export const callShotName = (n: number, status: string) => `calls/${pad(n)}-${slugify(status)}.jpg`;

/** A journey screen's screenshot, relative to its folder: `screens/s01-home.png`. */
export const screenFileName = (id: string, type: string) => `screens/${id}-${slugify(type)}.png`;
