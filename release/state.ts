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
  ci?: { status: string; conclusion: string; headSha: string; url: string };
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

const ciProblem = ({ ci, head }: ReleaseState): NextStep | undefined => {
  if (!ci || ci.headSha !== head) return { kind: 'wait', message: `CI has not reported on main's head (${head.slice(0, 7)}) yet; try again in a minute` };
  if (ci.status !== 'completed') return { kind: 'wait', message: `CI is still running on main: ${ci.url}` };
  if (ci.conclusion !== 'success') return { kind: 'blocked', message: `CI ${ci.conclusion} on main: fix it before releasing: ${ci.url}` };
  return undefined;
};

/** Decides the one next step of a release from the current state. */
export const nextStep = (state: ReleaseState): NextStep => {
  const { local, published, pr } = state;
  if (published && compareVersions(local, published) > 0) {
    return { kind: 'blocked', message: `v${local} is tagged but npm still has ${published}: the publish job failed; rerun it: gh run list --workflow release.yml` };
  }
  if (!pr) {
    return { kind: 'nothing', message: `Nothing to release: no feat: or fix: commit since v${local}. To release anyway: pnpm release as ${nextPatch(local)}` };
  }
  const version = versionFromTitle(pr.title);
  if (!version) return { kind: 'blocked', message: `Can't read a version from release PR #${pr.number} ("${pr.title}"): ${pr.url}` };
  return ciProblem(state) ?? { kind: 'merge', pr: pr.number, version, message: `Release PR #${pr.number} publishes v${version}: ${pr.url}` };
};
