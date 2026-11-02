import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOutRoot } from '../output/layout.ts';
import { inboxFrom, type Inbox } from './inbox.ts';

const ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** `<root>/inboxes/<address>.env`; anything that is not a plain address is refused, so it never escapes the folder. */
export const inboxFilePath = (root: string, address: string) => {
  if (!ADDRESS.test(address) || address.includes('..')) throw new Error(`"${address}" is not an email address`);
  return join(root, 'inboxes', `${address.toLowerCase()}.env`);
};

/**
 * Writes the one-shot CLI's credentials as the standalone script's `ADDR=` / `PASS=` / `API=` lines, mode 600 in a
 * 700 folder, under an output root whose `.gitignore` is `*`. Returns the path.
 */
export const writeInboxFile = (root: string, inbox: Inbox) => {
  ensureOutRoot(root);
  const path = inboxFilePath(root, inbox.address);
  mkdirSync(join(root, 'inboxes'), { recursive: true, mode: 0o700 });
  chmodSync(join(root, 'inboxes'), 0o700);
  writeFileSync(path, `ADDR=${inbox.address}\nPASS=${inbox.password}\nAPI=${inbox.api}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created.
  chmodSync(path, 0o600);
  return path;
};

/** The inbox stored for `address` under `root`, or undefined when there is no file. */
export const readInboxFile = (root: string, address: string): Inbox | undefined => {
  let text: string;
  try {
    text = readFileSync(inboxFilePath(root, address), 'utf8');
  } catch {
    return undefined;
  }
  const fields = Object.fromEntries(
    text
      .split('\n')
      .map((line) => /^(\w+)=(.*)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map(([, key, value]) => [key, value]),
  );
  if (!fields.ADDR || !fields.PASS || !fields.API) return undefined;
  return inboxFrom({ address: fields.ADDR, password: fields.PASS, api: fields.API });
};
