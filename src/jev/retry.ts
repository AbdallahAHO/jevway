import type { Ask } from './decide.ts';

/** A busy or flaky model API (5xx incl. 529 overload, 429, 499, timeouts, dropped connections): worth another try. */
const TRANSIENT_MODEL_ERROR = /^(5\d\d|429|499)\b|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i;

/**
 * Whether a model call failed for a reason that may pass on its own.
 *
 * @example
 * isTransientModelError(new Error('529 We are currently experiencing high traffic')) // true
 */
export const isTransientModelError = (error: unknown) => error instanceof Error && TRANSIENT_MODEL_ERROR.test(error.message);

/**
 * An `Ask` that tries again after a transient failure, waiting each of `delaysMs` in turn; any other failure, or the
 * last one, is thrown as it came.
 *
 * @example
 * const ask = retryingAsk(createAsk(profile), { delaysMs: [1000, 3000] });
 */
export const retryingAsk = (
  ask: Ask,
  { delaysMs, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }: { delaysMs: number[]; wait?: (ms: number) => Promise<void> },
): Ask => async (request) => {
  for (const delay of delaysMs) {
    try {
      return await ask(request);
    } catch (error) {
      if (!isTransientModelError(error)) throw error;
      await wait(delay);
    }
  }
  return ask(request);
};
