import { vi } from 'vitest';

/** Runs `command` with stdout captured; returns its exit code and everything it printed. */
export const captureStdout = async (command: () => Promise<number>) => {
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, ...rest: unknown[]) => {
    printed.push(String(chunk));
    const done = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await command();
    return { code, output: printed.join('') };
  } finally {
    write.mockRestore();
  }
};
