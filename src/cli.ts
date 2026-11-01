#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRunner } from './task/start-task.ts';

const USAGE = `jev-browse --goal "<outcome>" (--url <url> | --tab <url part>) [options]

  --values '{"city":"Lisbon"}'   text values Jev may type
  --done-when "<evidence>"        visible evidence of success
  --browser auto|launch|launch-headless|http://127.0.0.1:9222   (default: auto, or $JEV_BROWSER)
  --model jev|pplx-decider|clef-omni|clef|clef-flash|gpt-6-luna   decision model (default: jev, or $JEV_MODEL)
  --screenshots off|fallback|always   marked screenshots, vision models only (default: per model, or $JEV_SCREENSHOTS)
  --max-steps 40
  --max-seconds 300               time budget; past it the run ends step_budget (Ctrl-C ends it blocked)
  --keep-open                     leave the tab open (auto/remote browsers)
  --allow-coordinate-clicks       click a boxed control the DOM never reported (canvas, iframe); Jev 1.14 direct only
  --record <dir>                  sharp screenshot before every action + final page, summary.json, index.html

Prints one JSON summary. Exit code 0 only when status is "done".
Needs TYPESAFE_API_KEY (Jev only) or OPENROUTER_API_KEY (every model).`;

const { values: args } = parseArgs({
  options: {
    goal: { type: 'string' },
    url: { type: 'string' },
    tab: { type: 'string' },
    values: { type: 'string' },
    'done-when': { type: 'string' },
    browser: { type: 'string' },
    model: { type: 'string' },
    screenshots: { type: 'string' },
    'max-steps': { type: 'string' },
    'max-seconds': { type: 'string' },
    'keep-open': { type: 'boolean' },
    'allow-coordinate-clicks': { type: 'boolean' },
    record: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help || !args.goal || !(args.url || args.tab)) {
  console.error(USAGE);
  process.exit(args.help ? 0 : 2);
}

// Model or key problems are usage errors: report them before any browser starts.
let runner: ReturnType<typeof createRunner>;
try {
  runner = createRunner(args.browser ?? process.env.JEV_BROWSER ?? 'auto', {
    model: args.model,
    screenshots: args.screenshots,
  });
} catch (error) {
  console.error(`jev-browse: ${(error as Error).message}`);
  process.exit(2);
}

try {
  const task = await runner.start({
    goal: args.goal,
    url: args.url,
    tab: args.tab,
    values: args.values ? JSON.parse(args.values) : undefined,
    doneWhen: args['done-when'],
    maxSteps: args['max-steps'] ? Number(args['max-steps']) : undefined,
    maxSeconds: args['max-seconds'] ? Number(args['max-seconds']) : undefined,
    allowCoordinateClicks: args['allow-coordinate-clicks'],
    recordDir: args.record,
  });
  // Ctrl-C stops the run at its next check (an action under way finishes), so the summary still prints and the tab closes.
  const cancel = new AbortController();
  process.once('SIGINT', () => cancel.abort());
  const summary = await task.run({ signal: cancel.signal });
  if (args.url && !args['keep-open']) await task.tab.close();
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.status === 'done' ? 0 : 1;
} catch (error) {
  console.error(`jev-browse: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await runner.close();
}
