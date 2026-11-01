import { accessSync, constants, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

/**
 * Checks the files a caller declares for upload, before any browser work. Each must be an absolute path to a readable
 * regular file. They are kept apart from `values`, so typed text can never become a path or a path typed text; the model
 * only ever picks one of these keys. Not restricted to a working directory: the server's own is unrelated to the user's.
 *
 * @example
 * checkUploadFiles({ avatar: '/Users/ada/me.png' }); // { avatar: '/Users/ada/me.png' }
 * checkUploadFiles({ avatar: 'me.png' }); // throws: files.avatar: "me.png" is not an absolute path
 */
export const checkUploadFiles = (files: Record<string, string> | undefined): Record<string, string> => {
  for (const [key, path] of Object.entries(files ?? {})) {
    const refuse = (why: string) => {
      throw new Error(`files.${key}: "${path}" ${why}`);
    };
    if (!isAbsolute(path)) refuse('is not an absolute path');
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      refuse('does not exist');
    }
    if (!isFile) refuse('is not a file');
    try {
      accessSync(path, constants.R_OK);
    } catch {
      refuse('is not readable');
    }
  }
  return { ...files };
};

/**
 * What the model may know of the declared files: each key with its file's name, never the path.
 *
 * @example
 * fileNames({ avatar: '/Users/ada/me.png' }); // { avatar: 'me.png' }
 */
export const fileNames = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([key, path]) => [key, basename(path)]));
