/** The newest run of one workflow on main. */
type WorkflowRun = { status: string; conclusion: string; headSha: string; url: string };

/** What the release flow knows about the repo, npm and GitHub at one moment. */
export type ReleaseState = {
  /** `version` in package.json on main: the last version release-please released. */
  local: string;
  /** The `latest` version on npm; undefined before the first publish. */
  published?: string;
  /** main's head commit on GitHub. */
  head: string;
  /** The open release-please PR, if any. */
  pr?: { number: number; title: string; url: string };
  /** The newest `ci` run on main. */
  ci?: WorkflowRun;
  /** The newest `release` run on main: release-please opens or updates the release PR there. */
  releasePlease?: WorkflowRun;
};

export type NextStep =
  | { kind: 'merge'; pr: number; version: string; message: string }
  | { kind: 'wait'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'nothing'; message: string };

const parts = (version: string) => version.split('-')[0].split('.').map(Number);

/** Compares two x.y.z versions: negative when a < b, 0 when equal, positive when a > b. */
export const compareVersions = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The version a release-please PR proposes, read from its title ("chore(main): release 0.2.0"). */
export const versionFromTitle = (title: string) => title.match(/release v?(\d+\.\d+\.\d+\S*)$/)?.[1];

/** The patch after `version`, the default for a forced release. */
export const nextPatch = (version: string) => {
  const [major, minor, patch] = parts(version);
  return `${major}.${minor}.${patch + 1}`;
};

/** Why `version` can't be forced as the next release, or undefined when it can. */
export const releaseAsProblem = (version: string, published?: string) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return `${version} is not a plain x.y.z version`;
  if (published && compareVersions(version, published) <= 0) return `${version} is not above the published ${published}`;
  return undefined;
};

const runProblem = (run: WorkflowRun | undefined, head: string, name: string, after: string): NextStep | undefined => {
  if (!run || run.headSha !== head) return { kind: 'wait', message: `${name} has not reported on main's head (${head.slice(0, 7)}) yet` };
  if (run.status !== 'completed') return { kind: 'wait', message: `${name} is still running on main${after}: ${run.url}` };
  if (run.conclusion !== 'success') return { kind: 'blocked', message: `${name} ${run.conclusion} on main: fix it before releasing: ${run.url}` };
  return undefined;
};

const ciProblem = ({ ci, head }: ReleaseState) => runProblem(ci, head, 'CI', '');
const releasePleaseProblem = ({ releasePlease, head }: ReleaseState) =>
  runProblem(releasePlease, head, 'release-please', ', so the release PR may not be open yet');

/** Decides the one next step of a release from the current state. */
export const nextStep = (state: ReleaseState): NextStep => {
  const { local, published, pr } = state;
  // A tag whose publish failed is left behind: the next release PR publishes past it.
  const unpublished = published && compareVersions(local, published) > 0 ? `v${local} is tagged but never reached npm (it has ${published})` : undefined;
  if (!pr) {
    const pending = releasePleaseProblem(state);
    if (pending) return pending;
    if (unpublished) return { kind: 'blocked', message: `${unpublished}: land a fix: commit for the next release PR, or pnpm release as ${nextPatch(local)}` };
    return { kind: 'nothing', message: `Nothing to release: no feat: or fix: commit since v${local}. To release anyway: pnpm release as ${nextPatch(local)}` };
  }
  const version = versionFromTitle(pr.title);
  if (!version) return { kind: 'blocked', message: `Can't read a version from release PR #${pr.number} ("${pr.title}"): ${pr.url}` };
  const message = `Release PR #${pr.number} publishes v${version}${unpublished ? ` (${unpublished})` : ''}: ${pr.url}`;
  return ciProblem(state) ?? { kind: 'merge', pr: pr.number, version, message };
};
