import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envFilePath, loadEnvFile } from '../src/setup/env-file.ts';

const fileWith = (text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'jevway-env-')), 'env');
  writeFileSync(path, text);
  return path;
};

describe('the env file (~/.config/jevway/env)', () => {
  it('fills the keys the environment lacks, and an empty variable counts as missing', () => {
    const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: '' };
    const filled = loadEnvFile(fileWith('TYPESAFE_API_KEY=ts-file\nOPENROUTER_API_KEY="or-file"\nJEVWAY_BROWSER=launch\n'), env);
    expect(env).toEqual({ TYPESAFE_API_KEY: 'ts-file', OPENROUTER_API_KEY: 'or-file', JEVWAY_BROWSER: 'launch' });
    expect(filled.sort()).toEqual(['JEVWAY_BROWSER', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY']);
  });

  it('never overrides a variable the process already has: the environment and the client env block win', () => {
    const env: Record<string, string | undefined> = { TYPESAFE_API_KEY: 'ts-env' };
    expect(loadEnvFile(fileWith('TYPESAFE_API_KEY=ts-file\n'), env)).toEqual([]);
    expect(env.TYPESAFE_API_KEY).toBe('ts-env');
  });

  it('takes only the keys, CHROME_PATH and JEVWAY_* settings, so the file cannot change how Node runs', () => {
    const env: Record<string, string | undefined> = {};
    loadEnvFile(fileWith('NODE_OPTIONS=--require=/tmp/x.js\nPATH=/evil\nCHROME_PATH=/opt/chrome\nJEVWAY_MODEL=clef\n'), env);
    expect(env).toEqual({ CHROME_PATH: '/opt/chrome', JEVWAY_MODEL: 'clef' });
  });

  it('does nothing when there is no file', () => {
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFile(join(tmpdir(), 'jevway-no-such-dir', 'env'), env)).toEqual([]);
    expect(env).toEqual({});
  });

  it('lives in $XDG_CONFIG_HOME/jevway/env, else ~/.config/jevway/env', () => {
    expect(envFilePath({ XDG_CONFIG_HOME: '/cfg' })).toBe(join('/cfg', 'jevway', 'env'));
    expect(envFilePath({})).toBe(join(homedir(), '.config', 'jevway', 'env'));
  });
});
