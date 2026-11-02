import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes `text` to a temporary file beside `path` and renames it into place, so an interrupted setup leaves the file
 * either as it was or complete. `mode` applies to the result even where the file existed before.
 */
export const writeFileAtomic = (path: string, text: string, mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.jevway-${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
};
