/**
 * The release flow, for a person, an agent or CI:
 *   pnpm release              status, then merge the release PR and wait until npm has it (asks first)
 *   pnpm release --yes        the same without asking
 *   pnpm release as 0.1.1     force the next version (pushes an empty Release-As commit to main), then release it
 *   pnpm release:status       read-only status; --json for scripts
 *   pnpm release:check        the publish gate locally: typecheck, test, build, npm pack --dry-run
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { nextStep, releaseAsProblem, type NextStep, type ReleaseState } from './state.ts';

const PACKAGE = 'jevway';
const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const [command = 'release', ...rest] = args.filter((arg) => !arg.startsWith('-'));

const run = (file: string, argv: string[]) => execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryRun = (file: string, argv: string[]) => {
  try {
    return run(file, argv);
  } catch {
    return undefined;
  }
};
const gh = (...argv: string[]) => run('gh', argv);
const json = <T>(text: string | undefined): T | undefined => (text ? (JSON.parse(text) as T) : undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const readState = (): ReleaseState => {
  const head = gh('api', 'repos/{owner}/{repo}/commits/main', '--jq', '.sha');
  const local = json<{ version: string }>(gh('api', 'repos/{owner}/{repo}/contents/package.json?ref=main', '-H', 'Accept: application/vnd.github.raw'))!.version;
  const pr = json<ReleaseState['pr'][]>(gh('pr', 'list', '--state', 'open', '--label', 'autorelease: pending', '--json', 'number,title,url', '--limit', '1'))?.[0];
  const newestRun = (workflow: string) =>
    json<ReleaseState['ci'][]>(gh('run', 'list', '--workflow', workflow, '--branch', 'main', '--event', 'push', '--limit', '1', '--json', 'status,conclusion,headSha,url'))?.[0];
  return { local, published: tryRun('npm', ['view', PACKAGE, 'version']), head, pr, ci: newestRun('ci.yml'), releasePlease: newestRun('release.yml') };
};

const printState = (state: ReleaseState, step: NextStep) => {
  console.log(`main        ${state.head.slice(0, 7)}  (package.json ${state.local})`);
  console.log(`npm         ${state.published ?? 'not published'}`);
  console.log(`CI on main  ${state.ci ? `${state.ci.conclusion || state.ci.status} on ${state.ci.headSha.slice(0, 7)}` : 'no run yet'}`);
  console.log(`release run ${state.releasePlease ? `${state.releasePlease.conclusion || state.releasePlease.status} on ${state.releasePlease.headSha.slice(0, 7)}` : 'no run yet'}`);
  console.log(`release PR  ${state.pr ? `#${state.pr.number} ${state.pr.title}` : 'none'}`);
  console.log(`\n→ ${step.message}`);
};

const confirm = async (question: string) => {
  if (yes) return true;
  if (!process.stdin.isTTY) fail(`${question} needs a yes: pass --yes to run without asking`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${question} [y/N] `);
  prompt.close();
  return /^y(es)?$/i.test(answer.trim());
};

/** Polls `read` every 5 s until it returns something, or gives up after `seconds`. */
const waitFor = async <T>(what: string, seconds: number, read: () => T | undefined): Promise<T> => {
  for (let waited = 0; waited <= seconds; waited += 5) {
    const value = read();
    if (value !== undefined) return value;
    if (waited === 0) console.log(`… waiting for ${what}`);
    await sleep(5000);
  }
  return fail(`gave up waiting ${seconds}s for ${what}`);
};

const watch = (runId: number, what: string) => {
  const watched = spawnSync('gh', ['run', 'watch', String(runId), '--exit-status', '--compact'], { stdio: 'inherit' });
  if (watched.status !== 0) fail(`${what} failed: gh run view ${runId} --log-failed`);
};

/** Runs CI on the release PR's own commit: a PR opened by GitHub Actions triggers no workflow by itself. */
const checkReleasePr = async (pr: number) => {
  const head = json<{ headRefName: string; headRefOid: string }>(gh('pr', 'view', String(pr), '--json', 'headRefName,headRefOid'))!;
  gh('workflow', 'run', 'ci.yml', '--ref', head.headRefName);
  const runId = await waitFor(`CI to start on release PR #${pr}`, 120, () =>
    json<{ databaseId: number; headSha: string }[]>(
      tryRun('gh', ['run', 'list', '--workflow', 'ci.yml', '--branch', head.headRefName, '--event', 'workflow_dispatch', '--json', 'databaseId,headSha']),
    )?.find((run) => run.headSha === head.headRefOid)?.databaseId,
  );
  watch(runId, `CI on release PR #${pr}`);
  console.log(`✓ CI passed on release PR #${pr}`);
};

const publish = async (pr: number, version: string) => {
  await checkReleasePr(pr);
  // Rebase keeps the bot's single commit as is, with no co-author trailer a squash would add.
  gh('pr', 'merge', String(pr), '--rebase', '--delete-branch');
  const sha = gh('pr', 'view', String(pr), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid');
  console.log(`✓ merged #${pr} as ${sha.slice(0, 7)}`);
  const runId = await waitFor('the release workflow to start', 120, () =>
    json<{ databaseId: number }[]>(tryRun('gh', ['run', 'list', '--workflow', 'release.yml', '--commit', sha, '--json', 'databaseId']))?.[0]?.databaseId,
  );
  watch(runId, 'the release workflow');
  await waitFor(`npm to list ${PACKAGE}@${version}`, 180, () => tryRun('npm', ['view', `${PACKAGE}@${version}`, 'version']) || undefined);
  console.log(`✓ ${PACKAGE}@${version} is live: https://www.npmjs.com/package/${PACKAGE}/v/${version}`);
};

/** The next step once release-please and CI have finished on main's head, printing the state on the way. */
const settledStep = async (): Promise<NextStep> => {
  const state = readState();
  const step = nextStep(state);
  printState(state, step);
  if (step.kind !== 'wait') return step;
  const settled = await waitFor('release-please and CI to finish on main', 600, () => {
    const next = nextStep(readState());
    return next.kind === 'wait' ? undefined : next;
  });
  console.log(`→ ${settled.message}`);
  return settled;
};

const release = async () => {
  const step = await settledStep();
  if (step.kind === 'nothing') return;
  if (step.kind !== 'merge') process.exit(1);
  if (!(await confirm(`Merge #${step.pr} and publish ${PACKAGE}@${step.version} to npm?`))) return;
  await publish(step.pr, step.version);
};

const releaseAs = async (version: string | undefined) => {
  if (!version) fail('usage: pnpm release as <x.y.z>');
  const problem = releaseAsProblem(version!, tryRun('npm', ['view', PACKAGE, 'version']));
  if (problem) fail(problem);
  if (run('git', ['status', '--porcelain'])) fail('the working tree has changes: commit or stash them first');
  if (run('git', ['branch', '--show-current']) !== 'main') fail('switch to main first');
  run('git', ['fetch', 'origin', 'main']);
  if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'origin/main'])) fail('main differs from origin/main: pull or push first');
  if (!(await confirm(`Push an empty "Release-As: ${version}" commit to main and publish ${PACKAGE}@${version}?`))) return;
  run('git', ['commit', '--allow-empty', '-m', `chore: release ${version}`, '-m', `Release-As: ${version}`]);
  run('git', ['push', 'origin', 'main']);
  console.log(`✓ pushed the Release-As commit`);
  const pr = await waitFor('release-please to open the release PR', 300, () =>
    json<{ number: number; title: string }[]>(tryRun('gh', ['pr', 'list', '--state', 'open', '--label', 'autorelease: pending', '--json', 'number,title']))?.find((open) => open.title.endsWith(version!)),
  );
  await waitFor('CI to pass on main', 600, () => {
    const step = nextStep(readState());
    if (step.kind === 'blocked') fail(step.message);
    return step.kind === 'merge' ? step : undefined;
  });
  await publish(pr.number, version!);
};

const check = () => {
  // A clean dist/, as prepublishOnly makes it, so a moved file never ships twice.
  rmSync('dist', { recursive: true, force: true });
  const steps: [string, string[]][] = [
    ['pnpm', ['typecheck']],
    ['pnpm', ['test']],
    ['pnpm', ['build']],
    ['npm', ['pack', '--dry-run']],
  ];
  for (const [file, argv] of steps) {
    console.log(`\n$ ${file} ${argv.join(' ')}`);
    if (spawnSync(file, argv, { stdio: 'inherit' }).status !== 0) fail(`${file} ${argv.join(' ')} failed`);
  }
  console.log(`\n✓ ready to publish ${PACKAGE}@${json<{ version: string }>(readFileSync('package.json', 'utf8'))!.version}`);
};

const status = () => {
  const state = readState();
  const step = nextStep(state);
  if (args.includes('--json')) console.log(JSON.stringify({ ...state, next: step }, null, 2));
  else printState(state, step);
};

const commands: Record<string, () => unknown> = { release, as: () => releaseAs(rest[0]), status, check };
if (!commands[command]) fail(`unknown command ${command}: use release, as <x.y.z>, status or check`);
await commands[command]();
