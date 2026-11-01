import { describe, expect, it } from 'vitest';
import { RunStopped, startRunLimit } from '../src/task/run-limit.ts';

describe('the run limit', () => {
  it('handles a request that fails after the run was already stopped, so it never surfaces as an unhandled rejection', async () => {
    const limit = startRunLimit({ signal: AbortSignal.abort(), maxSeconds: 1, actions: () => 0 });
    // An SDK request started with an aborted signal rejects on its own a moment later.
    const request = new Promise((_, reject) => setTimeout(() => reject(new Error('aborted by the SDK')), 10));
    await expect(limit.within(request)).rejects.toBeInstanceOf(RunStopped);
    await new Promise((resolve) => setTimeout(resolve, 30));
    limit.dispose();
  });
});
