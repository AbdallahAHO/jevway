import type { z } from 'zod';

export interface FlagSpec {
  type: 'string' | 'boolean';
  /** How the value is shown in help: `<json>`, `<url>`. */
  value?: string;
  describe: string;
}

/** A command as help shows it: examples first, then its flags. Did-you-mean suggestions come from `flags`. */
export interface CommandSpec {
  /** `run`, `journey step`. */
  name: string;
  summary: string;
  examples: string[];
  /** The positional argument, as help shows it after the name: `<id>`. */
  argument?: string;
  flags: Record<string, FlagSpec>;
  /** Lines after the flags: what the command prints, its exit codes. */
  notes?: string[];
}

/**
 * A failure the CLI prints as `{ ok: false, error: { code, message, hint } }` and exits with: 2 for bad usage, 1 for a
 * tool error or a hand-back.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly hint: string;
  constructor(exitCode: number, code: string, message: string, hint: string) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
    this.hint = hint;
  }
}

export const usageError = (code: string, message: string, hint: string) => new CliError(2, code, message, hint);

const distance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
};

/**
 * The name `word` most likely meant: the nearest within two edits, else one it starts or ends.
 *
 * @example
 * closestName('vales', ['values', 'goal']) // 'values'
 */
export const closestName = (word: string, names: string[]) => {
  const [nearest] = names.map((name) => ({ name, edits: distance(word, name) })).sort((a, b) => a.edits - b.edits);
  if (nearest && nearest.edits <= 2) return nearest.name;
  return word.length >= 3 ? names.find((name) => name.startsWith(word) || word.startsWith(name)) : undefined;
};

const helpHint = (spec: CommandSpec) => `See jevway ${spec.name} --help`;

/**
 * Reads `argv` against the command's flags: `--name value`, `--name=value`, booleans, and up to `positionals` plain
 * arguments. `--help`/`-h` always parse. Anything else is a `CliError` (exit 2) naming it.
 *
 * @example
 * parseFlags(runSpec, ['--goal', 'Open it', '--keep-open'], { positionals: 0 })
 * // { flags: { goal: 'Open it', 'keep-open': true }, positionals: [] }
 */
export const parseFlags = (spec: CommandSpec, argv: string[], { positionals: allowed }: { positionals: number }) => {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  // Help wins over any other mistake on the line.
  if (argv.some((arg) => arg === '--help' || arg === '-h')) return { flags: { help: true }, positionals };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-' || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    const [rawName, ...inline] = arg.replace(/^--?/, '').split('=');
    const flag = spec.flags[rawName];
    if (!flag || !arg.startsWith('--')) {
      const meant = closestName(rawName, Object.keys(spec.flags));
      throw usageError('unknown_flag', `Unknown flag ${arg.split('=')[0]}`, `${meant ? `Did you mean --${meant}? ` : ''}${helpHint(spec)}`);
    }
    if (flag.type === 'boolean') {
      if (inline.length && !['true', 'false'].includes(inline.join('='))) {
        throw usageError('invalid_value', `--${rawName} takes no value`, `Pass --${rawName} alone. ${helpHint(spec)}`);
      }
      flags[rawName] = inline.join('=') !== 'false';
      continue;
    }
    const value = inline.length ? inline.join('=') : argv[i + 1];
    if (value === undefined || (!inline.length && value.startsWith('--'))) {
      throw usageError('missing_value', `--${rawName} needs a value`, `--${rawName} ${flag.value ?? '<value>'}. ${helpHint(spec)}`);
    }
    if (!inline.length) i++;
    flags[rawName] = value;
  }
  if (positionals.length > allowed) {
    throw usageError('unexpected_argument', `Unexpected argument "${positionals[allowed]}"`, `Quote values that hold spaces. ${helpHint(spec)}`);
  }
  return { flags, positionals };
};

/**
 * A JSON flag parsed and checked against `schema`; errors name the flag and show `example`.
 *
 * @example
 * jsonFlag('values', '{"city":"Lisbon"}', VALUES, '{"city":"Lisbon"}') // { city: 'Lisbon' }
 */
export const jsonFlag = <T>(name: string, raw: string | undefined, schema: z.ZodType<T>, example: string): T | undefined => {
  if (raw === undefined) return undefined;
  const hint = `Example: --${name} '${example}'`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const { message } = error as Error;
    // V8's "Unexpected token" message quotes a slice of the input, and a value can be a secret.
    if (message.endsWith('is not valid JSON')) throw usageError('invalid_value', `--${name} is not valid JSON: check its quotes and braces`, hint);
    throw usageError('invalid_value', `--${name}: ${message}`, hint);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    throw usageError('invalid_value', `--${name}: ${issue?.message ?? 'not valid'}${where}`, hint);
  }
  return result.data;
};

/** A whole number flag within `min`..`max`. */
export const intFlag = (name: string, raw: string | undefined, { min, max }: { min: number; max: number }) => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || value < min || value > max) {
    throw usageError('invalid_value', `--${name} must be a whole number from ${min} to ${max}, got "${raw}"`, `Example: --${name} ${min}`);
  }
  return value;
};

/** A flag that must be one of `choices`. */
export const choiceFlag = <T extends string>(name: string, raw: string | undefined, choices: readonly T[]): T | undefined => {
  if (raw === undefined) return undefined;
  if (!choices.includes(raw as T)) {
    throw usageError('invalid_value', `--${name} must be ${choices.slice(0, -1).join(', ')} or ${choices.at(-1)}, got "${raw}"`, `Example: --${name} ${choices.at(-1)}`);
  }
  return raw as T;
};

/** A comma-separated list, blanks dropped. */
export const listFlag = (raw: string | undefined) =>
  raw
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const UNITS: Record<string, number> = { '': 1000, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * A duration in milliseconds: plain seconds, or a number with `s`, `m` or `h`. `0` is 0 (callers read it as never).
 *
 * @example
 * durationFlag('idle-timeout', '30m') // 1800000
 */
export const durationFlag = (name: string, raw: string) => {
  const match = /^(\d+(?:\.\d+)?)\s*([smh]?)$/.exec(raw.trim());
  if (!match) throw usageError('invalid_value', `--${name} must be seconds or a number with s, m or h, got "${raw}"`, `Example: --${name} 1h (0 means never)`);
  return Math.round(Number(match[1]) * UNITS[match[2]]);
};
