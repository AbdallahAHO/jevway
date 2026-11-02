import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFlows, type JourneyDoc, type JourneyScreen, type JourneyStep } from '../../src/journeys/journey-doc.ts';
import { renderViewer } from '../../src/journeys/render-viewer.ts';

// The index.html a journey folder holds: a map of the screens a run walked through, read by people and agents.

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

const screen = (id: string, type: JourneyScreen['type'], title: string, over: Partial<JourneyScreen> = {}): JourneyScreen => ({
  id,
  url: `http://stays.test/#/${type}`,
  title,
  screenshot: `screens/${id}-${type}.png`,
  capturedAt: '2026-11-02T09:05:00.000Z',
  type,
  typeConfidence: 0.9,
  patterns: [],
  qa: [],
  ...over,
});
const hotspot = { x: 0.1, y: 0.2, width: 0.8, height: 0.06 };
const STEPS: JourneyStep[] = [
  { from: 's01', to: 's02', flow: 'Homes/Searching homes', action: { operation: 'CLICK', label: 'Where to?' }, hotspot, by: 'agent' },
  { from: 's02', to: 's02', flow: 'Homes/Searching homes', action: { operation: 'TYPE_TEXT', label: 'Destination', value: 'Lisbon' }, hotspot: null, by: 'agent' },
  { from: 's02', to: 's03', flow: 'Homes/Searching homes', action: { operation: 'CLICK', label: 'Search' }, hotspot, by: 'agent' },
  { from: 's03', to: 's04', flow: 'Homes/Home details', action: { operation: 'CLICK', label: 'Casa Flora' }, hotspot, by: 'autopilot' },
];
const DOC: JourneyDoc = {
  site: 'stays.test',
  startUrl: 'http://stays.test/',
  device: 'iphone-15',
  intent: 'Find a home in Lisbon and open its details',
  createdAt: '2026-11-02T09:04:12.000Z',
  screens: [
    screen('s01', 'home', 'Staylist', { description: 'The home screen with a search pill.', insight: 'Search is the primary entry point.', patterns: ['search_bar', 'bottom_navigation'], primaryAction: { ...hotspot, confidence: 0.8, element: 'Where to?' } }),
    screen('s02', 'search', 'Staylist', { description: 'Destination search with autocomplete.' }),
    screen('s03', 'results', 'Homes in Lisbon', {
      qa: [
        { kind: 'small_tap_target', severity: 'medium', detail: '"Filters" is 20×20 px' },
        { kind: 'console_error', severity: 'high', detail: 'TypeError: price is undefined' },
      ],
    }),
    screen('s04', 'detail', 'Casa Flora <Lisbon>', { qa: [{ kind: 'unlabeled_control', severity: 'low', detail: 'An icon button has no name' }] }),
  ],
  steps: STEPS,
  flows: buildFlows(STEPS),
};
const html = renderViewer(DOC);

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = (fragment: string) => fragment.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
const text = (fragment: string) => decode(fragment.replace(/<script\b[\s\S]*?<\/script>/g, ' ').replace(/<style\b[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const headings = (page: string) => [...page.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map(([, level, inner]) => `h${level} ${text(inner).trim()}`);
const section = (page: string, id: string) => {
  const start = page.indexOf(`<section id="${id}"`);
  if (start < 0) return '';
  const next = page.indexOf('<section id="', start + 1);
  return page.slice(start, next < 0 ? page.indexOf('</main>', start) : next);
};
const article = (page: string, id: string) => {
  const match = new RegExp(`<article [^>]*id="${id}"[\\s\\S]*?</article>`).exec(page);
  return match ? match[0] : '';
};

describe('the journey viewer', () => {
  it('reads without a script: every screen, flow and finding is in the HTML itself', () => {
    expect([...html.matchAll(/<script>/g)]).toHaveLength(0);
    expect(html).not.toContain('innerHTML');
    for (const s of DOC.screens) expect(html).toContain(`id="${s.id}"`);
  });

  it('declares its language, the generator, and the journey as JSON an agent can parse', () => {
    expect(html).toMatch(/^<!doctype html>\s*<html lang="en"/);
    expect(html).toContain(`<meta name="generator" content="jevway ${version}">`);
    const match = /<script type="application\/json" id="jevway-journey">([\s\S]*?)<\/script>/.exec(html)!;
    expect(JSON.parse(match[1])).toEqual(JSON.parse(JSON.stringify(DOC)));
    expect(html).toContain('href="journey.json"');
    expect(html).toContain('href="manifest.json"');
  });

  it('opens on the site, the intent, the device and the counts', () => {
    const top = text(html.slice(html.indexOf('<header'), html.indexOf('</header>')));
    expect(headings(html)[0]).toBe('h1 stays.test');
    expect(top).toContain('Find a home in Lisbon and open its details');
    expect(top).toMatch(/4 screens/);
    expect(top).toMatch(/2 flows/);
    expect(top).toMatch(/3 QA findings/);
    expect(top).toContain('iphone-15');
    expect(top).toContain('http://stays.test/');
    expect(top).toContain('2026-11-02 09:04 UTC');
  });

  it('keeps its headings in order', () => {
    const levels = headings(html).map((h) => Number(h[1]));
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    levels.forEach((level, i) => expect(level - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1));
    expect(headings(html)).toEqual(expect.arrayContaining(['h2 Flows', 'h2 Screens', 'h2 QA findings']));
  });

  it('names each screen by its type, with its description, insight, patterns and how it was reached', () => {
    const home = text(article(html, 's01'));
    expect(headings(article(html, 's01'))[0]).toBe('h3 s01 · Home');
    expect(home).toContain('The home screen with a search pill.');
    expect(home).toContain('Search is the primary entry point.');
    expect(home).toContain('search bar');
    expect(headings(article(html, 's03'))[0]).toBe('h3 s03 · Results');
    expect(text(article(html, 's03'))).toMatch(/Reached from s02 · Search by Tap "Search"/);
  });

  it('tells each flow as a readable sequence of screens and actions, linking each screen', () => {
    const flows = text(section(html, 'flows'));
    expect(headings(section(html, 'flows'))).toEqual(expect.arrayContaining(['h3 Homes / Searching homes', 'h3 Homes / Home details']));
    expect(flows).toContain('Home (s01) → Tap "Where to?" → Search (s02) → Type into "Destination" → "Lisbon", then Tap "Search" → Results (s03)');
    expect(section(html, 'flows')).toContain('href="#s02"');
  });

  it('groups QA findings by severity, highest first, each naming and linking the screen it is on', () => {
    const qa = section(html, 'qa');
    expect(headings(qa).slice(1)).toEqual(['h3 High · 1', 'h3 Medium · 1', 'h3 Low · 1']);
    expect(text(qa)).toMatch(/console error TypeError: price is undefined on s03 · Results/);
    expect(qa).toMatch(/<a href="#s03">s03 · Results<\/a>/);
    expect(text(article(html, 's03'))).toContain('TypeError: price is undefined');
  });

  it('says so when there is nothing to show', () => {
    const empty = renderViewer({ ...DOC, screens: [DOC.screens[0]], steps: [], flows: [] });
    expect(text(section(empty, 'flows'))).toContain('No steps yet');
    expect(text(section(empty, 'qa'))).toContain('No QA findings');
  });

  it('frames every shot in the device\'s aspect, with alt text and the tapped spot outlined', () => {
    for (const [, alt] of html.matchAll(/<img [^>]*alt="([^"]*)"/g)) expect(alt.trim()).not.toBe('');
    expect(html).toMatch(/<img [^>]*src="screens\/s01-home\.png"[^>]*width="393" height="852"/);
    expect(html).toMatch(/class="hotspot" aria-hidden="true" style="left:10%;top:20%;width:80%;height:6%"/);
  });

  it('escapes page titles and keeps the embedded JSON inert', () => {
    expect(html).not.toContain('Casa Flora <Lisbon>');
    expect(text(article(html, 's04'))).toContain('Casa Flora <Lisbon>');
    const hostile = renderViewer({ ...DOC, intent: '</script><script>alert(1)</script>' });
    expect(hostile).not.toContain('<script>alert(1)');
  });

  it('follows the reader\'s colour scheme on the shared design', () => {
    expect(html).toContain('--muted-foreground');
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });
});
