#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRunner } from './task/start-task.ts';

const USAGE = `jev-browse --goal "<outcome>" (--url <url> | --tab <url part>) [options]

  --values '{"city":"Lisbon"}'   text values Jev may type
  --done-when "<evidence>"        visible evidence of success
  --browser auto|launch|launch-headless|http://127.0.0.1:9222   (default: auto, or $JEV_BROWSER)
  --max-steps 40
  --keep-open                     leave the tab open (auto/remote browsers)

Prints one JSON summary. Exit code 0 only when status is "done". Needs TYPESAFE_API_KEY.`;

const { values: args } = parseArgs({
  options: {
    goal: { type: 'string' },
    url: { type: 'string' },
    tab: { type: 'string' },
    values: { type: 'string' },
    'done-when': { type: 'string' },
    browser: { type: 'string' },
    'max-steps': { type: 'string' },
    'keep-open': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help || !args.goal || !(args.url || args.tab)) {
  console.error(USAGE);
  process.exit(args.help ? 0 : 2);
}

const runner = createRunner(args.browser ?? process.env.JEV_BROWSER ?? 'auto');
try {
  const task = await runner.start({
    goal: args.goal,
    url: args.url,
    tab: args.tab,
    values: args.values ? JSON.parse(args.values) : undefined,
    doneWhen: args['done-when'],
    maxSteps: args['max-steps'] ? Number(args['max-steps']) : undefined,
  });
  const summary = await task.run();
  if (args.url && !args['keep-open']) await task.tab.close();
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.status === 'done' ? 0 : 1;
} catch (error) {
  console.error(`jev-browse: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await runner.close();
}
