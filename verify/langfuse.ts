/**
 * Langfuse jobs-to-be-done: sixteen read-only, multi-step jobs in Langfuse's public demo project, each run from the
 * project home, recorded (video + described steps), and checked against the final URL and page text.
 *
 *   pnpm verify:langfuse                                                           # every job, 3 runs each
 *   JEVWAY_LANGFUSE_RUNS=1 JEVWAY_LANGFUSE_ONLY=costliest-user,prompt-version pnpm verify:langfuse
 *   JEVWAY_LANGFUSE_RUNS=3 JEVWAY_LANGFUSE_DEVICE=iphone-15 pnpm verify:langfuse   # a key of DEVICES, default desktop
 *   JEVWAY_LANGFUSE_PHRASING=terse pnpm verify:langfuse                            # only the jobs that have a terseGoal
 *
 * Needs a Chrome signed in to cloud.langfuse.com on a debugging port (default http://127.0.0.1:9333, override
 * with JEVWAY_LANGFUSE_BROWSER); see the jevway skill's "Run without permission prompts". Opens report.html.
 */
import type { Job } from './jobs/report.ts';
import { runJobs } from './jobs/runner.ts';

const PROJECT = 'https://cloud.langfuse.com/project/clkpwwm0m000gmm094odg11gi';
const READ_ONLY = "Read-only: don't create, edit, delete, annotate, run or select anything you don't need to.";
const openTrace = (url: URL) => /traceId=|\/traces\/|peek=/.test(url.href);

const JOBS: Job[] = [
  {
    id: 'costliest-user',
    title: 'Find the costliest user',
    job: 'When the LLM bill spikes, I want to see which user drove the cost, so I can check whether it is abuse or a power user.',
    // Langfuse's Users table can't be sorted by cost, and Jev picks elements rather than comparing numbers: the
    // calling agent reads the table and names the user in a second call on the same session.
    goal: `Go to Users. ${READ_ONLY}`,
    firstDoneWhen: 'The Users list is showing.',
    doneWhen: "A single user's detail page is open, showing that user's traces or usage.",
    followUp: (rows) => {
      const cost = (row: Record<string, string>) => Number((row['Total Cost'] ?? '').replace(/[^\d.]/g, '')) || 0;
      const top = rows.filter((row) => row['User ID']).sort((a, b) => cost(b) - cost(a))[0];
      return top && { goal: `Open the user whose User ID is in user_id. ${READ_ONLY}`, values: { user_id: top['User ID'] } };
    },
    check: 'The URL is a user page: /users/u-… (the agent picked the costliest from the table)',
    passes: (url) => /\/users\/u-/.test(url.pathname),
  },
  {
    id: 'longest-session',
    title: 'Replay the longest conversation',
    job: 'When a chat went wrong, I want to replay the whole session turn by turn, so I can see where it derailed.',
    goal: `Go to Sessions, sort the sessions by Duration with the longest first, and open the longest session. ${READ_ONLY}`,
    terseGoal: `Open the longest session. ${READ_ONLY}`,
    doneWhen: "A single session's page is open, listing its traces in order.",
    check: 'The URL is a session page: /sessions/<id>',
    passes: (url) => /\/sessions\/[^/]+$/.test(url.pathname),
  },
  {
    id: 'cost-dashboard',
    title: 'Compare GPT and Jev cost',
    job: 'When choosing a model for the sentiment classifier, I want its cost dashboard over the past week, so I can compare GPT with Jev.',
    goal: `Go to Dashboards, open the "Sentiment Classifier: GPT vs Jev Cost" dashboard, and set its date range to the past 7 days. ${READ_ONLY}`,
    doneWhen: 'The "Sentiment Classifier: GPT vs Jev Cost" dashboard is open with its date range set to the past 7 days.',
    check: 'A /dashboards/<id> page naming "GPT vs Jev" whose range reads "Past 7 days" with the menu closed',
    // The range button must read "Past 7 days" with the menu closed: an open menu lists every range.
    passes: (url, text) => /\/dashboards\/[a-z0-9]+$/.test(url.pathname) && /GPT vs Jev/.test(text) && /Past 7 days/.test(text) && !/Past 30 min/.test(text),
  },
  {
    id: 'off-topic-answer',
    title: 'Check an off-topic answer',
    job: 'When users ask off-topic questions, I want to read how the bot answered one, so I can confirm it declines politely.',
    goal: `Go to Tracing, set the time range to the past 30 days, search the traces for the text in search_query, and open the trace whose input asks about the weather in Berlin. ${READ_ONLY}`,
    // The phrase the user remembers: plain "weather" matches too much and buries the trace pages deep.
    // The demo's matching trace ages out of the default "Past 1 day" range, so the goal widens it.
    values: { search_query: 'weather in berlin' },
    doneWhen: 'The detail of the trace asking about the weather in Berlin is open, showing its input and output.',
    check: 'A trace is open (traceId/peek in the URL) and the page mentions the weather in Berlin',
    passes: (url, text) => openTrace(url) && /weather in berlin/i.test(text),
  },
  {
    id: 'worst-relevance',
    title: 'Read the worst-rated answer',
    job: 'When answer quality dips, I want to open the answer with the lowest relevance score, so I can read what went wrong.',
    goal: `Go to Scores, show only scores named answer_relevance (filter by the name in score_name), sort them by Value with the lowest first, and open the trace of the lowest one. ${READ_ONLY}`,
    values: { score_name: 'answer_relevance' },
    doneWhen: 'A trace is open in its own view or side panel: a trace ID heading with its tree of observations (not just the Scores list).',
    check: 'A trace is open (traceId/peek in the URL or a /traces/ page) and the page shows answer_relevance',
    passes: (url, text) => openTrace(url) && /answer_relevance/.test(text),
  },
  {
    id: 'prompt-version',
    title: 'Look at an earlier prompt version',
    job: 'When the assistant changed tone, I want to read the previous version of its prompt, so I can see what changed.',
    goal: `Go to Prompts, open the langfuse-docs-assistant-chat prompt, and show its version 28. ${READ_ONLY}`,
    terseGoal: `Show version 28 of the langfuse-docs-assistant-chat prompt. ${READ_ONLY}`,
    doneWhen: 'Version 28 of the langfuse-docs-assistant-chat prompt is shown.',
    check: 'The URL is /prompts/langfuse-docs-assistant-chat?version=28',
    passes: (url) => url.pathname.endsWith('/prompts/langfuse-docs-assistant-chat') && url.searchParams.get('version') === '28',
  },
  {
    id: 'annotation-backlog',
    title: 'Review the annotation backlog',
    job: 'When planning labelling work, I want to see what is pending in the QA error-analysis queue, so I can size the effort.',
    goal: `Go to Human Annotation and open the "2026-07-15 Error Analysis - QA chat" queue to see its items. Do not press "Process queue". ${READ_ONLY}`,
    terseGoal: `Open the "2026-07-15 Error Analysis - QA chat" annotation queue. ${READ_ONLY}`,
    doneWhen: 'The "2026-07-15 Error Analysis - QA chat" annotation queue page is open, listing its items.',
    check: 'An /annotation-queues/<id> page (not the processing view) whose text names the Error Analysis queue',
    passes: (url, text) => /\/annotation-queues\/[a-z0-9]+/.test(url.pathname) && !/process/i.test(url.pathname) && /Error Analysis/.test(text),
  },
  {
    id: 'failed-experiment',
    title: 'Open the experiment run that errored',
    job: 'When an experiment run reports errors, I want to open that run, so I can see which dataset item failed.',
    // Finding the errored run means comparing a column: the calling agent reads it and names the run.
    goal: `Go to Experiments. ${READ_ONLY}`,
    firstDoneWhen: 'The Experiments list is showing.',
    doneWhen: "An experiment run's results page is open, showing the run's name as a column heading with its SUMMARY and SCORES.",
    followUp: (rows) => {
      const errored = rows.find((row) => Number(row['Error Count']) > 0 && row['Start Time']);
      return errored && {
        goal: `Open the experiment run that started at the time in run_started. ${READ_ONLY}`,
        values: { run_started: errored['Start Time'] },
      };
    },
    check: 'The URL is an experiment results page (/experiments/results or a dataset run)',
    passes: (url) => /\/experiments\/results|\/runs\//.test(url.pathname),
  },
  {
    id: 'dataset-source',
    title: 'Trace a labelled example to its source',
    job: 'When the classifier seems off, I want to check one human-labelled example against the chat it came from, so I can trust the ground truth.',
    goal: `Go to Datasets, open the conversation-signal-groundtruth-v0 dataset, open one of its items, and then open the trace that item came from. ${READ_ONLY}`,
    terseGoal: `Open the source trace of a conversation-signal-groundtruth-v0 dataset item. ${READ_ONLY}`,
    doneWhen: "A trace's own view is open: a trace ID heading with its tree of observations (not a dataset item page).",
    check: 'A trace is open (traceId/peek in the URL or a /traces/ page)',
    passes: (url) => openTrace(url),
  },
  {
    id: 'session-to-user',
    title: 'Who is behind the costliest session',
    job: 'When one conversation cost far more than the rest, I want to see who had it and their other activity, so I can follow up.',
    goal: `Go to Sessions, sort the sessions by Total Cost with the highest first, open the costliest session, and then open the user who had it. ${READ_ONLY}`,
    // Only what the final page shows: "the user from the costliest session" can't be seen on a user page.
    doneWhen: "A single user's detail page is open, showing the user's ID and activity.",
    check: 'The URL is a user page: /users/u-…',
    passes: (url) => /\/users\/u-/.test(url.pathname),
  },  {
    id: 'prompt-usage',
    title: 'See a prompt in production',
    job: 'After shipping a prompt change, I want to open a real generation that used the prompt, so I can check its inputs, output and cost.',
    goal: `Go to Prompts, open the list of observations (generations) that used the langfuse-docs-assistant-chat prompt, and open the most recent one. ${READ_ONLY}`,
    doneWhen: 'A single generation that used the langfuse-docs-assistant-chat prompt is open, showing its input and output.',
    check: "One observation open (peek/observation in the URL) on an /observations page filtered by promptName, or on the prompt page's Linked Generations tab (the phone layout has no observations link)",
    passes: (url) => {
      const observationOpen = /peek=|observation=/.test(url.search);
      const observationsRoute = url.pathname.endsWith('/observations') && /promptName/.test(url.search);
      const linkedGenerationsRoute = url.pathname.endsWith('/prompts/langfuse-docs-assistant-chat') && url.searchParams.get('tab') === 'linked-generations';
      return observationOpen && (observationsRoute || linkedGenerationsRoute);
    },
  },
  {
    id: 'trace-to-prompt',
    title: 'From a trace to the prompt version it used',
    job: 'When one answer looks wrong, I want to go from its trace to the exact prompt version behind it, so I can tell a prompt bug from a model bug.',
    goal: `Go to Tracing, open the most recent QA-Chatbot trace, select one of its "chat" generations in the trace tree, and open the prompt version that generation used. ${READ_ONLY}`,
    // Name what only the prompt page shows: a generation's panel also mentions the prompt and its version.
    doneWhen: "The prompt's own page is open: langfuse-docs-assistant-chat as the page title, with its list of versions.",
    check: 'The URL is /prompts/langfuse-docs-assistant-chat',
    passes: (url) => url.pathname.endsWith('/prompts/langfuse-docs-assistant-chat'),
  },
  {
    id: 'slowest-trace',
    title: 'Open the slowest trace',
    job: 'When users complain the bot is slow, I want to open the slowest recent trace, so I can see which step takes the time.',
    goal: `Go to Tracing, sort the traces by Latency with the slowest first, and open the slowest trace. ${READ_ONLY}`,
    terseGoal: `Open the slowest trace. ${READ_ONLY}`,
    doneWhen: 'A trace detail is open after sorting the traces by latency, slowest first.',
    check: 'A trace is open and the URL sorts by latency',
    passes: (url) => openTrace(url) && /latency/i.test(url.search),
  },
  {
    id: 'power-user-sessions',
    title: "Walk through a power user's latest session",
    job: 'When I want to understand how our heaviest user works with the bot, I want to open their most recent session from their profile, so I can read it end to end.',
    // The agent picks the user with the most events from the table; Jev then needs the user's own Sessions tab,
    // not the sidebar's Sessions link with the same name.
    goal: `Go to Users. ${READ_ONLY}`,
    firstDoneWhen: 'The Users list is showing.',
    doneWhen: "One of the chosen user's sessions is open, showing its traces.",
    followUp: (rows) => {
      const events = (row: Record<string, string>) => Number((row['Total Events'] ?? '').replace(/[^\d]/g, '')) || 0;
      const top = rows.filter((row) => row['User ID']).sort((a, b) => events(b) - events(a))[0];
      return top && {
        goal: `Open the user whose User ID is in user_id, then open the Sessions tab on that user's page (not the Sessions page in the sidebar), and open their most recent session. ${READ_ONLY}`,
        values: { user_id: top['User ID'] },
      };
    },
    check: 'The URL is a session page: /sessions/<id>',
    passes: (url) => /\/sessions\/[^/]+$/.test(url.pathname),
  },
  {
    id: 'monthly-cost',
    title: 'Review a month of LLM cost',
    job: 'At the end of the month, I want the cost dashboard over the past 30 days, so I can report LLM spend.',
    goal: `Go to Dashboards, open the "Langfuse Cost Dashboard", and set its date range to the past 30 days. ${READ_ONLY}`,
    // Langfuse's Home renders a chosen dashboard (here the Cost Dashboard), and the range is saved on the account,
    // so after one run sets it, Home can already be the answer.
    doneWhen: 'The Langfuse Cost Dashboard is showing (on its own page or as the Home dashboard), with its date range reading "Past 30 days".',
    check: 'The Cost Dashboard shows (its page, or Home naming it) with the range "Past 30 days" and the menu closed',
    passes: (url, text) =>
      (/\/dashboards\/[a-z0-9]+$/.test(url.pathname) || url.pathname === new URL(PROJECT).pathname) &&
      /Langfuse Cost Dashboard/.test(text) &&
      /Past 30 days/.test(text) &&
      !/Past 30 min/.test(text),
  },
  {
    id: 'error-observations',
    title: 'Inspect an errored observation',
    job: 'When the error rate ticks up, I want to list only observations at ERROR level and open one, so I can read the error.',
    // Langfuse's search bar takes field queries (its placeholder shows the syntax); facet search only matches names.
    goal: `Go to Tracing, search the observations with the query in query, submit it, and open the first result. ${READ_ONLY}`,
    values: { query: 'level:ERROR' },
    doneWhen: 'An observation at ERROR level is open, showing its error details.',
    check: 'A trace or observation is open and the URL filters level to ERROR',
    passes: (url) => openTrace(url) && /level/i.test(url.search) && /ERROR/.test(url.search),
  },
];

await runJobs({
  name: 'langfuse',
  title: (jobCount) => `Langfuse demo: ${jobCount} jobs with jevway`,
  startUrl: PROJECT,
  browser: process.env.JEVWAY_LANGFUSE_BROWSER ?? 'http://127.0.0.1:9333',
  jobs: JOBS,
  before: async (tab) => {
    if (/\/auth\//.test(String(await tab.evaluate('location.pathname')))) {
      throw new Error('Not signed in to Langfuse in this Chrome: sign in once, then rerun.');
    }
  },
});
