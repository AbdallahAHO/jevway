import type { CommandSpec } from './flags.ts';

const FLAG_COLUMN = 30;

/**
 * A command's help: examples first (agents copy those), then the usage line, the flags and the notes.
 *
 * @example
 * renderHelp(lookSpec) // 'Examples:\n  jevway look --url https://example.com\n…'
 */
export const renderHelp = (spec: CommandSpec) => {
  const flags = Object.entries(spec.flags).map(([name, flag]) => {
    const left = `  --${name}${flag.value ? ` ${flag.value}` : ''}`;
    return `${left.padEnd(FLAG_COLUMN)} ${flag.describe}`;
  });
  return [
    'Examples:',
    ...spec.examples.map((example) => `  ${example}`),
    '',
    `jevway ${spec.name}${spec.argument ? ` ${spec.argument}` : ''} [flags]: ${spec.summary}`,
    '',
    'Flags:',
    ...flags,
    `${'  --help, -h'.padEnd(FLAG_COLUMN)} this help`,
    ...(spec.notes?.length ? ['', ...spec.notes] : []),
    '',
  ].join('\n');
};

/** `jevway --help`: examples, then every command in one line each. */
export const topHelp = (commands: { name: string; summary: string }[]) =>
  [
    'Examples:',
    '  jevway run --url https://en.wikipedia.org --goal "Open the article about the Rosetta Stone"',
    '  jevway run --session new --browser launch-headless --url https://example.com/signup --goal "Sign up" --values \'{"email":"ada@example.com"}\'',
    '  jevway run --session <id> --goal "Sign up" --values \'{"code":"123456"}\'',
    '  jevway look --session <id>',
    '  jevway sessions',
    '  jevway end <id>',
    '',
    'jevway <command> [flags]: hand a browser goal to TypeSafe Jev and get one JSON result back.',
    '',
    'Commands:',
    ...commands.map(({ name, summary }) => `  ${name.padEnd(18)} ${summary}`),
    '',
    'Output: one JSON document on stdout ({ "ok": true, … } or { "ok": false, "error": { code, message, hint } });',
    'progress as NDJSON events on stderr. Exit 0 on success, 1 on a hand-back or a tool error, 2 on bad usage.',
    '`jevway --goal …` is `jevway run --goal …`. `jevway help <command>` or `jevway <command> --help` for its flags.',
    'Keys come from the environment or ~/.config/jevway/env (jevway setup, jevway doctor).',
    '',
  ].join('\n');
