import { evidenceRequest, readEvidence, type Ask } from '../jev/decide.ts';
import { resolveModel, type ModelProfile } from '../jev/model.ts';
import { missingKeyMessage } from './env-file.ts';

export type Level = 'ok' | 'warn' | 'fail';

/** One line of the doctor's report: where (`area`), what is wrong or in place (`message`), and the fix. */
export interface Finding {
  level: Level;
  area: string;
  message: string;
  fix?: string;
}

/** Everything the doctor looks at on the machine, injectable so each state can be tested without one. */
export interface Probes {
  nodeVersion: string;
  /** `--browser`, else `JEVWAY_BROWSER`, else `auto`. */
  browser: string;
  /** `--model`; `JEVWAY_MODEL` otherwise. */
  model?: string;
  /** Variables `loadEnvFile` filled, so a key's line says where it came from. */
  fromEnvFile: string[];
  /** The env file as shown to people, and its permission bits when it exists (none on Windows). */
  envFile: { path: string; mode?: number };
  findChrome: () => string | undefined;
  devToolsActivePort: () => { port: string; file: string } | undefined;
  /** True when anything answers HTTP at the URL (any status): a chrome://inspect Chrome answers /json/version with 404. */
  answers: (url: string) => Promise<boolean>;
  hasFfmpeg: () => Promise<boolean>;
}

const ok = (area: string, message: string): Finding => ({ level: 'ok', area, message });
const warn = (area: string, message: string, fix: string): Finding => ({ level: 'warn', area, message, fix });
const fail = (area: string, message: string, fix: string): Finding => ({ level: 'fail', area, message, fix });

const nodeFinding = (version: string) =>
  Number(version.split('.')[0]) >= 24
    ? ok('Node', version)
    : fail('Node', `Node ${version} is too old: jevway needs Node 24 or later`, 'Install Node 24 or later (nodejs.org, or `nvm install 24`)');

// Which key the chosen model uses, where it came from, and the route it selects. Names only, never a value.
const keyFindings = ({ model, fromEnvFile, envFile }: Probes): Finding[] => {
  let profile: ModelProfile;
  try {
    ({ profile } = resolveModel({ model, live: true }));
  } catch (error) {
    return [fail('Model', (error as Error).message, 'Set JEVWAY_MODEL / JEVWAY_SCREENSHOTS (or --model / --screenshots) to a listed value, or unset them')];
  }
  if (missingKeyMessage(profile)) {
    return profile.name === 'jev'
      ? [
          fail(
            'Key',
            'neither TYPESAFE_API_KEY nor OPENROUTER_API_KEY is set',
            `Put TYPESAFE_API_KEY=<your key> in ${envFile.path} (then chmod 600 it), or in your MCP client's env block; never paste a key into a chat. Keys come from TypeSafe (docs.typesafe.ai)`,
          ),
        ]
      : [
          fail(
            'Key',
            `${profile.name} runs through OpenRouter, and OPENROUTER_API_KEY is not set`,
            `Put OPENROUTER_API_KEY=<your key> in ${envFile.path} or your MCP client's env block, or unset JEVWAY_MODEL to run Jev`,
          ),
        ];
  }
  const source = fromEnvFile.includes(profile.apiKeyEnv) ? envFile.path : 'the environment';
  const label = profile.name === 'jev' ? 'Jev' : profile.name;
  const route = profile.baseURL
    ? `through OpenRouter${profile.name === 'jev' ? ', without Box' : ''}`
    : `on the TypeSafe API${profile.box ? ', with screenshots and Box' : ''}`;
  return [ok('Key', `${profile.apiKeyEnv} from ${source}: ${label} (${profile.model}) ${route}`)];
};

const envFileFinding = ({ path, mode }: Probes['envFile']) =>
  mode !== undefined && mode & 0o077
    ? [warn('Env file', `${path} is readable by other users`, `chmod 600 ${path}`)]
    : [];

// A ws:// endpoint is probed over http on the same host and port; anything else must parse as an http(s) URL.
const debuggingUrl = (source: string) => {
  try {
    const url = new URL(source.replace(/^ws/, 'http'));
    return ['http:', 'https:'].includes(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};

// Probes over plain HTTP only: opening the DevTools WebSocket would make the user's Chrome ask to allow it.
const browserFinding = async ({ browser, findChrome, devToolsActivePort, answers }: Probes): Promise<Finding> => {
  if (browser === 'launch' || browser === 'launch-headless') {
    const chrome = findChrome();
    return chrome
      ? ok('Browser', `${browser}: a throwaway Chrome profile, ${chrome}`)
      : fail('Browser', `${browser}: Chrome not found`, 'Install Google Chrome, or set CHROME_PATH to its executable');
  }
  if (browser === 'auto') {
    const active = devToolsActivePort();
    if (!active) {
      return fail(
        'Browser',
        'auto: no running Chrome allows remote debugging',
        'Open chrome://inspect/#remote-debugging in Chrome and allow it, or set JEVWAY_BROWSER=launch for a throwaway Chrome',
      );
    }
    if (!(await answers(`http://127.0.0.1:${active.port}/json/version`))) {
      return fail(
        'Browser',
        `auto: Chrome listed port ${active.port} for remote debugging, but nothing answers there`,
        'Start Chrome and allow remote debugging again at chrome://inspect/#remote-debugging, or set JEVWAY_BROWSER=launch',
      );
    }
    return ok('Browser', `auto: Chrome allows remote debugging on port ${active.port} (it asks you to allow jevway's first connection)`);
  }
  const url = debuggingUrl(browser);
  if (!url) {
    return fail(
      'Browser',
      `${browser} is not auto, launch, launch-headless or a debugging URL`,
      'Set JEVWAY_BROWSER (or --browser) to auto, launch, launch-headless or http://127.0.0.1:<port>',
    );
  }
  const version = new URL('/json/version', url).href;
  return (await answers(version))
    ? ok('Browser', `${browser}: Chrome answers at ${version}`)
    : fail(
        'Browser',
        `${browser}: nothing answers at ${version}`,
        `Start Chrome with --remote-debugging-port=${url.port || 80} --user-data-dir=<a separate profile folder>, or fix JEVWAY_BROWSER`,
      );
};

const ffmpegFinding = async ({ hasFfmpeg }: Probes) =>
  (await hasFfmpeg())
    ? ok('ffmpeg', 'found')
    : warn('ffmpeg', 'not found; recordings (record_dir) keep their screenshots but get no run.mp4', 'Install ffmpeg (macOS: brew install ffmpeg)');

/**
 * What stands between this machine and a working jevway: Node, the key and the route it selects, the env file's
 * permissions, the browser source, and ffmpeg. Blockers are `fail`; `warn` never blocks.
 *
 * @example
 * const findings = await diagnose(realProbes);
 * process.stdout.write(render(findings));
 * process.exitCode = exitCode(findings);
 */
export const diagnose = async (probes: Probes): Promise<Finding[]> => [
  nodeFinding(probes.nodeVersion),
  ...keyFindings(probes),
  ...envFileFinding(probes.envFile),
  await browserFinding(probes),
  await ffmpegFinding(probes),
];

/** 0 when nothing blocks (warnings allowed), 1 otherwise. */
export const exitCode = (findings: Finding[]) => (findings.some(({ level }) => level === 'fail') ? 1 : 0);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The report: one line per finding (level, area, message), a fix under each problem, then a verdict.
 *
 * @example
 * render(findings)
 * // 'ok    Node: 24.21.0\nFAIL  Browser: auto: no running Chrome allows remote debugging\n      Fix: Open chrome://…'
 */
export const render = (findings: Finding[]) => {
  const lines = findings.flatMap(({ level, area, message, fix }) => [
    `${(level === 'fail' ? 'FAIL' : level).padEnd(6)}${area}: ${message}`,
    ...(level !== 'ok' && fix ? [`      Fix: ${fix}`] : []),
  ]);
  const problems = findings.filter(({ level }) => level === 'fail').length;
  const warnings = findings.filter(({ level }) => level === 'warn').length;
  const verdict = problems
    ? `Not ready: ${plural(problems, 'problem')} ${problems === 1 ? 'blocks' : 'block'} jevway. \`jevway doctor --plan\` lists the steps.`
    : warnings
      ? `Ready, with ${plural(warnings, 'warning')}.`
      : 'Ready.';
  return `${lines.join('\n')}\n\n${verdict}\n`;
};

/**
 * `--plan`: the fixes still to do as a numbered list, blockers first, warnings marked optional.
 *
 * @example
 * planSteps(findings) // 'Steps left:\n1. Install Node 24 or later …\n2. (optional) Install ffmpeg …\n'
 */
export const planSteps = (findings: Finding[]) => {
  const steps = [
    ...findings.filter(({ level }) => level === 'fail'),
    ...findings.filter(({ level }) => level === 'warn'),
  ].map(({ level, fix }, index) => `${index + 1}. ${level === 'warn' ? '(optional) ' : ''}${fix}`);
  return steps.length ? `Steps left:\n${steps.join('\n')}\n` : 'Nothing left to set up: jevway is ready.\n';
};

/**
 * `--live`: one real request (the one-Choice evidence question, the cheapest the model is asked) to prove the key,
 * the route and the network. An error message has every key value replaced by `[secret]` before it is shown.
 *
 * @example
 * await liveCheck(createAsk(profile), profile.model, [process.env.TYPESAFE_API_KEY])
 * // { level: 'ok', area: 'Live', message: 'jev-1.14.0 answered one request in 412 ms' }
 */
export const liveCheck = async (ask: Ask, model: string, secrets: (string | undefined)[]): Promise<Finding> => {
  const started = performance.now();
  try {
    const request = evidenceRequest({ url: 'about:blank', title: 'jevway doctor' }, 'The page says ready', ['ready']);
    readEvidence((await ask(request, { signal: AbortSignal.timeout(20_000) })).answers, 1);
    return ok('Live', `${model} answered one request in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    const message = secrets
      .map((secret) => secret?.trim())
      .filter((secret): secret is string => Boolean(secret))
      .reduce((text, secret) => text.replaceAll(secret, '[secret]'), (error as Error).message);
    return fail('Live', `${model}: ${message}`, 'Check that the key is valid and has credit, and that this machine reaches the API (a proxy or firewall can block it)');
  }
};
