import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envFilePath, loadEnvFile, setEnvValue, writeEnvFile } from '../../src/setup/env-file.ts';

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

describe('updating the env file (jevway setup)', () => {
  it('replaces the line for that name, keeps every other line as it was, and drops later duplicates', () => {
    const text = '# my settings\nJEVWAY_MODEL=clef\nTYPESAFE_API_KEY=old\n\nexport TYPESAFE_API_KEY=older\nCHROME_PATH=/opt/chrome\n';
    expect(setEnvValue(text, 'TYPESAFE_API_KEY', 'new-key')).toBe('# my settings\nJEVWAY_MODEL=clef\nTYPESAFE_API_KEY=new-key\n\nCHROME_PATH=/opt/chrome\n');
  });

  it('appends a missing name, adding the newline the file lacked', () => {
    expect(setEnvValue('JEVWAY_MODEL=clef', 'JEVWAY_BROWSER', 'launch')).toBe('JEVWAY_MODEL=clef\nJEVWAY_BROWSER=launch\n');
    expect(setEnvValue('', 'JEVWAY_BROWSER', 'launch')).toBe('JEVWAY_BROWSER=launch\n');
  });

  it('removes the line when the value is undefined', () => {
    expect(setEnvValue('JEVWAY_BROWSER=launch\nJEVWAY_MODEL=clef\n', 'JEVWAY_BROWSER', undefined)).toBe('JEVWAY_MODEL=clef\n');
  });

  it('never touches a line whose name only starts the same', () => {
    expect(setEnvValue('JEVWAY_BROWSER_X=1\n', 'JEVWAY_BROWSER', 'launch')).toBe('JEVWAY_BROWSER_X=1\nJEVWAY_BROWSER=launch\n');
  });

  it('writes the file with mode 600 through a temporary file, even when it was readable by others', () => {
    const path = fileWith('JEVWAY_MODEL=clef\n');
    chmodSync(path, 0o644);
    writeEnvFile(path, 'JEVWAY_MODEL=clef\nTYPESAFE_API_KEY=k\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('JEVWAY_MODEL=clef\nTYPESAFE_API_KEY=k\n');
    expect(readdirSync(dirname(path))).toEqual(['env']);
  });

  it('creates the folder and the file when neither exists', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jevway-env-')), 'config', 'jevway', 'env');
    writeEnvFile(path, 'JEVWAY_BROWSER=launch\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
