import { DaemonFailure } from '../daemon/client.ts';
import { UnknownSession } from '../session/session-service.ts';
import { CliError } from './flags.ts';

/** Where a command writes: `out` gets its one JSON document (awaited, so it is flushed before exit), `err` NDJSON events. */
export interface CliIo {
  out: (text: string) => void | Promise<void>;
  err: (text: string) => void;
}

// Daemon error codes that mean the command line itself was wrong.
const USAGE_CODES = new Set(['unknown_flag', 'unknown_command', 'missing_flag', 'missing_value', 'invalid_value', 'unexpected_argument', 'missing_command', 'missing_key']);

export const printDoc = async (io: CliIo, doc: object) => {
  await io.out(`${JSON.stringify(doc, null, 2)}\n`);
};

/** Writes each event as one JSON line on stderr. */
export const eventPrinter = (io: CliIo) => (event: unknown) => io.err(`${JSON.stringify(event)}\n`);

/** Any failure as the CLI reports it: its exit code and the error body, never a stack trace. */
export const describeFailure = (error: unknown) => {
  if (error instanceof CliError) return { exitCode: error.exitCode, code: error.code, message: error.message, hint: error.hint };
  if (error instanceof DaemonFailure) return { exitCode: USAGE_CODES.has(error.code) ? 2 : 1, code: error.code, message: error.message, hint: error.hint };
  if (error instanceof UnknownSession) return { exitCode: 1, code: error.code, message: error.message, hint: 'List the open ones with jevway sessions' };
  const message = error instanceof Error ? error.message : String(error);
  return { exitCode: 1, code: 'failed', message, hint: 'The message says what failed; jevway doctor checks the key and the browser.' };
};

/** Prints `{ ok: false, error }` for `error` and returns the exit code. */
export const printFailure = async (io: CliIo, error: unknown) => {
  const { exitCode, ...body } = describeFailure(error);
  await printDoc(io, { ok: false, error: body });
  return exitCode;
};
