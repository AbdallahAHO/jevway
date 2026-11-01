import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { devToolsActivePort, findChrome } from '../browser/chrome.ts';
import { createLiveAsk, resolveModel } from '../jev/model.ts';
import { diagnose, exitCode, liveCheck, planSteps, render, type Probes } from './doctor.ts';
import { envFilePath, shownEnvFilePath } from './env-file.ts';

const USAGE = `jevway doctor [--plan] [--live] [--browser <source>] [--model <name>]

  Checks Node, the API key and the route it selects, the browser source and ffmpeg. Never prints a key.
  --plan     print the setup steps still missing, numbered
  --live     also make ONE real Jev request (costs a fraction of a cent)
  --browser  check this source instead of $JEVWAY_BROWSER (auto, launch, launch-headless or a URL)
  --model    check this model instead of $JEVWAY_MODEL

Exit code 0 when jevway is ready (warnings allowed), 1 when something blocks it.`;

// Permission bits of the env file, when it exists; Windows has none worth checking.
const envFileMode = () => {
  if (process.platform === 'win32') return undefined;
  try {
    return statSync(envFilePath()).mode & 0o777;
  } catch {
    return undefined;
  }
};

const realProbes = (browser: string, model: string | undefined, fromEnvFile: string[]): Probes => ({
  nodeVersion: process.versions.node,
  browser,
  model,
  fromEnvFile,
  envFile: { path: shownEnvFilePath(), mode: envFileMode() },
  findChrome,
  devToolsActivePort,
  answers: (url) => fetch(url, { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false),
  hasFfmpeg: () => new Promise((resolve) => execFile('ffmpeg', ['-version'], (error) => resolve(!error))),
});

/**
 * `jevway doctor`: prints the report (or, with `--plan`, the steps left) and returns the exit code. `fromEnvFile` is
 * what `loadEnvFile` filled at start, so each key's line can say where it came from.
 *
 * @example
 * process.exit(await runDoctor(process.argv.slice(3), loadEnvFile()));
 */
export const runDoctor = async (argv: string[], fromEnvFile: string[]): Promise<number> => {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        plan: { type: 'boolean' },
        live: { type: 'boolean' },
        browser: { type: 'string' },
        model: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    console.error(`jevway doctor: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const findings = await diagnose(realProbes(options.browser ?? process.env.JEVWAY_BROWSER ?? 'auto', options.model, fromEnvFile));
  // The live request only makes sense once the key and model are in place.
  const keyReady = !findings.some(({ area, level }) => (area === 'Key' || area === 'Model') && level === 'fail');
  if (options.live && keyReady) {
    // Always the real API, never a replay: the check is whether the key and route work.
    const { profile } = resolveModel({ model: options.model, live: true });
    findings.push(await liveCheck(createLiveAsk(profile), profile.model, [process.env.TYPESAFE_API_KEY, process.env.OPENROUTER_API_KEY]));
  }
  // Written before the caller exits: on macOS a piped stdout is asynchronous.
  await new Promise((resolve) => process.stdout.write(options.plan ? planSteps(findings) : render(findings), resolve));
  return exitCode(findings);
};
