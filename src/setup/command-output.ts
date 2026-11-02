/** Writes `text` to stdout and waits until it is flushed: on macOS a piped stdout is asynchronous. */
export const print = (text: string) => new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));

/** Prints `value` as indented JSON on stdout. */
export const printJson = (value: unknown) => print(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Prints the structured error agents read (`{ ok: false, error: { code, message, hint } }`) on stdout and returns
 * `exitCode`, so a command can `return printError(…)`.
 *
 * @example
 * return printError(2, 'usage', 'jevway skill: --install needs a folder', 'jevway skill --install ~/.claude/skills');
 */
export const printError = async (exitCode: number, code: string, message: string, hint: string) => {
  await printJson({ ok: false, error: { code, message, hint } });
  return exitCode;
};
