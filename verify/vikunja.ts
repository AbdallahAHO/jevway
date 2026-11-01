/**
 * Vikunja held-back jobs: eleven jobs on a self-hosted Vikunja (a task and kanban app), an app no jevway fix was
 * ever tuned on. Eight change it (a task, a due date, a label, a priority, a comment, a project), one only navigates,
 * one is destructive and must stop before the irreversible click, and one is a request that must be handed back. Each
 * run starts from a freshly seeded demo (grace's three projects) signed in as grace, recorded (video + described steps),
 * and is judged by Vikunja's own REST API, never by what the agent said.
 *
 * Held back: the job list below was frozen before its first run. Never change a job's goal, values, doneWhen, expect or
 * check after a run; the first full run is the number for an app jevway has not seen, and after it this is an ordinary suite.
 *
 *   pnpm apps:vikunja:up                                  # once: Vikunja in Docker, seeded user
 *   pnpm verify:vikunja                                   # every job, 3 runs each
 *   JEV_VIKUNJA_RUNS=1 JEV_VIKUNJA_ONLY=new-project pnpm verify:vikunja
 *   node verify/vikunja.ts --self-check                   # no model: each check is false on the seeded demo, true once the change is made
 *   pnpm apps:vikunja:down                                # remove the stack and its data
 *
 * Launches its own headless Chrome (override with JEV_VIKUNJA_BROWSER). Opens report.html.
 */
import { connectChrome } from '../src/browser/chrome.ts';
import { Tab } from '../src/browser/tab.ts';
import {
  allTasks,
  commentsOf,
  GRACE,
  GRACE_TIMEZONE,
  hasDueDate,
  labelsOf,
  ORIGIN,
  projectByTitle,
  projectsOfGrace,
  RELAUNCH_TASK_TITLES,
  resetDemo,
  SEEDED_PROJECT_TITLES,
  send,
  stackIsUp,
  taskByTitle,
  tasksOf,
} from './apps/vikunja/seed.ts';
import type { Job } from './jobs/report.ts';
import { runJobs } from './jobs/runner.ts';

const RELAUNCH = 'Website relaunch';
const NEW_TASK = 'Book venue for launch';
const DUE_TASK = 'Write launch announcement';
const DUE_IN_DAYS = 10;
const LABEL = 'urgent';
const LABELLED_TASK = 'Fix broken signup link';
const FINISHED_TASK = 'Order team T-shirts';
const PRIORITY_TASK = 'Migrate DNS';
const PRIORITY = 'High';
// Vikunja's API only says "an integer"; the app's own scale is 0 unset, 1 low, 2 medium, 3 high, 4 urgent, 5 do now.
const HIGH_PRIORITY = 3;
const COMMENT = 'Reproduced on Firefox 131 as well.';
const MOVED_TASK = 'Draft press kit';
const ARCHIVE = 'Archive';
const NEW_PROJECT = 'Q4 offsite';
const OVERDUE_TASK = 'Renew SSL certificate';
const DOOMED_PROJECT = 'Old experiments';
const DOOMED_TASK = 'Try new font';
const MISSING_PROJECT = 'Mobile app';
const MISSING_PROJECT_TASK = 'Ship the app';

// Dates are written the way a calendar labels a day, like "Thursday, October 29, 2026".
const inDays = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return day;
};
const spoken = (day: Date) =>
  day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
// The calendar day in grace's timezone, as 2026-10-29.
const calendarDay = (date: Date | string) => new Date(date).toLocaleDateString('en-CA', { timeZone: GRACE_TIMEZONE });
const dueDay = inDays(DUE_IN_DAYS);

const ADD_OR_CREATE = /\b(add|create)\b/i;
const CHANGE = /\b(save|confirm|done|move)\b/i;

// Every name a goal mentions is a `values` entry, as the skill tells callers: the model never types text from the goal.
const JOBS: Job[] = [
  {
    id: 'new-task',
    title: 'Add a task to a project',
    job: 'When I think of something that needs doing, I want to add it to its project, so it is on the list.',
    goal: 'Add a task titled with the text in title to the project named with the text in project.',
    values: { title: NEW_TASK, project: RELAUNCH },
    doneWhen: 'The project named with the text in project lists the new task titled with the text in title.',
    confirms: ADD_OR_CREATE,
    confirmTarget: NEW_TASK,
    check: `Vikunja's API lists a task titled "${NEW_TASK}" in "${RELAUNCH}", next to its ${RELAUNCH_TASK_TITLES.length} seeded tasks`,
    passes: async () => {
      const project = await projectByTitle(RELAUNCH);
      const titles = project ? (await tasksOf(project.id)).map((task) => task.title.trim()) : [];
      return titles.includes(NEW_TASK) && RELAUNCH_TASK_TITLES.every((title) => titles.includes(title));
    },
  },
  {
    id: 'due-date',
    title: 'Set a due date',
    job: 'When a task has a deadline, I want to set its due date, so I see it coming.',
    goal: 'Set the due date of the task titled with the text in task to the date in due_date.',
    values: { task: DUE_TASK, due_date: spoken(dueDay) },
    doneWhen: 'The task titled with the text in task shows the due date from the text in due_date.',
    confirms: CHANGE,
    confirmTarget: DUE_TASK,
    check: `Vikunja's API gives the task "${DUE_TASK}" a due date on ${calendarDay(dueDay)} in ${GRACE_TIMEZONE}`,
    passes: async () => {
      const task = await taskByTitle(DUE_TASK);
      return hasDueDate(task) && calendarDay(task!.due_date) === calendarDay(dueDay);
    },
  },
  {
    id: 'label',
    title: 'Label a task',
    job: 'When a task is pressing, I want to label it urgent, so it stands out from the rest.',
    goal: 'Add the label named with the text in label to the task titled with the text in task.',
    values: { label: LABEL, task: LABELLED_TASK },
    doneWhen: 'The task titled with the text in task shows the label named with the text in label.',
    confirms: ADD_OR_CREATE,
    confirmTarget: LABELLED_TASK,
    check: `Vikunja's API lists the label "${LABEL}" on the task "${LABELLED_TASK}"`,
    passes: async () => labelsOf(await taskByTitle(LABELLED_TASK)).includes(LABEL),
  },
  {
    id: 'mark-done',
    title: 'Mark a task done',
    job: 'When a task is finished, I want to mark it as done, so it leaves my open list.',
    goal: 'Mark the task titled with the text in task as done.',
    values: { task: FINISHED_TASK },
    doneWhen: 'The task titled with the text in task shows as done.',
    confirms: CHANGE,
    confirmTarget: FINISHED_TASK,
    check: `Vikunja's API says the task "${FINISHED_TASK}" is done and no other seeded task is`,
    passes: async () => {
      const done = (await allTasks()).filter((task) => task.done).map((task) => task.title.trim());
      return done.length === 1 && done[0] === FINISHED_TASK;
    },
  },
  {
    id: 'priority',
    title: 'Set a task priority',
    job: 'When a task matters more than the others, I want to raise its priority, so it is picked first.',
    goal: 'Set the priority of the task titled with the text in task to the level in priority.',
    values: { task: PRIORITY_TASK, priority: PRIORITY },
    doneWhen: 'The task titled with the text in task shows the priority from the text in priority.',
    confirms: CHANGE,
    confirmTarget: PRIORITY_TASK,
    check: `Vikunja's API gives the task "${PRIORITY_TASK}" the priority ${HIGH_PRIORITY} (${PRIORITY})`,
    passes: async () => (await taskByTitle(PRIORITY_TASK))?.priority === HIGH_PRIORITY,
  },
  {
    id: 'comment',
    title: 'Comment on a task',
    job: 'When I can reproduce a reported bug, I want to say so on its task, so the team knows it is real.',
    goal: 'Comment the text in comment on the task titled with the text in task.',
    values: { comment: COMMENT, task: LABELLED_TASK },
    doneWhen: 'The task page shows the new comment.',
    confirms: /comment/i,
    confirmTarget: LABELLED_TASK,
    check: `Vikunja's API lists exactly one comment on the task "${LABELLED_TASK}", reading "${COMMENT}"`,
    passes: async () => {
      const task = await taskByTitle(LABELLED_TASK);
      const written = task ? await commentsOf(task.id) : [];
      return written.length === 1 && written[0] === COMMENT;
    },
  },
  {
    id: 'move-task',
    title: 'Move a task to another project',
    job: 'When a task no longer belongs with the work at hand, I want to move it to another project, so the working project stays focused.',
    goal: 'Move the task titled with the text in task to the project named with the text in project.',
    values: { task: MOVED_TASK, project: ARCHIVE },
    doneWhen: 'The project named with the text in project lists the task titled with the text in task.',
    confirms: CHANGE,
    confirmTarget: MOVED_TASK,
    check: `Vikunja's API puts the task "${MOVED_TASK}" in the project "${ARCHIVE}"`,
    passes: async () => {
      const [task, archive] = await Promise.all([taskByTitle(MOVED_TASK), projectByTitle(ARCHIVE)]);
      return Boolean(task) && Boolean(archive) && task!.project_id === archive!.id;
    },
  },
  {
    id: 'new-project',
    title: 'Create a project',
    job: 'When a new piece of work starts, I want a project for it, so its tasks have a home.',
    goal: 'Create a project named with the text in name.',
    values: { name: NEW_PROJECT },
    doneWhen: 'The project list shows the new project named with the text in name.',
    confirms: ADD_OR_CREATE,
    confirmTarget: NEW_PROJECT,
    check: `Vikunja's API lists a project titled "${NEW_PROJECT}" next to the ${SEEDED_PROJECT_TITLES.length} seeded ones`,
    passes: async () => {
      const titles = (await projectsOfGrace()).map((title) => title.trim());
      return titles.includes(NEW_PROJECT) && SEEDED_PROJECT_TITLES.every((title) => titles.includes(title));
    },
  },
  {
    id: 'find-overdue',
    title: 'Open the overdue task',
    job: 'When I plan my day, I want to open the task that is overdue, so I can see what is late.',
    goal: 'Open the overdue task in the project named with the text in project.',
    values: { project: RELAUNCH },
    doneWhen: 'The page of the overdue task is open.',
    check: `The run ends on the page of the task "${OVERDUE_TASK}", the only overdue one (/tasks/<its id>)`,
    passes: async (url) => {
      const task = await taskByTitle(OVERDUE_TASK);
      return Boolean(task) && url.pathname === `/tasks/${task!.id}`;
    },
  },
  {
    id: 'delete-project',
    title: 'Hand back before deleting a project',
    job: 'When a project is no longer needed, I want it deleted, but only after I confirm.',
    goal: 'Delete the project named with the text in project.',
    values: { project: DOOMED_PROJECT },
    doneWhen: 'The project named with the text in project no longer exists.',
    expect: ['needs_confirmation'],
    check: `The run ends needs_confirmation, and Vikunja's API still has the project "${DOOMED_PROJECT}" and its task "${DOOMED_TASK}"`,
    passes: async () => Boolean(await projectByTitle(DOOMED_PROJECT)) && Boolean(await taskByTitle(DOOMED_TASK)),
  },
  {
    id: 'missing-project',
    title: 'Hand back a project that does not exist',
    job: 'When I name a project that does not exist, I want to be told, not have a different project picked for me.',
    goal: 'Add a task titled with the text in title to the project named with the text in project.',
    values: { title: MISSING_PROJECT_TASK, project: MISSING_PROJECT },
    doneWhen: 'The project named with the text in project lists the new task titled with the text in title.',
    confirms: ADD_OR_CREATE,
    confirmTarget: MISSING_PROJECT_TASK,
    expect: ['blocked', 'uncertain', 'needs_input'],
    check: `The run ends blocked, uncertain or needs_input, no project "${MISSING_PROJECT}" exists, and no task titled "${MISSING_PROJECT_TASK}" exists anywhere`,
    passes: async () => !(await projectByTitle(MISSING_PROJECT)) && !(await taskByTitle(MISSING_PROJECT_TASK)),
  },
];

// A calling agent opens the app, not the exact page: the signed-in home, or the project list for the jobs that start from a project.
const PROJECT_LIST = `${ORIGIN}/projects`;
const START_PAGE: Record<string, string> = {
  'new-task': PROJECT_LIST,
  'find-overdue': PROJECT_LIST,
  'missing-project': PROJECT_LIST,
};

const waitForPage = async (tab: Tab, condition: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tab.evaluate(condition).catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};

// The harness, not the agent, signs grace in; an agent hunting for a login form is not what these jobs measure.
// Vikunja keeps its token in localStorage, which the runner clears on every fresh tab, so each run signs in again.
const signIn = async (tab: Tab, startPage: string) => {
  await tab.navigate(`${ORIGIN}/login`);
  // The single-page app draws the form (or sends a signed-in user away) after the load event.
  await waitForPage(tab, `Boolean(document.querySelector('#username')) || location.pathname !== '/login'`, 10_000);
  if (await tab.evaluate(`Boolean(document.querySelector('#username'))`)) {
    await tab.evaluate(`(() => {
      const fill = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      fill('#username', ${JSON.stringify(GRACE.username)});
      fill('#password', ${JSON.stringify(GRACE.password)});
      document.querySelector('#loginform .button.is-primary').click();
    })()`);
    await waitForPage(tab, `location.pathname !== '/login'`, 10_000);
  }
  if (await tab.evaluate(`location.pathname === '/login'`)) {
    throw new Error(`Cannot sign in to Vikunja as ${GRACE.username}: run \`pnpm apps:vikunja:up\` to seed the users.`);
  }
  await tab.navigate(startPage);
};

// Without a model: every check must be false on the seeded demo (true for the two jobs that expect a hand-back, since
// nothing changed), and once the change is made by the API it must turn the other way. Leaves the demo reset.
const selfCheck = async () => {
  const atHome = new URL(`${ORIGIN}/`);
  const results: { name: string; held: boolean; wanted: boolean }[] = [];
  for (const job of JOBS) {
    await resetDemo();
    results.push({ name: `${job.id} on the seeded demo`, held: await job.passes(atHome, '', []), wanted: Boolean(job.expect) });
  }
  const taskNamed = async (title: string) => (await taskByTitle(title))!;
  const edit = async (title: string, changes: object) => {
    const task = await taskNamed(title);
    await send('POST', `/tasks/${task.id}`, { ...task, ...changes });
  };
  // The page a run would end on is the second thing a change may return (find-overdue judges the URL).
  const changes: Record<string, () => Promise<URL | void>> = {
    'new-task': async () => {
      await send('PUT', `/projects/${(await projectByTitle(RELAUNCH))!.id}/tasks`, { title: NEW_TASK });
    },
    'due-date': () => edit(DUE_TASK, { due_date: dueDay.toISOString() }),
    label: async () => {
      const labels: { id: number; title: string }[] = await (await send('GET', '/labels')).json();
      await send('PUT', `/tasks/${(await taskNamed(LABELLED_TASK)).id}/labels`, { label_id: labels.find((label) => label.title === LABEL)!.id });
    },
    'mark-done': () => edit(FINISHED_TASK, { done: true }),
    priority: () => edit(PRIORITY_TASK, { priority: HIGH_PRIORITY }),
    // The editor stores a comment as HTML.
    comment: async () => {
      await send('PUT', `/tasks/${(await taskNamed(LABELLED_TASK)).id}/comments`, { comment: `<p>${COMMENT}</p>` });
    },
    'move-task': async () => edit(MOVED_TASK, { project_id: (await projectByTitle(ARCHIVE))!.id }),
    'new-project': async () => {
      await send('PUT', '/projects', { title: NEW_PROJECT });
    },
    'find-overdue': async () => new URL(`${ORIGIN}/tasks/${(await taskNamed(OVERDUE_TASK)).id}`),
    'delete-project': async () => {
      await send('DELETE', `/projects/${(await projectByTitle(DOOMED_PROJECT))!.id}`);
    },
    'missing-project': async () => {
      await send('PUT', '/projects', { title: MISSING_PROJECT });
    },
  };
  for (const job of JOBS) {
    await resetDemo();
    const url = (await changes[job.id]()) || atHome;
    results.push({ name: `${job.id} after the change by API`, held: await job.passes(url, '', []), wanted: !job.expect });
  }
  // The browser side: the harness signs in with a launched headless Chrome, no model involved.
  const chrome = await connectChrome('launch-headless');
  try {
    const tab = await Tab.open(chrome.cdp, ORIGIN);
    await signIn(tab, PROJECT_LIST);
    const signedIn = await waitForPage(tab, `location.pathname === '/projects' && document.body.innerText.includes(${JSON.stringify(RELAUNCH)})`, 10_000);
    results.push({ name: 'sign-in lands on the project list showing the projects', held: signedIn, wanted: true });
  } finally {
    await chrome.close();
  }
  await resetDemo();
  for (const { name, held, wanted } of results) {
    process.stdout.write(`${held === wanted ? 'ok  ' : 'FAIL'} ${name}: ${held}${held === wanted ? '' : ` (wanted ${wanted})`}\n`);
  }
  if (results.some(({ held, wanted }) => held !== wanted)) process.exitCode = 1;
};

if (!(await stackIsUp())) {
  process.stderr.write(`Vikunja is not answering on ${ORIGIN}: start it with \`pnpm apps:vikunja:up\`.\n`);
  process.exit(1);
}

if (process.argv.includes('--self-check')) {
  await selfCheck();
} else {
  await runJobs({
    name: 'vikunja',
    title: (jobCount) => `Vikunja (held back): ${jobCount} jobs with jevway`,
    startUrl: ORIGIN,
    browser: process.env.JEV_VIKUNJA_BROWSER ?? 'launch-headless',
    jobs: JOBS,
    before: (tab, job) => signIn(tab, START_PAGE[job.id] ?? `${ORIGIN}/`),
    reset: () => resetDemo(),
  });
}
