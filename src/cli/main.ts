#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { daemonAccess, spawnDaemon } from '../daemon/client.ts';
import { daemonEnv, envFingerprint, logPath, socketPath, stateDir } from '../daemon/paths.ts';
import { loadEnvFile } from '../setup/env-file.ts';
import { createRunner } from '../task/start-task.ts';
import { runCli } from './dispatch.ts';
import { printFailure } from './output.ts';

// Keys and JEVWAY_* settings the environment lacks come from ~/.config/jevway/env.
const fromEnvFile = loadEnvFile();
// The same depth from src/cli/ and dist/cli/.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const cwd = process.cwd();
const dir = stateDir(process.env);
const spawnEnv = daemonEnv(process.env, cwd);

let printed = false;
const io = {
  // Awaited, so the document is flushed before exit: on macOS a piped stdout is asynchronous.
  out: (text: string) =>
    new Promise<void>((resolve) => {
      printed = true;
      process.stdout.write(text, () => resolve());
    }),
  err: (text: string) => void process.stderr.write(text),
};

// Nothing escapes as a stack trace: an error before the result prints as the one JSON document; one after it is dropped.
const lastResort = async (error: unknown) => {
  if (!printed) process.exit(await printFailure(io, error));
};
process.on('uncaughtException', lastResort);
process.on('unhandledRejection', lastResort);

let presses = 0;
const onInterrupt = (handler: () => void) => {
  const press = () => {
    // A second Ctrl-C leaves at once.
    if (++presses > 1) process.exit(130);
    handler();
  };
  process.on('SIGINT', press);
  process.on('SIGTERM', press);
  return () => {
    process.off('SIGINT', press);
    process.off('SIGTERM', press);
  };
};

const code = await runCli(process.argv.slice(2), {
  io,
  env: process.env,
  cwd,
  version,
  fromEnvFile,
  createRunner,
  daemon: daemonAccess({
    socket: socketPath(dir),
    log: logPath(dir),
    version,
    fingerprint: envFingerprint(spawnEnv),
    start: () => spawnDaemon({ entry: fileURLToPath(import.meta.url), stateDir: dir, env: spawnEnv }),
  }),
  onInterrupt,
});
process.exit(code);
