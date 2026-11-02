import { describe, expect, it } from 'vitest';
import { compareVersions, nextPatch, nextStep, releaseAsProblem, versionFromTitle, type ReleaseState } from '../release/state.ts';

const HEAD = 'abc1234def';
const green = { status: 'completed', conclusion: 'success', headSha: HEAD, url: 'https://ci/1' };
const pr = { number: 7, title: 'chore(main): release 0.2.0', url: 'https://pr/7' };
const state = (over: Partial<ReleaseState> = {}): ReleaseState => ({ local: '0.1.0', published: '0.1.0', head: HEAD, ci: green, ...over });

describe('the next release step', () => {
  it('merges the open release PR once CI is green on main', () => {
    expect(nextStep(state({ pr }))).toEqual({ kind: 'merge', pr: 7, version: '0.2.0', message: 'Release PR #7 publishes v0.2.0: https://pr/7' });
  });

  it('says there is nothing to release without a release PR, and how to force one', () => {
    expect(nextStep(state())).toMatchObject({ kind: 'nothing', message: expect.stringContaining('pnpm release as 0.1.1') });
  });

  it('waits while CI runs or has not reached main’s head, and refuses a red main', () => {
    expect(nextStep(state({ pr, ci: { ...green, status: 'in_progress', conclusion: '' } }))).toMatchObject({ kind: 'wait' });
    expect(nextStep(state({ pr, ci: { ...green, headSha: 'older' } }))).toMatchObject({ kind: 'wait' });
    expect(nextStep(state({ pr, ci: undefined }))).toMatchObject({ kind: 'wait' });
    expect(nextStep(state({ pr, ci: { ...green, conclusion: 'failure' } }))).toMatchObject({ kind: 'blocked', message: expect.stringContaining('https://ci/1') });
  });

  it('points at the publish job when a tagged version never reached npm', () => {
    expect(nextStep(state({ local: '0.2.0', published: '0.1.0' }))).toMatchObject({ kind: 'blocked', message: expect.stringContaining('publish job failed') });
  });

  it('refuses a release PR whose title names no version', () => {
    expect(nextStep(state({ pr: { ...pr, title: 'chore: something' } }))).toMatchObject({ kind: 'blocked' });
  });
});

describe('versions', () => {
  it('orders x.y.z numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
  });

  it('reads the version from a release-please title, with or without a v', () => {
    expect(versionFromTitle('chore(main): release 0.2.0')).toBe('0.2.0');
    expect(versionFromTitle('chore(main): release v1.0.0')).toBe('1.0.0');
    expect(versionFromTitle('docs: release notes')).toBeUndefined();
  });

  it('forces only a plain version above the published one', () => {
    expect(nextPatch('0.1.9')).toBe('0.1.10');
    expect(releaseAsProblem('0.1.1', '0.1.0')).toBeUndefined();
    expect(releaseAsProblem('0.1.0', '0.1.0')).toMatch(/not above/);
    expect(releaseAsProblem('v0.2', '0.1.0')).toMatch(/not a plain/);
  });
});
