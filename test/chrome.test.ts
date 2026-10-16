import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectChrome, stopChrome } from '../src/browser/chrome.ts';

const spawnNode = (script: string) => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });

const untilReady = (child: ChildProcess) => once(child.stdout!, 'data');

describe('stopChrome', () => {
  it('returns at once for a process that already exited', async () => {
    const child = spawnNode('process.exit(0)');
    await once(child, 'exit');
    const started = Date.now();
    await stopChrome(child);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('stops a running process with SIGTERM', async () => {
    const child = spawnNode('setInterval(() => {}, 1000)');
    await stopChrome(child);
    expect(child.signalCode).toBe('SIGTERM');
  });

  it.skipIf(process.platform === 'win32')('kills a process that ignores SIGTERM after the grace period', async () => {
    const child = spawnNode("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)");
    await untilReady(child);
    await stopChrome(child, 200);
    expect(child.signalCode).toBe('SIGKILL');
  });
});

describe('connectChrome launch', () => {
  // A fake Chrome that reports a DevTools address nothing listens on, so only the connect step fails.
  const fakeChromeScript = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
writeFileSync(process.env.FAKE_CHROME_OUT, JSON.stringify({ pid: process.pid, profile }));
process.stderr.write('DevTools listening on ws://127.0.0.1:1/devtools/browser/fake\\n');
setInterval(() => {}, 1000);
`;

  it.skipIf(process.platform === 'win32')(
    'stops Chrome and removes its profile when the DevTools connection fails',
    async () => {
      const fakeDir = mkdtempSync(join(tmpdir(), 'fake-chrome-'));
      const fakeChrome = join(fakeDir, 'chrome');
      const report = join(fakeDir, 'report.json');
      writeFileSync(fakeChrome, fakeChromeScript);
      chmodSync(fakeChrome, 0o755);
      const saved = { chromePath: process.env.CHROME_PATH, report: process.env.FAKE_CHROME_OUT };
      process.env.CHROME_PATH = fakeChrome;
      process.env.FAKE_CHROME_OUT = report;
      try {
        await expect(connectChrome('launch-headless')).rejects.toThrow('Cannot connect');
        const { pid, profile } = JSON.parse(readFileSync(report, 'utf8'));
        expect(existsSync(profile)).toBe(false);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        if (saved.chromePath === undefined) delete process.env.CHROME_PATH;
        else process.env.CHROME_PATH = saved.chromePath;
        if (saved.report === undefined) delete process.env.FAKE_CHROME_OUT;
        else process.env.FAKE_CHROME_OUT = saved.report;
        rmSync(fakeDir, { recursive: true, force: true });
      }
    },
  );
});
