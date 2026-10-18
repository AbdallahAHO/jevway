/**
 * Seeds, resets and reads the throwaway Vikunja from `compose.yml`, all through its REST API (`/api/v1`) as the user
 * grace. The held-back suite resets the demo before every run and judges a run by reading the app's own state back,
 * never by what the agent said it did. Local test data only: the password below is not a secret.
 *
 *   node verify/apps/vikunja/seed.ts users     # once after `docker compose up`: grace, in this machine's timezone (idempotent)
 *   node verify/apps/vikunja/seed.ts reset     # grace's projects, tasks and labels back to the seeded state
 *
 * @example
 * await resetDemo();
 * (await taskByTitle('Fix broken signup link'))?.labels; // null until a run labels it
 *
 * const project = await projectByTitle('Website relaunch');
 * (await tasksOf(project!.id)).length; // 7
 */

export const ORIGIN = 'http://127.0.0.1:3312';
export const GRACE = { username: 'grace', password: 'grace-pass-1234', email: 'grace@jev.test' };
/** Grace's timezone: the machine's, so a due date and the date a browser picks fall on the same calendar day. */
export const GRACE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const API = `${ORIGIN}/api/v1`;

export interface Project {
  id: number;
  title: string;
}

export interface Task {
  id: number;
  title: string;
  done: boolean;
  priority: number;
  /** An ISO date; Vikunja writes `0001-01-01T00:00:00Z` for none. */
  due_date: string;
  project_id: number;
  labels: { id: number; title: string }[] | null;
}

// Vikunja shows a task's date as the zero time when none is set.
const NO_DATE = '0001-01-01T00:00:00Z';
// A saved filter is listed among the projects with a negative id (grace starts with one, "My Open Tasks"); it is no project.
const isProject = (project: Project) => project.id > 0;

// One token per process, minted on first use (a login costs ~80 ms of password hashing).
let token: Promise<string> | undefined;
const login = async () => {
  const response = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: GRACE.username, password: GRACE.password }),
  });
  if (!response.ok) throw new Error(`Cannot log in as ${GRACE.username} (${response.status}): ${await response.text()}`);
  return `Bearer ${(await response.json()).token}`;
};

const request = async (method: string, path: string, body?: unknown) => {
  token ??= login();
  return fetch(`${API}${path}`, {
    method,
    headers: { authorization: await token, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
};

/** A call that must succeed: anything else is a seeding bug worth stopping for. */
export const send = async (method: string, path: string, body?: unknown) => {
  const response = await request(method, path, body);
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
  return response;
};

// A read: undefined when the thing does not exist (so a deleted project reads as gone, not as an error).
const read = async <T>(path: string): Promise<T | undefined> => {
  const response = await request('GET', path);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}: ${await response.text()}`);
  return response.json();
};

// Vikunja pages every list at 50; a list ends on the first short page.
const readAll = async <T>(path: string): Promise<T[]> => {
  const everything: T[] = [];
  const joiner = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const batch = (await read<T[]>(`${path}${joiner}per_page=50&page=${page}`)) ?? [];
    everything.push(...batch);
    if (batch.length < 50) return everything;
  }
};

/** True when Vikunja answers on its port: suites check this first and stop with a clear message otherwise. */
export const stackIsUp = () =>
  fetch(`${API}/info`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.ok, () => false);

/** Grace exists, in this machine's timezone with no default project; safe to run again. */
export const ensureUsers = async () => {
  const loggedIn = await login().then(() => true, () => false);
  if (!loggedIn) {
    const response = await fetch(`${API}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(GRACE),
    });
    if (!response.ok) throw new Error(`Cannot register ${GRACE.username} (${response.status}): ${await response.text()}`);
  }
  // The settings call replaces every field, so it sends the current ones back with only these two changed.
  const user = await (await send('GET', '/user')).json();
  await send('POST', '/user/settings/general', { ...user.settings, timezone: GRACE_TIMEZONE, default_project_id: 0 });
};

// Midday, so a date stays the same calendar day in any timezone near grace's.
const middayIn = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  day.setHours(12, 0, 0, 0);
  return day.toISOString();
};

// The seeded state, in creation order. Only "Renew SSL certificate" is overdue; only "Plan launch party" has a later date.
const PROJECTS: { title: string; tasks: { title: string; due?: number }[] }[] = [
  {
    title: 'Website relaunch',
    tasks: [
      { title: 'Write launch announcement' },
      { title: 'Fix broken signup link' },
      { title: 'Order team T-shirts' },
      { title: 'Migrate DNS' },
      { title: 'Draft press kit' },
      { title: 'Renew SSL certificate', due: -1 },
      { title: 'Plan launch party', due: 20 },
    ],
  },
  { title: 'Archive', tasks: [] },
  { title: 'Old experiments', tasks: [{ title: 'Try new font' }] },
];
const LABELS = ['urgent'];

/** The three seeded projects' titles, and the seven tasks of the first. */
export const SEEDED_PROJECT_TITLES = PROJECTS.map((project) => project.title);
export const RELAUNCH_TASK_TITLES = PROJECTS[0].tasks.map((task) => task.title);

/**
 * Deletes everything grace owns and recreates three projects ("Website relaunch" with seven tasks, "Archive", "Old
 * experiments" with one task) and the label "urgent", attached to nothing. About two seconds.
 */
export const resetDemo = async () => {
  const [projects, labels] = await Promise.all([
    readAll<Project>('/projects?is_archived=true'),
    readAll<{ id: number }>('/labels'),
  ]);
  // A parent takes its sub-projects with it, so a child may already be gone: not an error.
  for (const project of projects.filter(isProject)) await request('DELETE', `/projects/${project.id}`);
  await Promise.all(labels.map((label) => request('DELETE', `/labels/${label.id}`)));
  await Promise.all(LABELS.map((title) => send('PUT', '/labels', { title })));
  // One at a time: the tasks' indexes (#1 to #7) follow the order.
  for (const { title, tasks } of PROJECTS) {
    const project: Project = await (await send('PUT', '/projects', { title })).json();
    for (const { title: taskTitle, due } of tasks) {
      await send('PUT', `/projects/${project.id}/tasks`, {
        title: taskTitle,
        ...(due !== undefined && { due_date: middayIn(due) }),
      });
    }
  }
};

// Readers for the suite's `passes`: the app's own state, as grace.

/** The titles of every project grace owns, archived or not. */
export const projectsOfGrace = async () =>
  (await readAll<Project>('/projects?is_archived=true')).filter(isProject).map((project) => project.title);

/** The project with exactly this title, or undefined when grace has none. */
export const projectByTitle = async (title: string) =>
  (await readAll<Project>('/projects?is_archived=true')).filter(isProject).find((project) => project.title.trim() === title.trim());

/** Every task of a project, done or not. */
export const tasksOf = (projectId: number) => readAll<Task>(`/projects/${projectId}/tasks`);

/** Every task in any of grace's projects, done or not. */
export const allTasks = () => readAll<Task>('/tasks');

/** The task with exactly this title in any of grace's projects, done or not. */
export const taskByTitle = async (title: string) =>
  (await allTasks()).find((task) => task.title.trim() === title.trim());

/** Label titles on a task; none for a task that does not exist. */
export const labelsOf = (task: Task | undefined) => task?.labels?.map((label) => label.title) ?? [];

/** The text of each comment on a task: Vikunja's editor stores them as HTML, so tags are dropped. */
export const commentsOf = async (taskId: number) =>
  ((await read<{ comment: string }[]>(`/tasks/${taskId}/comments`)) ?? []).map((comment) =>
    comment.comment.replace(/<[^>]*>/g, '').trim(),
  );

/** True when the task has a due date. */
export const hasDueDate = (task: Task | undefined) => Boolean(task) && task!.due_date !== NO_DATE;

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command === 'users') {
    await ensureUsers();
    process.stdout.write(`users ready: ${GRACE.username} (${GRACE_TIMEZONE})\n`);
  } else if (command === 'reset') {
    const started = Date.now();
    await resetDemo();
    process.stdout.write(`demo reset in ${Date.now() - started}ms\n`);
  } else {
    process.stderr.write('usage: node verify/apps/vikunja/seed.ts users | reset\n');
    process.exitCode = 2;
  }
}
