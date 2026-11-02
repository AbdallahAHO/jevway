import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inboxFilePath, readInboxFile, writeInboxFile } from '../../src/inbox/inbox-file.ts';
import { inboxFrom } from '../../src/inbox/inbox.ts';
import { tempDir } from '../cli/harness.ts';

const inbox = inboxFrom({ address: 'test-0a1b2c3d4e@tm-domain.example', password: 'pw-not-for-eyes', api: 'https://api.mail.tm' });

describe('the one-shot CLI inbox file', () => {
  it('lives in <out root>/inboxes/<address>.env, mode 600 in a 700 folder, under a root ignored by git', () => {
    const root = join(tempDir(), '.jevway');
    const path = writeInboxFile(root, inbox);
    expect(path).toBe(join(root, 'inboxes', 'test-0a1b2c3d4e@tm-domain.example.env'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'inboxes')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it("holds the standalone script's ADDR, PASS and API lines and reads back to the same inbox", () => {
    const root = join(tempDir(), '.jevway');
    const path = writeInboxFile(root, inbox);
    expect(readFileSync(path, 'utf8')).toBe('ADDR=test-0a1b2c3d4e@tm-domain.example\nPASS=pw-not-for-eyes\nAPI=https://api.mail.tm\n');
    const read = readInboxFile(root, inbox.address);
    expect(read).toMatchObject({ address: inbox.address, api: inbox.api, password: 'pw-not-for-eyes' });
    expect(JSON.stringify(read)).not.toContain('pw-not-for-eyes');
  });

  it('a missing file reads as undefined; an address that is not one never becomes a path', () => {
    const root = join(tempDir(), '.jevway');
    expect(readInboxFile(root, 'test-ffffffffff@tm-domain.example')).toBeUndefined();
    expect(() => inboxFilePath(root, '../../etc/passwd')).toThrow(/address/);
  });
});
