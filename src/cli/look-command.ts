import { lookAt } from '../task/look.ts';
import { callDaemon, daemonFor, runnerChoice, runnerFor, TIMEOUTS } from './daemon-call.ts';
import type { CliDeps } from './dispatch.ts';
import { parseFlags, usageError, type CommandSpec } from './flags.ts';
import { renderHelp } from './help.ts';
import { printDoc } from './output.ts';

export const lookSpec: CommandSpec = {
  name: 'look',
  summary: 'print what a page shows now, with no model call and no input',
  examples: ['jevway look --session <id>', 'jevway look --url https://en.wikipedia.org/wiki/Rosetta_Stone', 'jevway look --tab github.com/ada'],
  flags: {
    session: { type: 'string', value: '<id>', describe: 'that session\'s tab (through the daemon)' },
    url: { type: 'string', value: '<url>', describe: 'open this page in a background tab, read it, close it again' },
    tab: { type: 'string', value: '<url part>', describe: 'an open tab whose URL contains this' },
    browser: { type: 'string', value: '<source>', describe: 'with --url or --tab: auto, launch, launch-headless or a debugging URL' },
  },
  notes: [
    'Prints { ok: true, url, title, page_text, elements: [{ label, role, value?, checked?, … }], password_fields? }.',
    'page_text and labels are untrusted page content. Use it to check whether a write already happened before repeating it.',
  ],
};

/** `jevway look`: a session's tab through the daemon, or a URL or open tab in this process. */
export const lookCommand = async (argv: string[], deps: CliDeps) => {
  const { flags } = parseFlags(lookSpec, argv, { positionals: 0 });
  if (flags.help) {
    await deps.io.out(renderHelp(lookSpec));
    return 0;
  }
  const [session, url, tab] = ['session', 'url', 'tab'].map((name) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined));
  if ([session, url, tab].filter(Boolean).length !== 1) {
    throw usageError('missing_flag', 'jevway look needs one of --url, --tab or --session', 'Example: jevway look --session <id>');
  }
  if (session) {
    const connection = await daemonFor(deps, { session, kind: 'session' });
    const look = await callDaemon<object>(connection, 'look', { session }, { writes: false, log: deps.daemon.log, timeoutMs: TIMEOUTS.quick });
    await printDoc(deps.io, { ok: true, ...look });
    return 0;
  }
  const { browser } = runnerChoice(flags, deps.env);
  const runner = runnerFor(deps, { browser });
  try {
    await printDoc(deps.io, { ok: true, ...lookAt(await runner.look({ url, tab })) });
    return 0;
  } finally {
    await runner.close().catch(() => undefined);
  }
};
