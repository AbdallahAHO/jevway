/**
 * Seeds, resets and reads the throwaway Forgejo from `compose.yml`, all through its REST API (`/api/v1`) as the admin.
 * Write suites reset the demo before every run and judge a run by reading the app's own state back, never by what the
 * agent said it did. Local test data only: the passwords below are not secrets.
 *
 *   node verify/apps/forgejo/seed.ts users     # once after `docker compose up`: the admin and the user ada (idempotent)
 *   node verify/apps/forgejo/seed.ts reset     # ada/app and ada/scratch back to the seeded state
 *
 * @example
 * await resetDemo();
 * (await labelsOf(await issueByTitle('Add dark mode'))).includes('help wanted'); // false until a run adds it
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const ORIGIN = 'http://127.0.0.1:3311';
export const ADA = { username: 'ada', password: 'ada-pass-1234', email: 'ada@jev.test' };
const ADMIN = { username: 'jev-admin', password: 'jev-admin-pass-1', email: 'jev-admin@jev.test' };
const API = `${ORIGIN}/api/v1`;
const COMPOSE = ['compose', '-p', 'jev-forgejo', '-f', new URL('compose.yml', import.meta.url).pathname];
const run = promisify(execFile);

export interface Issue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: { name: string }[];
}

// Basic auth costs ~80 ms a request (password hashing); a token ~15 ms. One token per process, minted on first use.
let adminToken: Promise<string> | undefined;
const mintAdminToken = async () => {
  const basic = Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64');
  const response = await fetch(`${API}/users/${ADMIN.username}/tokens`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `jev-seed-${process.pid}-${Date.now()}`, scopes: ['all'] }),
  });
  if (!response.ok) throw new Error(`Cannot mint an admin token (${response.status}): ${await response.text()}`);
  return `token ${(await response.json()).sha1}`;
};

const request = async (method: string, path: string, body?: unknown) => {
  adminToken ??= mintAdminToken();
  return fetch(`${API}${path}`, {
    method,
    headers: { authorization: await adminToken, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
};

// A call that must succeed: anything else is a seeding bug worth stopping for.
const send = async (method: string, path: string, body?: unknown) => {
  const response = await request(method, path, body);
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
  return response;
};

// A read: undefined when the thing does not exist (so a deleted repo reads as gone, not as an error).
const read = async <T>(path: string): Promise<T | undefined> => {
  const response = await request('GET', path);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}: ${await response.text()}`);
  return response.json();
};

/** True when Forgejo answers on its port: suites check this first and stop with a clear message otherwise. */
export const stackIsUp = () =>
  fetch(`${API}/version`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.ok, () => false);

/** The admin and the user ada exist; safe to run again. The admin comes from the CLI because the API needs one to start. */
export const ensureUsers = async () => {
  const basic = Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64');
  const adminExists = (await fetch(`${API}/user`, { headers: { authorization: `Basic ${basic}` } })).ok;
  if (!adminExists) {
    await run('docker', [
      ...COMPOSE, 'exec', '-T', '-u', 'git', 'forgejo', 'forgejo', 'admin', 'user', 'create', '--admin',
      '--username', ADMIN.username, '--password', ADMIN.password, '--email', ADMIN.email, '--must-change-password=false',
    ]);
  }
  if (!(await read(`/users/${ADA.username}`))) {
    await send('POST', '/admin/users', { ...ADA, must_change_password: false, visibility: 'public' });
  }
};

const LABELS = [
  { name: 'bug', color: '#d73a4a' },
  { name: 'help wanted', color: '#008672' },
  { name: 'enhancement', color: '#a2eeef' },
  { name: 'wontfix', color: '#cccccc' },
];
const ISSUES = [
  { title: 'Login fails on Safari', body: 'Clicking "Sign in" does nothing on Safari 17.' },
  { title: 'Typo in README', body: 'The install section says "pnpm instal".' },
  { title: 'Add dark mode', body: 'It would be easier on the eyes at night.' },
];

const createRepo = (name: string, description: string) =>
  send('POST', `/admin/users/${ADA.username}/repos`, { name, description, auto_init: true, default_branch: 'main', readme: 'Default', private: false });

/**
 * Deletes and recreates `ada/app` (README, four labels, three issues, wiki on, no milestones) and `ada/scratch`, so a
 * run starts from the same state whatever the last run did. About two seconds.
 */
export const resetDemo = async () => {
  await Promise.all(['app', 'scratch'].map((name) => request('DELETE', `/repos/${ADA.username}/${name}`)));
  await Promise.all([createRepo('app', 'Demo app'), createRepo('scratch', 'Scratch repository')]);
  await Promise.all(LABELS.map((label) => send('POST', `/repos/${ADA.username}/app/labels`, label)));
  // One at a time: the numbers #1 to #3 follow the order.
  for (const issue of ISSUES) await send('POST', `/repos/${ADA.username}/app/issues`, issue);
};

// Readers for the suite's `passes`: the app's own state, as admin.

/** The labels of a repository. */
export const labels = async (repoPath = `${ADA.username}/app`) =>
  (await read<{ name: string }[]>(`/repos/${repoPath}/labels?limit=50`)) ?? [];

/** The issue with exactly this title, open or closed. */
export const issueByTitle = async (title: string, repoPath = `${ADA.username}/app`) =>
  ((await read<Issue[]>(`/repos/${repoPath}/issues?state=all&type=issues&limit=50`)) ?? []).find((issue) => issue.title.trim() === title.trim());

/** Label names on an issue; none for an issue that does not exist. */
export const labelsOf = (issue: Issue | undefined) => issue?.labels.map((label) => label.name) ?? [];

/** The comment bodies on an issue. */
export const comments = async (issue: Pick<Issue, 'number'>, repoPath = `${ADA.username}/app`) =>
  ((await read<{ body: string }[]>(`/repos/${repoPath}/issues/${issue.number}/comments`)) ?? []).map((comment) => comment.body);

/** A repository of ada's, or undefined when it does not exist. */
export const repo = (name: string) =>
  read<{ name: string; description: string; has_wiki: boolean; default_branch: string }>(`/repos/${ADA.username}/${name}`);

/** The names of every repository ada owns. */
export const reposOfAda = async () =>
  ((await read<{ name: string }[]>(`/users/${ADA.username}/repos?limit=50`)) ?? []).map((r) => r.name);

/** The milestone titles of `ada/app`, open or closed. */
export const milestones = async () =>
  ((await read<{ title: string }[]>(`/repos/${ADA.username}/app/milestones?state=all&limit=50`)) ?? []).map((m) => m.title);

/** The branch names that have a protection rule in `ada/app`. */
export const branchProtections = async () =>
  ((await read<{ branch_name?: string; rule_name?: string }[]>(`/repos/${ADA.username}/app/branch_protections`)) ?? []).map(
    (rule) => rule.rule_name || rule.branch_name || '',
  );

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command === 'users') {
    await ensureUsers();
    process.stdout.write(`users ready: ${ADMIN.username}, ${ADA.username}\n`);
  } else if (command === 'reset') {
    const started = Date.now();
    await resetDemo();
    process.stdout.write(`demo reset in ${Date.now() - started}ms\n`);
  } else {
    process.stderr.write('usage: node verify/apps/forgejo/seed.ts users | reset\n');
    process.exitCode = 2;
  }
}
