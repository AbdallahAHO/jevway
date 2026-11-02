import { describe, expect, it, vi } from 'vitest';
import type { Ask } from '../../src/jev/decide.ts';
import { isTransientModelError, retryingAsk } from '../../src/jev/retry.ts';

const answer = { answers: {} } as any;

describe('a model call that may hit a busy API', () => {
  it('knows a busy or flaky API from a real failure', () => {
    for (const message of ['529 We are currently experiencing high traffic', '503 Service Unavailable', '429 Too Many Requests', 'fetch failed', 'socket hang up', 'Request timed out'])
      expect(isTransientModelError(new Error(message)), message).toBe(true);
    for (const message of ['401 Unauthorized', '400 Bad Request: invalid question', 'Invalid TypeSafe answer; no action executed.'])
      expect(isTransientModelError(new Error(message)), message).toBe(false);
  });

  it('tries again after a busy answer, waiting longer each time, and gives the answer back', async () => {
    const waits: number[] = [];
    const ask = vi.fn<Ask>().mockRejectedValueOnce(new Error('529 We are currently experiencing high traffic')).mockRejectedValueOnce(new Error('503 Service Unavailable')).mockResolvedValue(answer);
    const retrying = retryingAsk(ask, { delaysMs: [10, 30], wait: async (ms) => void waits.push(ms) });
    await expect(retrying({} as any)).resolves.toBe(answer);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([10, 30]);
  });

  it('gives up after its last try, and never retries a real failure', async () => {
    const busy = vi.fn<Ask>().mockRejectedValue(new Error('529 busy'));
    await expect(retryingAsk(busy, { delaysMs: [1, 1], wait: async () => {} })({} as any)).rejects.toThrow('529 busy');
    expect(busy).toHaveBeenCalledTimes(3);
    const denied = vi.fn<Ask>().mockRejectedValue(new Error('401 Unauthorized'));
    await expect(retryingAsk(denied, { delaysMs: [1, 1], wait: async () => {} })({} as any)).rejects.toThrow('401');
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
