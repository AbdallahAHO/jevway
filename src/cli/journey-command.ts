import { resolve } from 'node:path';
import { z } from 'zod';
import { DEVICES } from '../browser/devices.ts';
import { callDaemon, daemonFor, placement, requireKey, runnerChoice, runnerFor, TIMEOUTS } from './daemon-call.ts';
import type { CliDeps } from './dispatch.ts';
import { choiceFlag, closestName, intFlag, jsonFlag, parseFlags, usageError, type CommandSpec } from './flags.ts';
import { renderHelp } from './help.ts';
import { printDoc } from './output.ts';

const ID = { journey: { type: 'string' as const, value: '<id>', describe: 'the journey (or pass it as the argument)' } };
const NOTES = { description: { type: 'string' as const, value: '<text>', describe: 'what the screen is, for the viewer' }, insight: { type: 'string' as const, value: '<text>', describe: 'a UX observation' } };
const REPORT = ['Prints { ok: true, journey, screen: { id, screenshot: <absolute path>, … }, … }: the screen report the MCP tools return, with the screenshot\'s path instead of an inline image.'];

const specs: Record<string, CommandSpec> = {
  start: {
    name: 'journey start',
    summary: 'open a URL on an emulated phone and map its first screen',
    examples: ['jevway journey start --url https://stays.example --intent "find and open a stay in Lisbon"', 'jevway journey start --url https://app.example --device pixel-8 --browser launch-headless'],
    flags: {
      url: { type: 'string', value: '<url>', describe: 'the first screen' },
      device: { type: 'string', value: '<name>', describe: `${Object.keys(DEVICES).join(', ')} (default iphone-15)` },
      intent: { type: 'string', value: '<text>', describe: 'focus on one journey; leave out to explore core journeys' },
      values: { type: 'string', value: '<json>', describe: 'text autopilot may type (search queries, fake names)' },
      'stay-within': { type: 'string', value: '<url prefix>', describe: 'URL prefix autopilot must stay under (default the same origin)' },
      'out-dir': { type: 'string', value: '<dir>', describe: 'the exact folder for the map (default .jevway/journeys/<stamp>_<host>_<id4>)' },
      browser: { type: 'string', value: '<source>', describe: 'auto, launch, launch-headless or a debugging URL' },
      model: { type: 'string', value: '<name>', describe: 'the decision model (default $JEVWAY_MODEL or jev)' },
      screenshots: { type: 'string', value: 'off|fallback|always', describe: 'marked screenshots for vision models' },
    },
    notes: REPORT,
  },
  step: {
    name: 'journey step',
    argument: '<id>',
    summary: 'move the journey one step and note what you learned about the screen you leave',
    examples: ['jevway journey step <id> --next 3 --flow "Homes/Searching homes" --description "Search results"', 'jevway journey step <id> --next back'],
    flags: {
      ...ID,
      next: { type: 'string', value: '<move>', describe: 'an element index from elements/jev.ranked_taps ("3:2" for an option), back, restart, scroll_down, scroll_up or screen:<id>' },
      value: { type: 'string', value: '<text>', describe: 'type this into a text field' },
      flow: { type: 'string', value: '<name>', describe: 'the flow the step belongs to; it sticks for later steps' },
      ...NOTES,
    },
    notes: REPORT,
  },
  autopilot: {
    name: 'journey autopilot',
    argument: '<id>',
    summary: 'let Jev explore: until the intent is reached, or for --screens new screens',
    examples: ['jevway journey autopilot <id> --screens 5', 'jevway journey autopilot <id> --intent "open a stay" --flow "Booking"'],
    flags: {
      ...ID,
      screens: { type: 'string', value: '<n>', describe: 'without an intent: check back after this many new screens (1 to 30)' },
      flow: { type: 'string', value: '<name>', describe: 'record the steps under this flow' },
      intent: { type: 'string', value: '<text>', describe: 'keep going until this is reached or a stop condition' },
    },
    notes: REPORT,
  },
  annotate: {
    name: 'journey annotate',
    argument: '<id>',
    summary: 'describe a screen, or move steps into a named flow',
    examples: ['jevway journey annotate <id> --screen s02 --description "Search results" --insight "Filters hide below the fold"', 'jevway journey annotate <id> --screen s03 --relabel \'{"from_step":2,"to_step":4,"flow":"Checkout"}\''],
    flags: {
      ...ID,
      screen: { type: 'string', value: '<screen id>', describe: 'the screen, e.g. s02' },
      ...NOTES,
      relabel: { type: 'string', value: '<json>', describe: 'move steps [from_step..to_step] (0-based, see journey.json) into a flow' },
    },
  },
  finish: {
    name: 'journey finish',
    argument: '<id>',
    summary: 'write the final map and viewer, close the tab, and list screens still missing a description',
    examples: ['jevway journey finish <id>', 'jevway journey finish <id> --keep-tab'],
    flags: { ...ID, 'keep-tab': { type: 'boolean', describe: 'leave the tab open' } },
  },
};

const overview = [
  'Examples:',
  '  jevway journey start --url https://stays.example --intent "find and open a stay in Lisbon"',
  '  jevway journey step <id> --next 3 --description "Home with a search box"',
  '  jevway journey autopilot <id> --screens 5',
  '  jevway journey finish <id>',
  '',
  'jevway journey <start|step|autopilot|annotate|finish> [flags]: map mobile user journeys through the daemon.',
  '',
  ...Object.values(specs).map(({ name, summary }) => `  ${name.padEnd(18)} ${summary}`),
  '',
  'jevway journey <subcommand> --help for its flags. Use made-up data for any typing; stop at login, payment and send steps.',
  '',
].join('\n');

const LABELS = z.record(z.string(), z.string());
const RELABEL = z.object({ from_step: z.number().int(), to_step: z.number().int(), flow: z.string() });

/** `jevway journey <subcommand>`: the journey tools through the daemon. */
export const journeyCommand = async (argv: string[], deps: CliDeps) => {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    await deps.io.out(overview);
    return 0;
  }
  const spec = specs[sub];
  if (!spec) {
    const meant = closestName(sub, Object.keys(specs));
    throw usageError('unknown_command', `Unknown command "journey ${sub}"`, `${meant ? `Did you mean jevway journey ${meant}? ` : ''}See jevway journey --help`);
  }
  const { flags, positionals } = parseFlags(spec, rest, { positionals: spec.argument ? 1 : 0 });
  if (flags.help) {
    await deps.io.out(renderHelp(spec));
    return 0;
  }
  const text = (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);
  const reply = async (method: Parameters<typeof callDaemon>[1], params: Record<string, unknown>, connection: Awaited<ReturnType<typeof daemonFor>>) => {
    const result = await callDaemon<object>(connection, method, params, { writes: method !== 'journey.annotate', log: deps.daemon.log, timeoutMs: TIMEOUTS.journey, session: () => (params.journey as string) ?? undefined });
    await printDoc(deps.io, { ok: true, ...result });
    return 0;
  };

  if (sub === 'start') {
    const url = text('url');
    if (!url) throw usageError('missing_flag', 'jevway journey start needs --url', 'Example: jevway journey start --url https://stays.example');
    if (!URL.canParse(url)) throw usageError('invalid_value', `--url must be an absolute URL, got "${url}"`, 'Example: --url https://stays.example');
    const outDir = text('out-dir');
    const request = {
      url,
      device: choiceFlag('device', text('device'), Object.keys(DEVICES) as (keyof typeof DEVICES)[]),
      intent: text('intent'),
      values: jsonFlag('values', text('values'), LABELS, '{"query":"Lisbon"}'),
      stayWithin: text('stay-within'),
      outDir: outDir && resolve(deps.cwd, outDir),
    };
    const choice = runnerChoice(flags, deps.env);
    requireKey(runnerFor(deps, choice));
    return reply('journey.start', { request, runner: choice, place: placement(deps) }, await daemonFor(deps, { start: true }));
  }

  const journey = positionals[0] ?? text('journey');
  if (!journey) throw usageError('missing_flag', `jevway ${spec.name} needs the journey id`, `Example: jevway ${spec.name} <id>`);
  const connection = () => daemonFor(deps, { session: journey, kind: 'journey' });
  const notes = { description: text('description'), insight: text('insight') };
  switch (sub) {
    case 'step': {
      const next = text('next');
      if (!next) throw usageError('missing_flag', 'jevway journey step needs --next', 'Example: jevway journey step <id> --next 3');
      const input = { next: /^\d+$/.test(next) ? Number(next) : next, value: text('value'), flow: text('flow'), ...notes };
      return reply('journey.step', { journey, input }, await connection());
    }
    case 'autopilot': {
      const input = { screens: intFlag('screens', text('screens'), { min: 1, max: 30 }), flow: text('flow'), intent: text('intent') };
      return reply('journey.autopilot', { journey, input }, await connection());
    }
    case 'annotate': {
      const screen = text('screen');
      if (!screen) throw usageError('missing_flag', 'jevway journey annotate needs --screen', 'Example: jevway journey annotate <id> --screen s02 --description "Search results"');
      const relabel = jsonFlag('relabel', text('relabel'), RELABEL, '{"from_step":2,"to_step":4,"flow":"Checkout"}');
      const moved = relabel && { fromStep: relabel.from_step, toStep: relabel.to_step, flow: relabel.flow };
      return reply('journey.annotate', { journey, screen, notes, relabel: moved }, await connection());
    }
    default:
      return reply('journey.finish', { journey, keepTab: flags['keep-tab'] === true }, await connection());
  }
};
