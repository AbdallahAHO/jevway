import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/** Points `os.tmpdir()` at a folder of this test file's own, removed with everything in it once the file's tests end. */
const outer = process.env.TMPDIR;
const folder = mkdtempSync(join(tmpdir(), 'jevway-test-'));
process.env.TMPDIR = folder;

afterAll(() => {
  if (outer === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = outer;
  rmSync(folder, { recursive: true, force: true });
});
