// The report pages' stylesheet and inline scripts: the shared design (recording-page.ts) plus the overview, the nav
// and the router. Kept apart from the markup so it stays readable; nothing here depends on a suite's data.
import { BASE_STYLE, FONT_LINK, PLAYER_SCRIPT } from '../../src/task/recording-page.ts';

export { FONT_LINK };

export const ARROW = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
export const BACK_ARROW = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>';

/**
 * Runs in <head>: with JS, views stay hidden until the router picks one, so a job link never flashes the overview.
 * If a script fails anyway, the page falls back to reading as one long document instead of staying blank.
 */
export const HEAD_SCRIPT = `<script>document.documentElement.classList.add('js');addEventListener('error',(e)=>{if(!(e.target instanceof Element))document.documentElement.classList.remove('js')},true)</script>`;

export const STYLE = `${BASE_STYLE}
/* Views: without JS every view reads in order; with JS only the routed one shows */
.js .view:not(.current) { display: none; }
.js .run:not(.current) { display: none; }
html:not(.js) .needs-js { display: none; }
/* A followed link lands below the sticky nav; a job view sits right under it, so its own link lands on the page top */
.view, .section { scroll-margin-top: 3rem; }
.job-view { scroll-margin-top: 100vh; }

/* Type of the overview */
.hero { font-size: clamp(1.875rem, 1.2rem + 2.4vw, 3rem); font-weight: 500; line-height: 1.2; letter-spacing: -0.025em; text-wrap: pretty; }
.row-title { font-size: clamp(1.375rem, 1.2rem + 0.8vw, 1.875rem); font-weight: 500; line-height: 1.2; letter-spacing: -0.025em; text-wrap: pretty; }
.figure { display: block; font-size: clamp(1.5rem, 1.3rem + 0.8vw, 1.875rem); font-weight: 500; line-height: 1.25; letter-spacing: -0.025em; }

/* Nav */
nav.top { position: sticky; top: 0; z-index: 5; background: var(--background); }
nav.top .wrapper { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding-block: 0.75rem; font-size: 0.75rem; }
nav.top .links { display: flex; gap: 1rem; color: var(--muted-foreground); }

/* Overview */
.intro { padding-block: 5rem 3rem; }
@media (min-width: 64rem) { .intro { padding-block: 9rem 4rem; } }
.figures { border-top: 1px solid var(--muted); padding-block: 2rem 0; grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 2rem; }
@media (min-width: 64rem) { .figures { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.figures .meta { display: block; margin-top: 0.25rem; }
.section { padding-block: 4rem; }
@media (min-width: 64rem) { .section { padding-block: 6rem; } }
.section-head { margin-bottom: 2.5rem; }
.filters { margin-bottom: 2rem; }
.job-row { border-top: 1px solid var(--muted); padding-block: 2.5rem 3rem; }
.job-row .strip { margin-top: 2rem; }
.action { display: inline-flex; gap: 0.5rem; align-items: baseline; font-size: 0.75rem; line-height: 1rem; white-space: nowrap; }
.action svg { align-self: center; flex: none; }
.no-recording { margin-top: 2rem; }
.method-row { border-top: 1px solid var(--muted); padding-block: 1.5rem; }

/* After a job's runs */
.failures, .next { margin-top: 4rem; }
.next-row { border-top: 1px solid var(--muted); padding-block: 2rem; }
`;

/**
 * Which view, run and step a hash opens, as page script: `#<view id>` opens the view; `#<view>-r<run>-s<step>` (an
 * overview shot's link, or the address after a reader seeks) opens that run at that step; `#<view>-r<run>` and the agent
 * report's older `#<chore>-<run>` open that run. A whole hash that is a view's id always wins.
 *
 * @example
 * hashTarget('flaky-r3-s2', (id) => id === 'flaky') // { id: 'flaky', run: 3, step: 2 }
 */
export const HASH_TARGET = String.raw`const hashTarget = (hash, isView) => {
  if (!hash) return null;
  if (isView(hash)) return { id: hash };
  const parts = /^(.+)-r(\d+)(?:-s(\d+))?$/.exec(hash) || /^(.+)-(\d+)$/.exec(hash);
  if (!parts || !isView(parts[1])) return null;
  return parts[3] ? { id: parts[1], run: Number(parts[2]), step: Number(parts[3]) } : { id: parts[1], run: Number(parts[2]) };
};`;

/**
 * The page's behaviour, all reading data- attributes of server-rendered HTML:
 * - the hash picks the view (a job id, else the overview), and a step link its run and step (`HASH_TARGET`);
 * - text-link filters narrow the job rows;
 * - each job's run switcher shows one run's panel;
 * - the players themselves are `PLAYER_SCRIPT`'s (the video, its ticks and shots on the same step).
 */
export const SCRIPT = `${PLAYER_SCRIPT}
<script>
(() => {
  const overview = document.getElementById('overview');
  const views = [...document.querySelectorAll('.view')];

  ${HASH_TARGET}

  // --- one run's panel shown in a job view, its video given the poster it held back
  const showRun = (view, run) => {
    let shownPanel = null;
    for (const panel of view.querySelectorAll('.run')) {
      const shown = panel.dataset.run === run;
      panel.classList.toggle('current', shown);
      if (shown) shownPanel = panel;
      const video = panel.querySelector('video');
      if (!video) continue;
      if (!shown) video.pause();
      else if (!video.poster && video.dataset.poster) video.poster = video.dataset.poster;
    }
    return shownPanel;
  };

  // --- views: #<job id> opens that job (#<job>-r<run>-s<step> at that run and step); an empty, #jobs, #method or
  // unknown hash shows the overview
  const route = () => {
    let hash = '';
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch {}
    const found = hashTarget(hash, (id) => Boolean(document.getElementById(id)?.classList.contains('job-view')));
    const job = found ? document.getElementById(found.id) : null;
    const target = job || !hash ? null : document.getElementById(hash);
    const current = job || overview;
    for (const view of views) view.classList.toggle('current', view === current);
    for (const video of document.querySelectorAll('video')) if (!current.contains(video)) video.pause();
    const panel = job && found.run !== undefined ? showRun(job, String(found.run)) : null;
    if (panel && found.step) panel.dispatchEvent(new CustomEvent('seek-step', { detail: { index: found.step - 1 } }));
    if (job || !target) window.scrollTo(0, 0);
    else target.scrollIntoView();
  };
  window.addEventListener('hashchange', route);

  // --- overview filters
  const rows = [...document.querySelectorAll('[data-kinds]')];
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[data-filter]')) other.setAttribute('aria-pressed', String(other === button));
      const filter = button.dataset.filter;
      for (const row of rows) row.hidden = filter !== 'all' && !row.dataset.kinds.split(' ').includes(filter);
    });
  }

  // --- run switcher
  for (const button of document.querySelectorAll('[data-show-run]')) {
    button.addEventListener('click', () => {
      const view = button.closest('.job-view');
      showRun(view, button.dataset.showRun);
      // The pressed button now sits in a hidden panel: keep focus on the same run's button in the shown one.
      view.querySelector('.run.current [data-show-run="' + button.dataset.showRun + '"]')?.focus();
    });
  }

  route();
})();
</script>`;
