import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

type Env = Record<string, string | undefined>;

// The keys and jevway's own settings; anything else (NODE_OPTIONS, PATH) could change how Node itself runs.
const isJevwaySetting = (name: string) =>
  ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'CHROME_PATH'].includes(name) || name.startsWith('JEVWAY_');

/**
 * Where jevway keeps its key outside any MCP client's config: `$XDG_CONFIG_HOME/jevway/env`, else
 * `~/.config/jevway/env`.
 *
 * @example
 * envFilePath() // '/Users/ada/.config/jevway/env'
 */
export const envFilePath = (env: Env = process.env) =>
  join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'jevway', 'env');

/** `envFilePath()` with the home folder written as `~`, for messages. */
export const shownEnvFilePath = (path = envFilePath()) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

/**
 * Fills the keys and `JEVWAY_*` settings the process lacks from the env file (`KEY=value` lines), so a key never has
 * to go into a chat, a command line or a synced client config. Some clients pass servers a filtered environment; the
 * file still works there. The process environment always wins, and an empty variable counts as missing (the same
 * test the key checks use). Returns the names it filled, never their values.
 *
 * @example
 * // ~/.config/jevway/env: TYPESAFE_API_KEY=ts_…
 * loadEnvFile() // ['TYPESAFE_API_KEY'] when the environment had none
 */
export const loadEnvFile = (path = envFilePath(), env: Env = process.env): string[] => {
  if (!existsSync(path)) return [];
  const missing = Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter(
    ([name, value]) => isJevwaySetting(name) && value?.trim() && !env[name]?.trim(),
  );
  for (const [name, value] of missing) env[name] = value;
  return missing.map(([name]) => name);
};

/**
 * What to tell someone whose decision model has no key: with none at all, the TypeSafe key first (Jev's best route),
 * where keys go, and the doctor. Undefined when the profile's key is set.
 *
 * @example
 * missingKeyMessage({ name: 'jev', apiKeyEnv: 'OPENROUTER_API_KEY' })
 * // 'No API key: set TYPESAFE_API_KEY (Jev on the TypeSafe API) or OPENROUTER_API_KEY …'
 */
export const missingKeyMessage = ({ name, apiKeyEnv }: { name: string; apiKeyEnv: string }, env: Env = process.env) => {
  if (env[apiKeyEnv]?.trim()) return undefined;
  const where = `in ${shownEnvFilePath()}, the environment or the MCP client's env block (then restart the server). \`npx jevway doctor\` checks the setup.`;
  return name === 'jev' && apiKeyEnv === 'OPENROUTER_API_KEY'
    ? `No API key: set TYPESAFE_API_KEY (Jev on the TypeSafe API) or OPENROUTER_API_KEY ${where}`
    : `No ${apiKeyEnv}: ${name} needs it. Set it ${where}`;
};
