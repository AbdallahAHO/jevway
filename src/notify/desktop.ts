import { execFile } from 'node:child_process';

/** Shows one line to the person at this computer; never throws and never waits for the notification. */
export type Notify = (message: string) => void;

/** Runs a program with arguments (no shell); the default is `execFile` with a 5 s timeout. */
export type RunProgram = (file: string, args: string[]) => Promise<unknown> | unknown;

const NOTIFY_TIMEOUT_MS = 5000;
const OFF = new Set(['off', '0', 'false', 'no']);

const runProgram: RunProgram = (file, args) =>
  new Promise((resolve) => execFile(file, args, { timeout: NOTIFY_TIMEOUT_MS }, () => resolve(undefined)));

/**
 * An AppleScript string literal for `text`: quotes and backslashes escaped.
 *
 * @example
 * appleScriptString('Pass the "unusual traffic" check') // '"Pass the \\"unusual traffic\\" check"'
 */
export const appleScriptString = (text: string) => `"${text.replace(/[\\"]/g, '\\$&')}"`;

/**
 * The desktop notifier for this platform, titled "jevway": `osascript` on macOS, `notify-send` on Linux (nothing when
 * it is not installed). Undefined on Windows and when `JEVWAY_NOTIFY` is `off` (or `0`, `false`, `no`).
 *
 * @example
 * desktopNotifier()?.('Sign in to github.com in Chrome');
 */
export const desktopNotifier = ({
  env = process.env,
  platform = process.platform,
  run = runProgram,
}: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform; run?: RunProgram } = {}): Notify | undefined => {
  if (OFF.has(env.JEVWAY_NOTIFY?.trim().toLowerCase() ?? '')) return undefined;
  const command = (message: string): [string, string[]] | undefined => {
    if (platform === 'darwin') return ['osascript', ['-e', `display notification ${appleScriptString(message)} with title "jevway"`]];
    if (platform === 'linux') return ['notify-send', ['jevway', message]];
    return undefined;
  };
  if (!command('')) return undefined;
  return (message) => {
    const [file, args] = command(message)!;
    try {
      Promise.resolve(run(file, args)).catch(() => undefined);
    } catch {
      // A notification is a courtesy: a missing program or a failed one never reaches the run.
    }
  };
};
