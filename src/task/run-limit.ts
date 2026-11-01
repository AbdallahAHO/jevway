import type { TaskStatus } from './run-task.ts';

/** Why a call must end now: the caller cancelled it, or its time budget passed. */
export class RunStopped extends Error {
  readonly status: TaskStatus;
  readonly reason: string;
  constructor(status: TaskStatus, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export type RunLimit = ReturnType<typeof startRunLimit>;

/**
 * One call's stop signal: it aborts when the caller's signal does (`blocked`, "Cancelled by the caller") or when
 * `maxSeconds` pass (`step_budget`). Waits and model requests take `signal`; inputs never do, so an input in flight
 * always finishes and the loop stops at its next check. `dispose()` clears the timer when the call ends.
 *
 * @example
 * const limit = startRunLimit({ signal: extra.signal, maxSeconds: 300, actions: () => executed });
 * await limit.pause(300); // returns early on a stop
 * const halt = limit.stopped(); // RunStopped | undefined
 */
export const startRunLimit = ({ signal, maxSeconds, actions }: { signal?: AbortSignal; maxSeconds: number; actions: () => number }) => {
  const controller = new AbortController();
  const stopWith = (status: TaskStatus, reason: string) => {
    if (!controller.signal.aborted) controller.abort(new RunStopped(status, reason));
  };
  const cancel = () => stopWith('blocked', 'Cancelled by the caller');
  const timer = setTimeout(
    () => stopWith('step_budget', `Reached the time budget of ${maxSeconds} s (max_seconds) after ${actions()} actions without finishing`),
    maxSeconds * 1000,
  );
  // Unref'd: a CLI run must not stay alive just for its budget timer.
  (timer as { unref?: () => void }).unref?.();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });

  const stopped = (): RunStopped | undefined => (controller.signal.aborted ? (controller.signal.reason as RunStopped) : undefined);

  return {
    signal: controller.signal,
    stopped,
    /** Sleeps `ms`, or less when the run is stopped meanwhile; never throws. */
    pause: (ms: number) =>
      new Promise<void>((resolve) => {
        if (controller.signal.aborted) return resolve();
        const done = () => {
          clearTimeout(wait);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const wait = setTimeout(done, ms);
        controller.signal.addEventListener('abort', done, { once: true });
      }),
    /** Settles like `work`, or rejects with the stop as soon as the run is stopped, whether or not `work` heeds the signal. */
    within: <T>(work: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        // `work` is always handled, even when the stop wins: a request rejected after the stop must not go unhandled.
        const onStop = () => reject(stopped());
        work.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onStop));
        if (controller.signal.aborted) onStop();
        else controller.signal.addEventListener('abort', onStop, { once: true });
      }),
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    },
  };
};
