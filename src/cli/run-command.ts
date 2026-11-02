import { resolve } from 'node:path';
import { z } from 'zod';
import { createSessionService, type TaskRequest } from '../session/session-service.ts';
import { CHECKS } from '../task/checks.ts';
import { presentSummary, type ConciseSummary } from '../task/present.ts';
import { callDaemon, daemonFor, placement, requireKey, runnerChoice, runnerFor, TIMEOUTS } from './daemon-call.ts';
import type { CliDeps } from './dispatch.ts';
import { choiceFlag, intFlag, jsonFlag, listFlag, parseFlags, usageError, type CommandSpec } from './flags.ts';
import { renderHelp } from './help.ts';
import { eventPrinter, printDoc } from './output.ts';

const TEXT_BY_KEY = z.record(z.string(), z.string());

export const runSpec: CommandSpec = {
  name: 'run',
  summary: 'hand a browser goal to Jev and print one JSON result',
  examples: [
    'jevway run --url https://en.wikipedia.org --goal "Open the article about the Rosetta Stone" --done-when "The Rosetta Stone article is open"',
    'jevway run --session new --browser launch-headless --url https://shop.example/checkout --goal "Fill in the delivery details" --values \'{"name":"Ada Lovelace","email":"ada@example.com"}\'',
    'jevway run --session <id> --goal "Fill in the delivery details" --values \'{"phone":"+44 20 7946 0000"}\'',
    'jevway run --session <id> --goal "Delete the repository ada/scratch" --confirm-irreversible --confirm-target "ada/scratch"',
  ],
  flags: {
    goal: { type: 'string', value: '<text>', describe: 'the full outcome wanted, in plain language (every call)' },
    url: { type: 'string', value: '<url>', describe: 'open this page in a new tab (start)' },
    tab: { type: 'string', value: '<url part>', describe: 'or drive an open tab whose URL contains this (start)' },
    session: { type: 'string', value: '<id|new>', describe: 'new: keep the tab in the background daemon between calls; <id>: continue that session' },
    values: { type: 'string', value: '<json>', describe: 'text values Jev may type, e.g. \'{"city":"Lisbon"}\'' },
    'secret-keys': { type: 'string', value: '<a,b>', describe: 'keys of --values that are secrets: Jev sees the key only, output shows [secret:<key>]' },
    files: { type: 'string', value: '<json>', describe: 'files Jev may upload, key to absolute path; Jev sees names, never paths' },
    'done-when': { type: 'string', value: '<text>', describe: 'visible evidence of success on the page the call ends on' },
    checks: { type: 'string', value: '<json>', describe: 'facts code checks on the final page, e.g. \'[{"type":"url_contains","text":"/issues/"}]\'' },
    'confirm-irreversible': { type: 'boolean', describe: 'allow one click flagged irreversible, only when the user\'s request names it' },
    'confirm-target': { type: 'string', value: '<words>', describe: 'with --confirm-irreversible: the user\'s words naming the target' },
    'max-steps': { type: 'string', value: '<n>', describe: 'step limit, 1 to 100 (default 40)' },
    'max-seconds': { type: 'string', value: '<n>', describe: 'time budget per call, 1 to 3600 (default 300); past it the run ends step_budget' },
    'allowed-hosts': { type: 'string', value: '<a.com,*.b.com>', describe: 'hosts the run may be on; leaving them ends it blocked' },
    'blocked-hosts': { type: 'string', value: '<a.com>', describe: 'hosts it must never be on' },
    'allow-coordinate-clicks': { type: 'boolean', describe: 'click a boxed control the DOM never reported (Jev 1.14 direct only; start)' },
    record: { type: 'boolean', describe: 'keep a recording for people in the run folder: video, step shots, index.html (start)' },
    'record-dir': { type: 'string', value: '<dir>', describe: 'put the whole run folder, recording included, here instead (start; --record <dir> works too)' },
    detail: { type: 'string', value: 'concise|full', describe: 'full adds the raw steps with confidences, Jev\'s stats and stuck candidates' },
    screenshot: { type: 'boolean', describe: 'accepted for parity with MCP; the result always carries files.screenshot' },
    browser: { type: 'string', value: '<source>', describe: 'auto, launch, launch-headless or http://127.0.0.1:<port> (default $JEVWAY_BROWSER or auto; start)' },
    model: { type: 'string', value: '<name>', describe: 'jev, pplx-decider, clef-omni, clef, clef-flash or gpt-6-luna (default $JEVWAY_MODEL or jev; start)' },
    screenshots: { type: 'string', value: 'off|fallback|always', describe: 'marked screenshots for vision models (default per model; start)' },
    'keep-open': { type: 'boolean', describe: 'without --session: leave the tabs open at the end' },
  },
  notes: [
    'Without --session the run happens in this process and its tabs close at the end, as before. With --session the',
    'background daemon keeps the tab (and a launched browser) between calls; jevway end <id> closes it, jevway stop',
    'stops the daemon. (start) flags count on a session\'s first call only.',
    '',
    'Prints { ok: true, session?, status, reason, next, story, url, title, page_text, files, … }; progress as NDJSON on',
    'stderr. Exit 0 when status is done, 1 on a hand-back (needs_input, needs_confirmation, uncertain, step_budget,',
    'blocked) or a tool error, 2 on bad usage or a missing key. outcome_unknown: the daemon went away mid-call; check',
    'with jevway look --session <id> before repeating it.',
  ],
};

/**
 * `next` in the CLI's words: flags instead of MCP parameters, and the session to pass (or, for a one-shot run, how to
 * keep one).
 *
 * @example
 * cliNext('Add the missing values to `values` and call again with this session.', 'abc')
 * // 'Add the missing values to `--values` and run again with `--session abc`.'
 */
export const cliNext = (next: string, session: string | undefined) => {
  const again = (call: string, joiner = '') => {
    const run = `${call === 'C' ? 'R' : 'r'}un again`;
    if (session) return `${run} with \`--session ${session}\`${joiner}`;
    return joiner ? `${run} with ` : run;
  };
  let text = next
    .replace(/`confirm_irreversible: true`/g, '`--confirm-irreversible`')
    .replace(/`(values|goal|confirm_target|max_steps|max_seconds)`/g, (_, name: string) => `\`--${name.replace(/_/g, '-')}\``)
    .replace(/([Cc])all again with this session(, | and )?/g, (_, call: string, joiner?: string) => again(call, joiner));
  text = session
    ? text.replace('end the session when', `end it with \`jevway end ${session}\` when`)
    : text.replace('; end the session when you no longer need its tab', '');
  return !session && /un again/.test(text) ? `${text} Pass \`--session new\` to keep the tab between calls.` : text;
};

// Today's `--record <dir>` keeps working: a value after --record is the folder.
const withRecordDir = (argv: string[]) =>
  argv.flatMap((arg, i) => (arg === '--record' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? ['--record-dir'] : [arg]));

const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as T;

/** `jevway run`: one goal, in-process without `--session`, through the daemon with it. */
export const runCommand = async (argv: string[], deps: CliDeps) => {
  const { flags } = parseFlags(runSpec, withRecordDir(argv), { positionals: 0 });
  if (flags.help) {
    await deps.io.out(renderHelp(runSpec));
    return 0;
  }
  const text = (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);
  const yes = (name: string) => (flags[name] === true ? true : undefined);
  const goal = text('goal');
  if (!goal) throw usageError('missing_flag', 'jevway run needs --goal', 'Example: jevway run --url https://example.com --goal "Open the pricing page"');
  const session = text('session');
  const starting = !session || session === 'new';
  if (starting && !text('url') && !text('tab')) {
    throw usageError('missing_flag', 'jevway run needs --url or --tab (or --session to continue)', 'Example: jevway run --url https://example.com --goal "Open the pricing page"');
  }
  const detail = choiceFlag('detail', text('detail'), ['concise', 'full'] as const) ?? 'concise';
  const recordDir = text('record-dir');
  const request: TaskRequest = defined({
    goal,
    url: text('url'),
    tab: text('tab'),
    values: jsonFlag('values', text('values'), TEXT_BY_KEY, '{"city":"Lisbon"}'),
    secretKeys: listFlag(text('secret-keys')),
    files: jsonFlag('files', text('files'), TEXT_BY_KEY, '{"avatar":"/Users/ada/me.png"}'),
    doneWhen: text('done-when'),
    checks: jsonFlag('checks', text('checks'), CHECKS, '[{"type":"url_contains","text":"/issues/"}]'),
    maxSteps: intFlag('max-steps', text('max-steps'), { min: 1, max: 100 }),
    maxSeconds: intFlag('max-seconds', text('max-seconds'), { min: 1, max: 3600 }),
    allowedHosts: listFlag(text('allowed-hosts')),
    blockedHosts: listFlag(text('blocked-hosts')),
    confirmIrreversible: yes('confirm-irreversible'),
    confirmTarget: text('confirm-target'),
    allowCoordinateClicks: yes('allow-coordinate-clicks'),
    record: yes('record'),
    recordDir: recordDir && resolve(deps.cwd, recordDir),
  });
  const choice = runnerChoice(flags, deps.env);
  if (!session) return runHere(deps, request, { choice, detail, keepOpen: Boolean(yes('keep-open')) });

  if (starting) requireKey(runnerFor(deps, choice));
  const connection = await daemonFor(deps, starting ? { start: true } : { session, kind: 'session' });
  const printEvent = eventPrinter(deps.io);
  let id = starting ? undefined : session;
  const cancel = new AbortController();
  const stopListening = deps.onInterrupt(() => cancel.abort());
  try {
    const result = await callDaemon<ConciseSummary>(
      connection,
      'task',
      { request: { ...request, ...(id && { session: id }) }, detail, runner: choice, place: placement(deps) },
      {
        writes: true,
        session: () => id,
        log: deps.daemon.log,
        signal: cancel.signal,
        timeoutMs: TIMEOUTS.task(request.maxSeconds, !starting),
        onEvent: (event) => {
          if (event?.type === 'started') id = event.session;
          printEvent(event);
        },
      },
    );
    await printDoc(deps.io, { ok: true, ...result, next: cliNext(result.next, result.session) });
    return result.status === 'done' ? 0 : 1;
  } finally {
    stopListening();
  }
};

/** A one-shot run in this process, as before the daemon: its own browser connection, its tabs closed at the end. */
const runHere = async (
  deps: CliDeps,
  request: TaskRequest,
  { choice, detail, keepOpen }: { choice: ReturnType<typeof runnerChoice>; detail: 'concise' | 'full'; keepOpen: boolean },
) => {
  const runner = runnerFor(deps, choice);
  requireKey(runner);
  const sessions = createSessionService(runner, { env: deps.env, cwd: deps.cwd });
  // Ctrl-C stops the run at its next check (an action under way finishes), so the result still prints and the tab closes.
  const cancel = new AbortController();
  const stopListening = deps.onInterrupt(() => cancel.abort());
  try {
    const result = await sessions.task(request, { signal: cancel.signal, onEvent: eventPrinter(deps.io) });
    if (!keepOpen) await sessions.end(result.session).catch(() => undefined);
    // Nothing is left to continue, so the result names no session.
    const { session: _session, ...presented } = presentSummary(result, { detail });
    await printDoc(deps.io, { ok: true, ...presented, next: cliNext(presented.next, undefined) });
    return presented.status === 'done' ? 0 : 1;
  } finally {
    stopListening();
    await sessions.close().catch(() => undefined);
  }
};
