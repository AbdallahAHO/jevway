import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stopChrome } from '../src/browser/chrome.ts';

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
