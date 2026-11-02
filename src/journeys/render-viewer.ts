// A journey folder's own page (`index.html` next to `journey.json`): the flows as readable sequences, every screen named
// by its type with what the agent said about it, and the QA findings by severity. Server-rendered on the shared design,
// no script; screenshots load from `screens/`, so the folder can be zipped, served or published as-is.
import { DEVICES } from '../browser/devices.ts';
import {
  BASE_STYLE,
  embeddedJson,
  escapeHtml as escape,
  fact,
  FONT_STYLESHEET,
  GENERATOR_META,
  JEVWAY_VERSION,
  plural,
} from '../recording/recording-page.ts';
import { describeAction, type Hotspot, type JourneyDoc, type JourneyScreen } from './journey-doc.ts';
import type { QaFinding } from './screen-judgments.ts';

const SEVERITIES: QaFinding['severity'][] = ['high', 'medium', 'low'];

const words = (key: string) => key.replaceAll('_', ' ');
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A screen's type as its name: "Results", "Navigation menu". */
const typeName = (screen: JourneyScreen) => capitalized(words(screen.type));
/** "s03 · Results": how every part of the page names a screen. */
const screenName = (screen: JourneyScreen) => `${screen.id} · ${typeName(screen)}`;
const percent = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;
const boxStyle = (box: Hotspot) => `left:${percent(box.x)};top:${percent(box.y)};width:${percent(box.width)};height:${percent(box.height)}`;
// ISO time → "2026-11-02 09:04 UTC"
const utc = (iso: string) => (Number.isNaN(Date.parse(iso)) ? iso : `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

/** The shot of a screen in the device's shape (no shift as it loads), the tapped spot or the primary action outlined. */
const shot = (screen: JourneyScreen, size: { width: number; height: number }, outline?: { box: Hotspot; kind: 'hotspot' | 'primary' }) =>
  `<span class="frame"><img src="${escape(screen.screenshot)}" alt="${escape(`${typeName(screen)} screen (${screen.id}): ${screen.description ?? screen.title}`)}" loading="lazy" decoding="async" width="${size.width}" height="${size.height}">${
    outline ? `<span class="${outline.kind}" aria-hidden="true" style="${boxStyle(outline.box)}"></span>` : ''
  }</span>`;

const VIEWER_STYLE = `
.run-top { padding-block: 2.5rem 0; display: grid; gap: 1.75rem; }
.run-top .label { padding-top: 0.5rem; }
.lede { margin-top: 0.75rem; }
.block { margin-top: 4rem; }
.block-head { margin-bottom: 1.5rem; }
.journey { padding-bottom: 4rem; }
.frame { position: relative; display: block; border-radius: 0.75rem; overflow: hidden; background: var(--muted); }
.frame img { width: 100%; height: auto; aspect-ratio: var(--shot-aspect); object-fit: cover; object-position: top; }
.hotspot, .primary { position: absolute; border-radius: 0.375rem; pointer-events: none; }
.hotspot { border: 2px solid var(--missed); background: color-mix(in oklch, var(--missed) 14%, transparent); }
.primary { border: 2px dashed var(--missed); opacity: 0.75; }
.flow { border-top: 1px solid var(--muted); padding-block: 1.5rem 2rem; }
.flow h3 { font-size: 1.125rem; line-height: 1.5rem; font-weight: 500; }
.sequence { margin-top: 0.5rem; font-size: 0.9375rem; line-height: 1.5rem; color: var(--muted-foreground); overflow-wrap: anywhere; }
.sequence a { color: var(--foreground); text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 3px; }
.flow-strip { display: flex; gap: var(--gap); overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; margin-top: 1.25rem; padding-bottom: 0.75rem; scrollbar-width: thin; }
.flow-strip li { flex: 0 0 var(--card); scroll-snap-align: start; min-width: 0; }
.flow-strip figure { display: flex; flex-direction: column; gap: 0.5rem; }
.flow-strip a.frame:hover img { opacity: 0.85; }
figcaption { display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.875rem; line-height: 1.25rem; overflow-wrap: anywhere; }
figcaption .then { color: var(--muted-foreground); }
.screens { display: grid; gap: 0; }
.screen-entry { border-top: 1px solid var(--muted); padding: 1.5rem 0.75rem; margin-inline: -0.75rem; scroll-margin-top: 3rem; align-items: start; }
.screen-entry:target { background: color-mix(in oklch, var(--muted) 35%, transparent); box-shadow: inset 2px 0 0 var(--foreground); }
.screen-entry figure { max-width: var(--figure); }
.screen-entry h3 { font-size: 1.125rem; line-height: 1.5rem; font-weight: 500; }
.screen-entry .body { display: grid; gap: 0.5rem; align-content: start; }
.screen-entry .body p { font-size: 0.9375rem; line-height: 1.5rem; overflow-wrap: anywhere; }
.insight { color: var(--muted-foreground); }
.chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.chip { border: 1px solid var(--muted); border-radius: 99px; padding: 0 0.5rem; font-size: 0.75rem; line-height: 1.25rem; color: var(--muted-foreground); }
.sev { font-size: 0.75rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.02em; margin-right: 0.375rem; }
.sev.high { color: var(--missed); } .sev.medium { color: var(--reached); } .sev.low { color: var(--muted-foreground); }
.findings li { padding-block: 0.375rem; font-size: 0.9375rem; line-height: 1.5rem; overflow-wrap: anywhere; }
.qa-group { border-top: 1px solid var(--muted); padding-block: 1.25rem; align-items: start; }
.qa-group h3 { margin-bottom: 0.5rem; }
.qa-group .findings li { display: flex; flex-wrap: wrap; gap: 0 0.5rem; }
.kind { font-weight: 500; }
.qa-group a { text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 3px; }
.empty { color: var(--muted-foreground); }
`;

const flowSection = (doc: JourneyDoc, screens: Map<string, JourneyScreen>, size: { width: number; height: number }) => {
  const flows = [...doc.flows].sort((a, b) => a.name.localeCompare(b.name)).filter((flow) => flow.screens.length);
  if (!flows.length) return '<p class="small empty">No steps yet: the journey has its start screen only.</p>';
  return flows
    .map((flow) => {
      const known = flow.screens.filter(({ screen }) => screens.has(screen));
      const sequence = known
        .map(({ screen, action }) => {
          const s = screens.get(screen)!;
          return `<a href="#${escape(s.id)}">${escape(typeName(s))} (${escape(s.id)})</a>${action ? ` → ${escape(action)}` : ''}`;
        })
        .join(' → ');
      const cards = known
        .map(({ screen, action, hotspot }, i) => {
          const s = screens.get(screen)!;
          return `<li><figure><a class="frame-link" href="#${escape(s.id)}" aria-label="${escape(screenName(s))}">${shot(s, size, hotspot ? { box: hotspot, kind: 'hotspot' } : undefined)}</a><figcaption><span class="meta num">${String(i + 1).padStart(2, '0')} · ${escape(s.id)}</span><span>${escape(typeName(s))}</span>${
            action ? `<span class="then">${escape(action)}</span>` : ''
          }</figcaption></figure></li>`;
        })
        .join('');
      return `<article class="flow"><h3>${escape(flow.name.split('/').join(' / '))}</h3><p class="sequence">${sequence}</p><ol class="flow-strip">${cards}</ol></article>`;
    })
    .join('\n');
};

const screenArticle = (screen: JourneyScreen, doc: JourneyDoc, screens: Map<string, JourneyScreen>, size: { width: number; height: number }) => {
  const reached = doc.steps
    .filter((step) => step.to === screen.id && step.from !== screen.id && screens.has(step.from))
    .map((step) => `<a href="#${escape(step.from)}">${escape(screenName(screens.get(step.from)!))}</a> by ${escape(describeAction(step))}`);
  const body = [
    `<h3>${escape(screenName(screen))}</h3>`,
    `<p class="small">${escape(screen.title)} · <span class="address">${escape(screen.url)}</span></p>`,
    ...(screen.description ? [`<p>${escape(screen.description)}</p>`] : []),
    ...(screen.insight ? [`<p class="insight">${escape(screen.insight)}</p>`] : []),
    ...(screen.patterns.length ? [`<p class="chips" aria-label="UI patterns">${screen.patterns.map((p) => `<span class="chip">${escape(words(p))}</span>`).join('')}</p>`] : []),
    ...(screen.qa.length
      ? [`<ul class="findings" aria-label="QA findings">${[...screen.qa].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)).map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span><span class="kind">${escape(words(f.kind))}</span> ${escape(f.detail)}</li>`).join('')}</ul>`]
      : []),
    ...(reached.length ? [`<p class="small">Reached from ${reached.join('; ')}</p>`] : screen.id === doc.screens[0]?.id ? ['<p class="small">The start screen</p>'] : []),
  ];
  const primary = screen.primaryAction ? { box: screen.primaryAction, kind: 'primary' as const } : undefined;
  return `<article class="screen-entry grid4" id="${escape(screen.id)}"><figure>${shot(screen, size, primary)}${
    screen.primaryAction ? `<figcaption class="small">Dashed: the primary action${screen.primaryAction.element ? `, ${escape(screen.primaryAction.element)}` : ''}</figcaption>` : ''
  }</figure><div class="body c2s3">${body.join('')}</div></article>`;
};

const qaSection = (doc: JourneyDoc) => {
  const findings = doc.screens.flatMap((screen) => screen.qa.map((finding) => ({ ...finding, screen })));
  if (!findings.length) return '<p class="small empty">No QA findings.</p>';
  return SEVERITIES.map((severity) => {
    const group = findings.filter((f) => f.severity === severity);
    if (!group.length) return '';
    const items = group
      .map((f) => `<li><span class="kind">${escape(words(f.kind))}</span><span>${escape(f.detail)}</span><span class="small">on <a href="#${escape(f.screen.id)}">${escape(screenName(f.screen))}</a></span></li>`)
      .join('');
    return `<div class="qa-group grid4"><h3 class="sev ${severity}">${capitalized(severity)} · ${group.length}</h3><ul class="findings c2s3">${items}</ul></div>`;
  }).join('\n');
};

/**
 * The journey map as one self-contained page: what was explored and on which device, then each flow as a sequence of
 * screens and the actions between them, every screen (by type, with its description, insight, patterns, findings and
 * how it was reached, at `#<screen id>`), and the QA findings by severity, each linking its screen. The doc itself is
 * embedded as `#jevway-journey`.
 *
 * @example
 * writeFileSync(join(outDir, 'index.html'), renderViewer(doc));
 */
export const renderViewer = (doc: JourneyDoc) => {
  const screens = new Map(doc.screens.map((screen) => [screen.id, screen]));
  const device = Object.hasOwn(DEVICES, doc.device) ? DEVICES[doc.device as keyof typeof DEVICES] : DEVICES.desktop;
  const size = { width: device.width, height: device.height };
  const portrait = size.height > size.width;
  const flowCount = doc.flows.filter((flow) => flow.screens.length).length;
  const findings = doc.screens.flatMap((screen) => screen.qa);
  const high = findings.filter((f) => f.severity === 'high').length;
  const counts = `${plural(doc.screens.length, 'screen')} in ${plural(flowCount, 'flow')}, ${plural(findings.length, 'QA finding')}${high ? ` (${high} high)` : ''}.`;
  const shape = `--shot-aspect:${size.width} / ${size.height};--card:${portrait ? '10rem' : '18rem'};--figure:${portrait ? '14rem' : '100%'}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escape(`${doc.site}: journey map · jevway`)}</title>
<meta name="description" content="${escape(`${doc.site}: ${counts}`)}">
${GENERATOR_META}
<meta name="color-scheme" content="light dark">
<link rel="alternate" type="application/json" href="journey.json" title="This journey as data">
${FONT_STYLESHEET}
<style>${BASE_STYLE}${VIEWER_STYLE}</style>
</head><body style="${shape}">
<nav class="top" aria-label="This page"><div class="wrapper"><span>jevway · journey</span><div class="links"><a href="#flows">Flows</a><a href="#screens">Screens</a><a href="#qa">QA</a><a href="journey.json">journey.json</a></div></div></nav>
<header class="wrapper run-top">
<div class="grid4"><p class="meta label">Journey</p><div class="c2s3"><h1 class="job-title">${escape(doc.site)}</h1>${doc.intent ? `<p class="small lede"><span class="kv">Asked</span> ${escape(doc.intent)}</p>` : ''}<p class="small lede">${counts}</p></div></div>
<dl class="facts">${[fact('Start page', `<span class="address">${escape(doc.startUrl)}</span>`), fact('Device', `${escape(doc.device)} <span class="num">(${size.width} × ${size.height})</span>`), fact('Mapped', escape(utc(doc.createdAt)))].join('\n')}</dl>
</header>
<main class="wrapper journey">
<section id="flows" class="block" aria-labelledby="flows-title"><h2 class="section-title block-head" id="flows-title">Flows</h2>
${flowSection(doc, screens, size)}
</section>
<section id="screens" class="block" aria-labelledby="screens-title"><h2 class="section-title block-head" id="screens-title">Screens</h2>
<div class="screens">${doc.screens.map((screen) => screenArticle(screen, doc, screens, size)).join('\n')}</div>
</section>
<section id="qa" class="block" aria-labelledby="qa-title"><h2 class="section-title block-head" id="qa-title">QA findings</h2>
${qaSection(doc)}
</section>
</main>
<footer><div class="wrapper"><span>Mapped by jevway ${escape(JEVWAY_VERSION)}. Solid outline: the spot tapped to leave a screen; dashed: its primary action.</span><span><a href="journey.json">journey.json</a> · <a href="manifest.json">manifest.json</a></span></div></footer>
${embeddedJson('jevway-journey', doc)}
</body></html>
`;
};
