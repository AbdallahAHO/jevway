// The jobs report's stylesheet and inline scripts (Prima Persona: one 4-column grid, monochrome, hairline rows).
// Kept apart from report.ts so the markup there stays readable; nothing here depends on a suite's data.

/** Switzer from Fontshare; the system stack takes over when it can't load (offline, file://). */
export const FONT_LINK = 'https://api.fontshare.com/v2/css?f[]=switzer@400,500&display=swap';

/**
 * Runs in <head>: with JS, views stay hidden until the router picks one, so a job link never flashes the overview.
 * If a script fails anyway, the page falls back to reading as one long document instead of staying blank.
 */
export const HEAD_SCRIPT = `<script>document.documentElement.classList.add('js');addEventListener('error',(e)=>{if(!(e.target instanceof Element))document.documentElement.classList.remove('js')},true)</script>`;

export const STYLE = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.205 0 0);
  --muted: oklch(0.922 0 0);
  --muted-foreground: oklch(0.47 0 0);
  --held: oklch(0.55 0.13 150);
  --reached: oklch(0.64 0.14 70);
  --missed: oklch(0.56 0.19 27);
  --font-sans: "Switzer", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --wrap: 85rem;
  --gap: 1rem;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0); --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0); --held: oklch(0.72 0.14 150); --reached: oklch(0.8 0.14 80);
    --missed: oklch(0.7 0.17 27); color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0); --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0); --held: oklch(0.72 0.14 150); --reached: oklch(0.8 0.14 80);
  --missed: oklch(0.7 0.17 27); color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--background); color: var(--foreground); font: 400 1rem/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }
h1, h2, h3, p, dl, dd, ul, figure { margin: 0; }
ul { padding: 0; list-style: none; }
a { color: inherit; text-decoration: none; }
a:hover { color: var(--muted-foreground); }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: inherit; }
img, video { display: block; max-width: 100%; }
code { font-family: var(--font-mono); font-size: 0.8125rem; }
:focus-visible { outline: 2px solid var(--foreground); outline-offset: 3px; border-radius: 0.25rem; }
[hidden] { display: none !important; }

/* Views: without JS every view reads in order; with JS only the routed one shows */
.js .view:not(.current) { display: none; }
.js .run:not(.current) { display: none; }
html:not(.js) .needs-js { display: none; }
/* A followed link lands below the sticky nav; a job view sits right under it, so its own link lands on the page top */
.view, .section { scroll-margin-top: 3rem; }
.job-view { scroll-margin-top: 100vh; }

/* Frame and the one grid */
.wrapper { max-width: var(--wrap); margin-inline: auto; padding-left: max(1rem, env(safe-area-inset-left)); padding-right: max(1rem, env(safe-area-inset-right)); }
.grid4 { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.5rem var(--gap); }
.grid4 > * { min-width: 0; }
@media (min-width: 64rem) {
  .wrapper { padding-left: max(2rem, env(safe-area-inset-left)); padding-right: max(2rem, env(safe-area-inset-right)); }
  .grid4 { grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: baseline; }
  .c1 { grid-column: 1; } .c2 { grid-column: 2; } .c3 { grid-column: 3; } .c4 { grid-column: 4; }
  .c2s2 { grid-column: 2 / span 2; } .c3s2 { grid-column: 3 / span 2; } .c2s3 { grid-column: 2 / span 3; } .c1s3 { grid-column: 1 / span 3; }
  .end { justify-self: end; text-align: right; }
}

/* Type: the theme's low end, one display size */
.meta { font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: 0.02em; }
.small { font-size: 0.875rem; line-height: 1.375rem; color: var(--muted-foreground); }
.hero { font-size: clamp(1.875rem, 1.2rem + 2.4vw, 3rem); font-weight: 500; line-height: 1.2; letter-spacing: -0.025em; text-wrap: pretty; }
.job-title { font-size: clamp(1.75rem, 1.3rem + 1.6vw, 2.5rem); font-weight: 500; line-height: 1.15; letter-spacing: -0.025em; text-wrap: balance; }
.section-title { font-size: clamp(1.125rem, 1rem + 0.6vw, 1.5rem); font-weight: 500; line-height: 1.375; letter-spacing: -0.02em; }
.row-title { font-size: clamp(1.375rem, 1.2rem + 0.8vw, 1.875rem); font-weight: 500; line-height: 1.2; letter-spacing: -0.025em; text-wrap: pretty; }
.figure { display: block; font-size: clamp(1.5rem, 1.3rem + 0.8vw, 1.875rem); font-weight: 500; line-height: 1.25; letter-spacing: -0.025em; }
.num, .figure, .clock { font-variant-numeric: tabular-nums; }
.held { color: var(--held); } .reached { color: var(--reached); } .missed { color: var(--missed); } .unrun { color: var(--muted-foreground); }
.marks { letter-spacing: 0.15em; text-transform: none; }

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
.textlinks { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
.textlinks button:hover, .textlinks [aria-pressed="true"] { color: var(--foreground); }
.textlinks [aria-pressed="true"] { text-decoration: underline; text-underline-offset: 4px; }
.job-row { border-top: 1px solid var(--muted); padding-block: 2.5rem 3rem; }
.job-row .strip { margin-top: 2rem; }
.action { display: inline-flex; gap: 0.5rem; align-items: baseline; font-size: 0.75rem; line-height: 1rem; white-space: nowrap; }
.action svg { align-self: center; flex: none; }
.no-recording { margin-top: 2rem; }
.method-row { border-top: 1px solid var(--muted); padding-block: 1.5rem; }

/* Step strip: real shots, one per grid column on wide screens */
.strip { position: relative; display: flex; gap: var(--gap); overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; padding-bottom: 0.75rem; scrollbar-width: thin; }
.shot { flex: 0 0 72%; display: flex; flex-direction: column; gap: 0.625rem; scroll-snap-align: start; min-width: 0; color: var(--foreground); }
@media (min-width: 40rem) { .shot { flex-basis: calc((100% - 2 * var(--gap)) / 3); } }
@media (min-width: 64rem) { .shot { flex-basis: calc((100% - 3 * var(--gap)) / 4); } }
.shot img { width: 100%; height: auto; aspect-ratio: 1120 / 780; object-fit: cover; object-position: top; border-radius: 0.75rem; background: var(--muted); transition: opacity 160ms ease; }
.caption { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
.caption .meta, .caption .where { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta-line { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; min-width: 0; }
.full-size { flex: none; font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
.full-size:hover { color: var(--foreground); }
.seek { display: block; width: 100%; border-radius: 0.75rem; }
.player .shot { cursor: pointer; }
.caption .where { font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
.what { font-size: 0.875rem; line-height: 1.25rem; height: 2.5rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.shot.finished .what { color: var(--muted-foreground); }
a.shot:hover img { opacity: 0.85; }
.player .shot img { opacity: 0.55; }
.player .shot[aria-current="step"] img, .player .shot:hover img { opacity: 1; }
.player .shot[aria-current="step"] .meta { color: var(--foreground); }

/* Job view */
.job-head { padding-block: 2rem 0; }
.job-head .story { margin-top: 0.75rem; }
.back { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--foreground); }
.screen { margin-top: 2rem; width: 100%; aspect-ratio: 16 / 10; border-radius: 2rem; overflow: hidden; background: var(--muted); }
.screen video, .screen img { width: 100%; height: 100%; object-fit: contain; background: var(--muted); }
.screen.portrait { aspect-ratio: auto; height: min(80svh, 52rem); }
.screen.quiet { aspect-ratio: auto; max-height: none; display: grid; align-content: center; gap: 0.5rem; min-height: 14rem; padding: 2rem; }
.screen.quiet p { max-width: 40rem; }
.screen-note { margin-top: 0.75rem; }
.timeline-scroll { overflow-x: auto; margin-top: 1rem; scrollbar-width: none; }
.timeline { position: relative; height: 1.75rem; }
.timeline .track, .timeline .played { position: absolute; left: 0; top: 50%; height: 1px; }
.timeline .track { right: 0; background: var(--muted); }
.timeline .played { width: 0; background: var(--foreground); }
.timeline .ticks { position: absolute; inset: 0 0.875rem; }
.tick { position: absolute; top: 50%; transform: translate(-50%, -50%); min-width: 1.5rem; padding: 0.25rem 0.3rem; border-radius: 99px; border: 1px solid var(--muted); background: var(--background); color: var(--muted-foreground); font-size: 0.625rem; line-height: 1; text-align: center; font-variant-numeric: tabular-nums; }
.tick:hover { color: var(--foreground); border-color: var(--foreground); }
.tick[aria-current="step"] { color: var(--background); background: var(--foreground); border-color: var(--foreground); }
.player-bar { margin-top: 0.75rem; }
.player .strip { margin-top: 2rem; }
.run-head { margin-top: 4rem; margin-bottom: 2rem; }
.fact { border-top: 1px solid var(--muted); padding-block: 1.25rem; }
.fact dt { font-size: 0.75rem; line-height: 1.375rem; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: 0.02em; }
.fact dd, .fact p { font-size: 0.9375rem; line-height: 1.5rem; overflow-wrap: anywhere; }
.kv { color: var(--muted-foreground); margin-right: 0.375rem; }
.address { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 0.8125rem; overflow-wrap: anywhere; }
.failures, .next { margin-top: 4rem; }
.next-row { border-top: 1px solid var(--muted); padding-block: 2rem; }

/* Footer */
footer .wrapper { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem 1rem; padding-block: 2rem; border-top: 1px solid var(--muted); font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
footer span { overflow-wrap: anywhere; }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; scroll-behavior: auto !important; } }
`;

/**
 * The page's behaviour, all reading data- attributes of server-rendered HTML:
 * - the hash picks the view (a job id, else the overview);
 * - text-link filters narrow the job rows;
 * - each job's run switcher shows one run's panel;
 * - in a panel, the video, its timeline ticks and its step shots stay on the same step.
 */
export const SCRIPT = `<script>
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const overview = document.getElementById('overview');
  const views = [...document.querySelectorAll('.view')];

  // --- views: #<job id> opens that job; an empty, #jobs, #method or unknown hash shows the overview
  const route = () => {
    let id = '';
    try { id = decodeURIComponent(location.hash.slice(1)); } catch {}
    const target = id ? document.getElementById(id) : null;
    const job = target && target.classList.contains('job-view') ? target : null;
    const current = job || overview;
    for (const view of views) view.classList.toggle('current', view === current);
    for (const video of document.querySelectorAll('video')) if (!current.contains(video)) video.pause();
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

  // --- one run's player: video, ticks and shots on the same step
  const clock = (s) => Math.floor(s / 60) + ':' + (s % 60).toFixed(1).padStart(4, '0');
  const wire = (panel) => {
    const video = panel.querySelector('video');
    const frame = panel.querySelector('.screen img[data-frame]');
    const strip = panel.querySelector('.strip');
    const timeline = panel.querySelector('.timeline-scroll');
    const ticks = [...panel.querySelectorAll('.tick')];
    const shots = [...panel.querySelectorAll('.strip .shot')];
    const played = panel.querySelector('.played');
    const clockText = panel.querySelector('.clock');
    let current = -1;
    const reveal = (shot) => {
      if (!shot || !strip) return;
      const left = shot.offsetLeft - (strip.clientWidth - shot.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: reduceMotion ? 'auto' : 'smooth' });
    };
    const mark = (index) => {
      if (index === current) return;
      current = index;
      for (const list of [ticks, shots]) list.forEach((el, n) => (n === index ? el.setAttribute('aria-current', 'step') : el.removeAttribute('aria-current')));
      reveal(shots[index]);
      const tick = ticks[index];
      if (tick && timeline && timeline.scrollWidth > timeline.clientWidth) {
        timeline.scrollTo({ left: Math.max(0, tick.offsetLeft - timeline.clientWidth / 2), behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    };
    const stepAt = (time) => {
      let index = 0;
      shots.forEach((shot, n) => { if (shot.dataset.at !== undefined && time + 0.05 >= Number(shot.dataset.at)) index = n; });
      return index;
    };
    const seek = (index) => {
      mark(index);
      const shot = shots[index];
      if (frame && shot && shot.dataset.src) frame.src = shot.dataset.src;
      if (!video || !shot || shot.dataset.at === undefined) return;
      video.currentTime = Number(shot.dataset.at);
      video.play().catch(() => {});
    };
    ticks.forEach((tick) => tick.addEventListener('click', () => seek(Number(tick.dataset.index))));
    // A click anywhere on a card seeks, except on its full-size link.
    shots.forEach((shot, n) => shot.addEventListener('click', (event) => { if (!event.target.closest('a')) seek(n); }));
    if (!video) return;
    const place = () => {
      if (!video.duration || !isFinite(video.duration)) return;
      for (const tick of ticks) tick.style.left = Math.min(100, (Number(tick.dataset.at) / video.duration) * 100) + '%';
    };
    video.addEventListener('loadedmetadata', place);
    const follow = () => {
      const time = video.currentTime;
      mark(stepAt(time));
      if (clockText) clockText.textContent = clock(time) + (video.duration && isFinite(video.duration) ? ' / ' + clock(video.duration) : '');
      if (played && video.duration) played.style.width = Math.min(100, (time / video.duration) * 100) + '%';
    };
    video.addEventListener('timeupdate', follow);
    video.addEventListener('seeked', follow);
  };
  document.querySelectorAll('.run').forEach(wire);

  // --- run switcher: show one run's panel, giving its video the poster it held back
  for (const button of document.querySelectorAll('[data-show-run]')) {
    button.addEventListener('click', () => {
      const view = button.closest('.job-view');
      for (const panel of view.querySelectorAll('.run')) {
        const shown = panel.dataset.run === button.dataset.showRun;
        panel.classList.toggle('current', shown);
        const video = panel.querySelector('video');
        if (!video) continue;
        if (!shown) video.pause();
        else if (!video.poster && video.dataset.poster) video.poster = video.dataset.poster;
      }
      // The pressed button now sits in a hidden panel: keep focus on the same run's button in the shown one.
      view.querySelector('.run.current [data-show-run="' + button.dataset.showRun + '"]')?.focus();
    });
  }

  route();
})();
</script>`;
