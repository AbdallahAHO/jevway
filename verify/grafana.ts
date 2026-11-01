/**
 * Grafana jobs-to-be-done: eight read-only jobs in Grafana's public play sandbox (no login), each run from the
 * home page in a fresh headless Chrome, recorded (video + described steps), and checked against the final URL.
 * A second real app next to Langfuse, to show the page reader and the loop are not tuned to one UI.
 *
 *   pnpm verify:grafana                                                         # every job, 3 runs each
 *   JEVWAY_GRAFANA_RUNS=1 JEVWAY_GRAFANA_ONLY=find-kubelet,explore-6h pnpm verify:grafana
 *   JEVWAY_GRAFANA_RUNS=3 JEVWAY_GRAFANA_DEVICE=iphone-15 pnpm verify:grafana   # a key of DEVICES, default desktop
 *
 * Launches its own headless Chrome (override with JEVWAY_GRAFANA_BROWSER, e.g. http://127.0.0.1:9222). Opens report.html.
 */
import type { Job } from './jobs/report.ts';
import { runJobs } from './jobs/runner.ts';

const ORIGIN = 'https://play.grafana.org';
const READ_ONLY = 'Do not sign in, create, edit, save or delete anything.';
const KUBELET = '/d/3138fa155d5915769fbded898ac09fd9/';
const POD_RESOURCES = '/d/6581e46e4e5c7ba40a07646395ef7b23/';
const LOGS_DEMO = '/d/fdkz6t5tcm7lse/';

const JOBS: Job[] = [
  {
    id: 'find-kubelet',
    title: 'Find the Kubelet dashboard',
    job: 'When a node looks unhealthy, I want to search the dashboards for the kubelet one, so I can check its health.',
    goal: `Search the dashboards for the text in query and open the "Kubernetes / Kubelet" dashboard. ${READ_ONLY}`,
    values: { query: 'kubelet' },
    doneWhen: 'The "Kubernetes / Kubelet" dashboard is open.',
    check: `The URL path starts ${KUBELET}`,
    passes: (url) => url.pathname.startsWith(KUBELET),
  },
  {
    id: 'find-pod-resources',
    title: 'Find the pod resources dashboard',
    job: 'When a pod is slow, I want to find its compute resources dashboard, so I can see its CPU and memory use.',
    goal: `Search the dashboards for the text in query and open "Kubernetes / Compute Resources / Pod". ${READ_ONLY}`,
    values: { query: 'pod' },
    doneWhen: 'That dashboard is open.',
    check: `The URL path starts ${POD_RESOURCES}`,
    passes: (url) => url.pathname.startsWith(POD_RESOURCES),
  },
  {
    id: 'logs-24h',
    title: 'Logs for the last 24 hours',
    job: 'When something broke overnight, I want the logs dashboard over the last day, so I can look for the first error.',
    goal: `Open the "Logs Demo Dashboard" and set its time range to the last 24 hours. ${READ_ONLY}`,
    values: { query: 'logs demo' },
    doneWhen: 'The Logs Demo Dashboard shows the last 24 hours.',
    check: `The URL path starts ${LOGS_DEMO} and from=now-24h`,
    passes: (url) => url.pathname.startsWith(LOGS_DEMO) && url.searchParams.get('from') === 'now-24h',
  },
  {
    id: 'kubelet-7d',
    title: 'Last week on the Kubelet dashboard',
    job: 'When I report on the week, I want the kubelet dashboard over the last 7 days, so I can see the trend.',
    goal: `Open the "Kubernetes / Kubelet" dashboard and set its time range to the last 7 days. ${READ_ONLY}`,
    values: { query: 'kubelet' },
    doneWhen: 'The Kubernetes / Kubelet dashboard shows the last 7 days.',
    check: `The URL path starts ${KUBELET} and from=now-7d`,
    passes: (url) => url.pathname.startsWith(KUBELET) && url.searchParams.get('from') === 'now-7d',
  },
  {
    id: 'explore-6h',
    title: 'Explore the last 6 hours',
    job: 'When I chase a spike, I want Explore on the last 6 hours, so I can query around it.',
    goal: `Go to Explore and set its time range to the last 6 hours. ${READ_ONLY}`,
    doneWhen: 'The Explore page is open (its title and breadcrumb read Explore, with a query editor), and its time range reads "Last 6 hours".',
    check: 'The URL path is /explore and the decoded URL (its panes parameter) contains now-6h',
    passes: (url) => url.pathname === '/explore' && decodeURIComponent(url.href).includes('now-6h'),
  },
  {
    id: 'view-panel',
    title: 'View one panel on its own',
    job: 'When one graph matters, I want it full-size on its own, so I can read it without the rest of the dashboard.',
    goal: `Open the "Logs Demo Dashboard" and view one of its panels on its own. ${READ_ONLY}`,
    values: { query: 'logs demo' },
    doneWhen: 'A single panel is shown full-size.',
    check: `The URL path starts ${LOGS_DEMO} and has viewPanel=`,
    passes: (url) => url.pathname.startsWith(LOGS_DEMO) && url.search.includes('viewPanel='),
  },
  {
    id: 'sort-dashboards',
    title: 'Sort dashboards Z to A',
    job: 'When I look for a dashboard at the end of the alphabet, I want the list sorted from Z to A, so I do not scroll.',
    goal: `Go to the dashboards list and sort it alphabetically from Z to A. ${READ_ONLY}`,
    doneWhen: 'The list is sorted Z–A.',
    // Grafana's sort control writes Z–A as -name_sort (the control itself reads "Alphabetically (Z-A)").
    check: 'The URL path is /dashboards and sort=-name_sort',
    passes: (url) => url.pathname === '/dashboards' && url.searchParams.get('sort') === '-name_sort',
  },
  {
    id: 'alert-rules',
    title: 'Search the alert rules',
    job: 'When CPU alerts fire, I want to search the alert rules for cpu, so I can see how they are set up.',
    goal: `Go to the alert rules list and search the rules for the text in query. ${READ_ONLY}`,
    values: { query: 'cpu' },
    doneWhen: 'Alert rules matching cpu are listed.',
    check: 'The URL path is /alerting/list and the decoded URL or the page text contains cpu',
    passes: (url, text) => url.pathname === '/alerting/list' && /cpu/i.test(`${decodeURIComponent(url.search)}\n${text}`),
  },
];

await runJobs({
  name: 'grafana',
  title: (jobCount) => `Grafana play: ${jobCount} jobs with jevway`,
  startUrl: `${ORIGIN}/`,
  browser: process.env.JEVWAY_GRAFANA_BROWSER ?? 'launch-headless',
  jobs: JOBS,
});
