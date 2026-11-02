import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

/** Where the daemon keeps its socket and log: `$JEVWAY_STATE_DIR`, else `$XDG_RUNTIME_DIR/jevway`, else `~/.cache/jevway`. */
export const stateDir = (env: Env = process.env, home = homedir()) =>
  env.JEVWAY_STATE_DIR?.trim() || (env.XDG_RUNTIME_DIR?.trim() ? join(env.XDG_RUNTIME_DIR, 'jevway') : join(home, '.cache', 'jevway'));

/** `<state>/daemon.sock`; on Windows a named pipe, one per state dir and user. */
export const socketPath = (dir: string, platform = process.platform) =>
  platform === 'win32'
    ? `\\\\.\\pipe\\jevway-${createHash('sha256').update(`${userInfo().username}:${dir}`).digest('hex').slice(0, 16)}`
    : join(dir, 'daemon.sock');

export const logPath = (dir: string) => join(dir, 'daemon.log');

/**
 * The environment a daemon is started with: the caller's, with `JEVWAY_REPLAY_DIR` made absolute (the daemon runs in
 * its state dir).
 */
export const daemonEnv = (env: Env, cwd: string): Env =>
  env.JEVWAY_REPLAY_DIR?.trim() ? { ...env, JEVWAY_REPLAY_DIR: resolve(cwd, env.JEVWAY_REPLAY_DIR.trim()) } : env;

// What a daemon reads from its own environment rather than from each request. Keys count only as set or not.
const KEYS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'];
const SETTINGS = ['CHROME_PATH', 'JEVWAY_ALLOWED_HOSTS', 'JEVWAY_BLOCKED_HOSTS', 'JEVWAY_REPLAY', 'JEVWAY_REPLAY_DIR'];

/**
 * A digest of the settings a daemon reads from its own environment, so a client can tell when a running daemon was
 * started with other ones. Holds nothing derived from a key's value, only whether each key is set.
 */
export const envFingerprint = (env: Env) =>
  createHash('sha256')
    .update(JSON.stringify([...KEYS.map((name) => Boolean(env[name]?.trim())), ...SETTINGS.map((name) => env[name]?.trim() ?? '')]))
    .digest('hex')
    .slice(0, 16);
