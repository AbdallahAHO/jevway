import { describe, expect, it } from 'vitest';
import { StalePage } from '../src/browser/tab.ts';
import { clearStorageWhenSettled } from '../verify/jobs/runner.ts';

const START = 'http://localhost:3312/';
const cleared = { cleared: true, at: START };
const onBlank = { cleared: false, at: 'about:blank' };

// A tab whose evaluate answers from a script: an object is returned, an Error is thrown. The last answer repeats.
const scriptedTab = (answers: (object | Error)[]) => {
  const tab = {
    calls: 0,
    evaluate: async () => {
      const answer = answers[Math.min(tab.calls++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return tab;
};

describe('a run clears storage only on a loaded start page', () => {
  it('retries when the document changed during the clear', async () => {
    const tab = scriptedTab([new StalePage('Document changed during evaluation'), cleared]);
    await expect(clearStorageWhenSettled(tab, { pollMs: 1 })).resolves.toBe(START);
    expect(tab.calls).toBe(2);
  });

  it('waits while the tab still shows about:blank or the page is loading', async () => {
    const tab = scriptedTab([onBlank, { cleared: false, at: START }, cleared]);
    await expect(clearStorageWhenSettled(tab, { pollMs: 1 })).resolves.toBe(START);
    expect(tab.calls).toBe(3);
  });

  it('gives up past the deadline, naming where the tab was', async () => {
    const tab = scriptedTab([onBlank]);
    await expect(clearStorageWhenSettled(tab, { deadlineMs: 20, pollMs: 1 })).rejects.toThrow(
      'could not clear storage: the start page did not settle (last at about:blank)',
    );
  });

  // tab.evaluate turns a protocol error into StalePage, a closed connection included.
  it.each([new Error('Browser connection closed'), new StalePage('Browser connection closed')])(
    'does not wait out a closed connection (%s)',
    async (closed) => {
      const tab = scriptedTab([closed, cleared]);
      await expect(clearStorageWhenSettled(tab, { pollMs: 1 })).rejects.toThrow('Browser connection closed');
      expect(tab.calls).toBe(1);
    },
  );
});
