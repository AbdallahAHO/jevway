import { describe, expect, it } from 'vitest';
import { closestName, durationFlag, intFlag, jsonFlag, parseFlags, type CommandSpec } from '../../src/cli/flags.ts';
import { z } from 'zod';

const spec: CommandSpec = {
  name: 'run',
  summary: 'Run a goal',
  examples: ['jevway run --url https://example.com --goal "Open the docs"'],
  flags: {
    goal: { type: 'string', value: '<text>', describe: 'the outcome' },
    values: { type: 'string', value: '<json>', describe: 'text values' },
    'keep-open': { type: 'boolean', describe: 'leave the tabs open' },
  },
};

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    const { exitCode, code, message, hint } = error as { exitCode: number; code: string; message: string; hint: string };
    return { exitCode, code, message, hint };
  }
  throw new Error('expected a failure');
};

describe('reading flags', () => {
  it('reads string and boolean flags, inline values and positionals', () => {
    expect(parseFlags(spec, ['--goal', 'Open it', '--keep-open', '--values={"a":"b"}'], { positionals: 0 })).toEqual({
      flags: { goal: 'Open it', 'keep-open': true, values: '{"a":"b"}' },
      positionals: [],
    });
    expect(parseFlags(spec, ['abc', '--goal', '-5 stars'], { positionals: 1 }).positionals).toEqual(['abc']);
    expect(parseFlags(spec, ['--goal', '-5 stars'], { positionals: 0 }).flags.goal).toBe('-5 stars');
  });

  it('names a mistyped flag, suggests the closest one and points at the help, exit 2', () => {
    expect(failure(() => parseFlags(spec, ['--vales', '{}'], { positionals: 0 }))).toEqual({
      exitCode: 2,
      code: 'unknown_flag',
      message: 'Unknown flag --vales',
      hint: 'Did you mean --values? See jevway run --help',
    });
    expect(failure(() => parseFlags(spec, ['--zzzzzz'], { positionals: 0 })).hint).toBe('See jevway run --help');
    expect(failure(() => parseFlags(spec, ['-x'], { positionals: 0 })).code).toBe('unknown_flag');
  });

  it('refuses a string flag with no value, without swallowing the next flag', () => {
    expect(failure(() => parseFlags(spec, ['--goal', '--keep-open'], { positionals: 0 }))).toMatchObject({
      exitCode: 2,
      code: 'missing_value',
      message: '--goal needs a value',
    });
    expect(failure(() => parseFlags(spec, ['--goal'], { positionals: 0 })).code).toBe('missing_value');
  });

  it('refuses a value given to a boolean flag and an argument the command does not take', () => {
    expect(failure(() => parseFlags(spec, ['--keep-open=yes'], { positionals: 0 })).code).toBe('invalid_value');
    expect(failure(() => parseFlags(spec, ['stray'], { positionals: 0 }))).toMatchObject({ exitCode: 2, code: 'unexpected_argument' });
  });

  it('reads --help and -h on every command', () => {
    expect(parseFlags(spec, ['-h'], { positionals: 0 }).flags.help).toBe(true);
    expect(parseFlags(spec, ['--help', '--vales'], { positionals: 0 }).flags.help).toBe(true);
  });
});

describe('flag values', () => {
  it('names the flag in a JSON error and gives an example', () => {
    const values = z.record(z.string(), z.string());
    expect(jsonFlag('values', '{"city":"Lisbon"}', values, '{"city":"Lisbon"}')).toEqual({ city: 'Lisbon' });
    const broken = failure(() => jsonFlag('values', "{city:'Lisbon'}", values, '{"city":"Lisbon"}'));
    expect(broken).toMatchObject({ exitCode: 2, code: 'invalid_value', hint: `Example: --values '{"city":"Lisbon"}'` });
    expect(broken.message).toMatch(/^--values: Expected property name/);
    expect(failure(() => jsonFlag('values', '{"city":4}', values, '{"city":"Lisbon"}')).message).toMatch(/^--values: /);
  });

  it('never quotes the input back in a JSON error, since values can be secrets', () => {
    const values = z.record(z.string(), z.string());
    const unquoted = failure(() => jsonFlag('values', '{"password":hunter2-PRIVATEPART}', values, '{"city":"Lisbon"}'));
    expect(unquoted).toMatchObject({ code: 'invalid_value', message: '--values is not valid JSON: check its quotes and braces' });
    expect(JSON.stringify(unquoted)).not.toMatch(/hunter|PRIVATE/);
    const unclosed = failure(() => jsonFlag('values', '{"password":"hunter2-PRIVATEPART"', values, '{"city":"Lisbon"}'));
    expect(unclosed.message).toMatch(/^--values: Expected ',' or '}' after property value in JSON at position \d+/);
  });

  it('reads whole numbers within bounds', () => {
    expect(intFlag('max-steps', '12', { min: 1, max: 100 })).toBe(12);
    expect(intFlag('max-steps', undefined, { min: 1, max: 100 })).toBeUndefined();
    expect(failure(() => intFlag('max-steps', '1.5', { min: 1, max: 100 }))).toMatchObject({ code: 'invalid_value', message: '--max-steps must be a whole number from 1 to 100, got "1.5"' });
    expect(failure(() => intFlag('max-steps', '101', { min: 1, max: 100 })).code).toBe('invalid_value');
  });

  it('reads durations in seconds or with a unit, 0 meaning never', () => {
    expect(durationFlag('idle-timeout', '3600')).toBe(3_600_000);
    expect(durationFlag('idle-timeout', '90s')).toBe(90_000);
    expect(durationFlag('idle-timeout', '30m')).toBe(1_800_000);
    expect(durationFlag('idle-timeout', '2h')).toBe(7_200_000);
    expect(durationFlag('idle-timeout', '0')).toBe(0);
    expect(failure(() => durationFlag('idle-timeout', 'soon')).code).toBe('invalid_value');
  });

  it('finds the closest name within two edits', () => {
    expect(closestName('vales', ['values', 'goal', 'url'])).toBe('values');
    expect(closestName('rn', ['run', 'look', 'end'])).toBe('run');
    expect(closestName('sesions', ['sessions', 'session'])).toBe('sessions');
    expect(closestName('banana', ['run', 'look'])).toBeUndefined();
  });
});
