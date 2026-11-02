#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDoctor } from './setup/doctor-command.ts';
import { loadEnvFile } from './setup/env-file.ts';
import { runSetup } from './setup/setup-command.ts';
import { runSkill } from './setup/skill-command.ts';
import { CHECKS, type Check } from './task/checks.ts';
import { createRunner } from './task/start-task.ts';

const USAGE = `jevway --goal "<outcome>" (--url <url> | --tab <url part>) [options]
jevway doctor [--plan] [--live]   check the setup (key, browser, Node, ffmpeg); --help for more
jevway setup                      set up the key, browser and MCP clients (interactive)
jevway setup --client <name> --print [--json]   how to register jevway with a client; changes nothing
jevway skill [--install <dir>]    print the agent skill, or copy it into a skills folder

  --values '{"city":"Lisbon"}'   text values Jev may type
  --secret-keys token,otp         keys of --values that are secrets: Jev sees the key only, output shows [secret:<key>]
  --files '{"avatar":"/abs/me.png"}'   files Jev may upload (absolute paths; Jev sees names, never paths)
  --done-when "<evidence>"        visible evidence of success
  --checks '[{"type":"url_contains","text":"/issues/"}]'   facts checked by code on the final page
  --browser auto|launch|launch-headless|http://127.0.0.1:9222   (default: auto, or $JEVWAY_BROWSER)
  --model jev|pplx-decider|clef-omni|clef|clef-flash|gpt-6-luna   decision model (default: jev, or $JEVWAY_MODEL)
  --screenshots off|fallback|always   marked screenshots, vision models only (default: per model, or $JEVWAY_SCREENSHOTS)
  --max-steps 40
  --allowed-hosts a.com,*.b.com   hosts the run may be on (narrows $JEVWAY_ALLOWED_HOSTS); leaving them ends it blocked
  --blocked-hosts ads.com         hosts it must never be on (adds to $JEVWAY_BLOCKED_HOSTS)
  --max-seconds 300               time budget; past it the run ends step_budget (Ctrl-C ends it blocked)
  --keep-open                     leave the tabs open (auto/remote browsers), including any the run's clicks opened
  --allow-coordinate-clicks       click a boxed control the DOM never reported (canvas, iframe); Jev 1.14 direct only
  --record <dir>                  sharp screenshot before every action + final page, summary.json, index.html

Prints one JSON summary. Exit code 0 only when status is "done".
Needs TYPESAFE_API_KEY (Jev only) or OPENROUTER_API_KEY (every model), from the environment or ~/.config/jevway/env.`;

// Keys and JEVWAY_* settings the environment lacks come from ~/.config/jevway/env.
const fromEnvFile = loadEnvFile();
if (process.argv[2] === 'doctor') process.exit(await runDoctor(process.argv.slice(3), fromEnvFile));
if (process.argv[2] === 'setup') process.exit(await runSetup(process.argv.slice(3), fromEnvFile));
if (process.argv[2] === 'skill') process.exit(await runSkill(process.argv.slice(3)));

const { values: args } = parseArgs({
  options: {
    goal: { type: 'string' },
    url: { type: 'string' },
    tab: { type: 'string' },
    values: { type: 'string' },
    'secret-keys': { type: 'string' },
    files: { type: 'string' },
    'done-when': { type: 'string' },
    checks: { type: 'string' },
    browser: { type: 'string' },
    model: { type: 'string' },
    screenshots: { type: 'string' },
    'max-steps': { type: 'string' },
    'max-seconds': { type: 'string' },
    'allowed-hosts': { type: 'string' },
    'blocked-hosts': { type: 'string' },
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

// Malformed checks, like model or key problems, are usage errors: report them before any browser starts.
let checks: Check[] | undefined;
try {
  checks = args.checks ? CHECKS.parse(JSON.parse(args.checks)) : undefined;
} catch (error) {
  console.error(`jevway: --checks: ${(error as Error).message}`);
  process.exit(2);
}

let runner: ReturnType<typeof createRunner>;
try {
  runner = createRunner(args.browser ?? process.env.JEVWAY_BROWSER ?? 'auto', {
    model: args.model,
    screenshots: args.screenshots,
  });
  runner.requireKey();
} catch (error) {
  console.error(`jevway: ${(error as Error).message}`);
  process.exit(2);
}

try {
  const task = await runner.start({
    goal: args.goal,
    url: args.url,
    tab: args.tab,
    values: args.values ? JSON.parse(args.values) : undefined,
    secretKeys: args['secret-keys']?.split(',').map((key) => key.trim()).filter(Boolean),
    files: args.files ? JSON.parse(args.files) : undefined,
    doneWhen: args['done-when'],
    checks,
    maxSteps: args['max-steps'] ? Number(args['max-steps']) : undefined,
    maxSeconds: args['max-seconds'] ? Number(args['max-seconds']) : undefined,
    allowedHosts: args['allowed-hosts']?.split(','),
    blockedHosts: args['blocked-hosts']?.split(','),
    allowCoordinateClicks: args['allow-coordinate-clicks'],
    recordDir: args.record,
  });
  // Ctrl-C stops the run at its next check (an action under way finishes), so the summary still prints and the tab closes.
  const cancel = new AbortController();
  process.once('SIGINT', () => cancel.abort());
  const summary = await task.run({ signal: cancel.signal });
  if (!args['keep-open']) await task.closeTabs({ keepFirst: !args.url });
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.status === 'done' ? 0 : 1;
} catch (error) {
  console.error(`jevway: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await runner.close();
}
