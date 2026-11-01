import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkUploadFiles } from '../src/task/upload-files.ts';

const AVATAR = new URL('../verify/fixture/capabilities/avatar.png', import.meta.url).pathname;

describe('files the caller declares for upload', () => {
  it('passes a map of absolute, readable files through', () => {
    expect(checkUploadFiles({ avatar: AVATAR })).toEqual({ avatar: AVATAR });
    expect(checkUploadFiles(undefined)).toEqual({});
  });

  it.each([
    ['a relative path', 'verify/fixture/capabilities/avatar.png', /files\.avatar: "verify\/fixture\/capabilities\/avatar\.png" is not an absolute path/],
    ['a missing file', '/no/such/dir/avatar.png', /files\.avatar: "\/no\/such\/dir\/avatar\.png" does not exist/],
    ['a directory', mkdtempSync(join(tmpdir(), 'jevway-upload-')), /files\.avatar: ".*" is not a file/],
  ])('refuses %s, naming its key', (_, path, message) => {
    expect(() => checkUploadFiles({ avatar: path })).toThrow(message);
  });
});
