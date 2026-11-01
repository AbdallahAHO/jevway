// The design every recording page shares (Prima Persona: one 4-column grid, monochrome, hairline rows, Switzer):
// a run's own index.html, the jobs report and the agent report. The player (the video, its timeline and the step strip,
// kept on the same step) is here too, so a run looks the same wherever it is shown.
import type { RecordedStep } from './recording.ts';

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const escape = escapeHtml;

/** Switzer from Fontshare; the system stack takes over when it can't load (offline, file://). */
export const FONT_LINK = 'https://api.fontshare.com/v2/css?f[]=switzer@400,500&display=swap';

// --- words and numbers a reader compares

export const statusWord = (status: string) => status.replaceAll('_', ' ');
export const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const indexLabel = (i: number) => String(i + 1).padStart(2, '0');
export const pathOf = (url: string) => {
  try {
    const { pathname, search } = new URL(url);
    return pathname + search;
  } catch {
    return url;
  }
};
/** A run's Finished shots carry the status (lowercase) as their operation; actions are uppercase. */
export const isFinished = (step: RecordedStep) => step.operation === step.operation.toLowerCase();

/** One hairline row of a fact list: the label in column 1, the body across columns 2–4. */
export const fact = (label: string, body: string) => `<div class="fact grid4"><dt>${label}</dt><dd class="c2s3">${body}</dd></div>`;

// --- the player

/**
 * One step as a card: the shot, then its number, video time and confidence, what happened, and where. The run's
 * Finished shots (lowercase operation, the status) read "Finished: <status>", their reason in the alt text. With
 * `href` the whole card is a link (the overview); otherwise it seeks the player it sits in.
 */
export const shotCard = (step: RecordedStep, i: number, dir: string, open: { href: string } | { video: boolean }) => {
  const finished = isFinished(step);
  const label = finished ? `Finished: ${statusWord(step.operation)}` : step.description;
  const timed = 'video' in open && open.video && step.video_at !== undefined;
  const meta = [
    indexLabel(i),
    ...(step.video_at !== undefined && ('href' in open || timed) ? [clock(step.video_at)] : []),
    ...(step.unreachable ? [`<span class="missed">not reached${(step.attempts ?? 1) > 1 ? ` ×${step.attempts}` : ''}: covered</span>`] : step.confidence !== undefined && !finished ? [step.confidence.toFixed(2)] : []),
  ].join(' · ');
  const src = `${dir}${step.file}`;
  const image = `<img src="${escape(src)}" alt="${escape(step.description)}" loading="lazy" decoding="async" width="1120" height="780">`;
  const text = `<span class="what">${escape(label)}</span><span class="where">${escape(pathOf(step.url))}</span>`;
  const className = `shot${finished ? ' finished' : ''}`;
  if ('href' in open) return `<a class="${className}" href="${escape(open.href)}">${image}<span class="caption"><span class="meta num">${meta}</span>${text}</span></a>`;
  // In a player the whole card seeks (the button gives it a keyboard stop); the full-size link sits outside the button.
  const data = timed ? ` data-at="${step.video_at}"` : ` data-src="${escape(src)}"`;
  return `<div class="${className}" data-index="${i}"${data}><button type="button" class="seek" aria-label="Show step ${i + 1}">${image}</button>
<span class="caption"><span class="meta-line"><span class="meta num">${meta}</span><a class="full-size" href="${escape(src)}" target="_blank" rel="noopener">Full size</a></span>${text}</span></div>`;
};

/**
 * The video (or the first shot when there is no video), its timeline with one tick per step, the `bar` (a run switcher
 * and the clock), then the step strip. `screen` is the frame's opening tag. Only a `featured` player fetches its poster;
 * the others hold it in `data-poster` until shown.
 *
 * @example
 * playerMarkup({ dir: 'run-1/', video: 'run.mp4', steps, label: 'run 1', featured: true, screen: '<div class="screen">', bar })
 */
export const playerMarkup = ({
  dir,
  video,
  steps,
  label,
  featured,
  screen,
  bar,
}: {
  dir: string;
  video: string | null;
  steps: RecordedStep[];
  /** Names the run in labels, e.g. "run 2". */
  label: string;
  featured: boolean;
  screen: string;
  bar: string;
}) => {
  const poster = `${dir}${steps[0].file}`;
  const timed = steps.filter((s) => s.video_at !== undefined);
  if (!video || !timed.length) {
    return `${screen}<img data-frame src="${escape(poster)}" alt="${escape(steps[0].description)}"></div>
<p class="small screen-note">No video for this run (it needs ffmpeg): pick a step to see its shot.</p>
${bar}
<div class="strip" aria-label="Steps of ${label}">${steps.map((s, i) => shotCard(s, i, dir, { video: false })).join('')}</div>`;
  }
  // The last frame holds 1.5 s (recording.ts), so this is the video's length until its metadata says otherwise.
  const duration = Math.max(...timed.map((s) => s.video_at!)) + 1.5;
  // Wide enough that the two closest ticks don't overlap (about 1.75rem apart); a long one scrolls inside its own box.
  const times = timed.map((s) => s.video_at!).sort((a, b) => a - b);
  const closest = Math.min(...times.slice(1).map((t, i) => t - times[i]).filter((gap) => gap > 0), duration);
  const width = Math.min(200, Math.max(steps.length * 2, (1.75 * duration) / closest));
  const ticks = steps
    .map((s, i) => (s.video_at === undefined ? '' : `<button type="button" class="tick" aria-label="Play from step ${i + 1}" data-at="${s.video_at}" data-index="${i}" style="left:${((s.video_at / duration) * 100).toFixed(2)}%">${i + 1}</button>`))
    .join('');
  const posterAttribute = featured ? ` poster="${escape(poster)}"` : ` data-poster="${escape(poster)}"`;
  return `${screen}<video src="${escape(`${dir}${video}`)}" preload="none"${posterAttribute} controls muted playsinline aria-label="Screencast of ${label}"></video></div>
<div class="timeline-scroll"><div class="timeline" style="min-width:${width.toFixed(1)}rem"><div class="track"></div><div class="played"></div><div class="ticks">${ticks}</div></div></div>
${bar}
<div class="strip" aria-label="Steps of ${label}">${steps.map((s, i) => shotCard(s, i, dir, { video: true })).join('')}</div>`;
};

// --- the stylesheet: tokens, the grid, type, the player and fact rows

export const BASE_STYLE = `
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
.job-title { font-size: clamp(1.75rem, 1.3rem + 1.6vw, 2.5rem); font-weight: 500; line-height: 1.15; letter-spacing: -0.025em; text-wrap: balance; }
.section-title { font-size: clamp(1.125rem, 1rem + 0.6vw, 1.5rem); font-weight: 500; line-height: 1.375; letter-spacing: -0.02em; }
.num, .figure, .clock { font-variant-numeric: tabular-nums; }
.held { color: var(--held); } .reached { color: var(--reached); } .missed { color: var(--missed); } .unrun { color: var(--muted-foreground); }
.marks { letter-spacing: 0.15em; text-transform: none; }
.textlinks { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
.textlinks button:hover, .textlinks [aria-pressed="true"] { color: var(--foreground); }
.textlinks [aria-pressed="true"] { text-decoration: underline; text-underline-offset: 4px; }

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

/* A view: its head, the player, the facts */
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

/* Footer */
footer .wrapper { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem 1rem; padding-block: 2rem; border-top: 1px solid var(--muted); font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
footer span { overflow-wrap: anywhere; }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; scroll-behavior: auto !important; } }
`;

/**
 * Keeps each player (`.run`) on one step: its video, its timeline ticks and its step shots. Clicking a tick or a shot
 * seeks (and plays, muted); playing marks the current step's tick and shot and scrolls the strip, never the page.
 * Without a video, a shot shows in the frame.
 */
export const PLAYER_SCRIPT = `<script>
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
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
})();
</script>`;
