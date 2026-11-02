import { createHash } from 'node:crypto';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

/** Where the daemon keeps its socket and log: `$JEVWAY_STATE_DIR`, else `$XDG_RUNTIME_DIR/jevway`, else `~/.cache/jevway`. */
export const stateDir = (env: Env = process.env, home = homedir()) =>
  env.JEVWAY_STATE_DIR?.trim() || (env.XDG_RUNTIME_DIR?.trim() ? join(env.XDG_RUNTIME_DIR, 'jevway') : join(home, '.cache', 'jevway'));

// Unix socket paths are capped at 104 bytes on macOS (108 on Linux), counting the terminating NUL.
const SOCKET_PATH_BYTES = 103;

const stateDigest = (dir: string) => createHash('sha256').update(`${userInfo().username}:${dir}`).digest('hex').slice(0, 16);

/**
 * `<state>/daemon.sock`, or `<tmp>/jevway-<digest>.sock` when the state dir is too deep for a Unix socket; on Windows
 * a named pipe. One state dir always maps to one socket.
 */
export const socketPath = (dir: string, platform = process.platform, tmp = tmpdir()) => {
  if (platform === 'win32') return `\\\\.\\pipe\\jevway-${stateDigest(dir)}`;
  const inState = join(dir, 'daemon.sock');
  return Buffer.byteLength(inState) <= SOCKET_PATH_BYTES ? inState : join(tmp, `jevway-${stateDigest(dir)}.sock`);
};

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
