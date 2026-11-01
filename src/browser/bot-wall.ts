/**
 * Bot walls: a CDN challenge, a captcha interstitial or an "unusual traffic" page that stands between the run and the
 * site. Judged from the page alone (title, the top of its text, visible challenge boxes), never by asking a model.
 * jevway never tries to get past one; the run waits a moment for it to clear itself, then hands back.
 */
import type { PageState } from './tab.ts';

export interface BotWall {
  /** What the reason names: "Cloudflare", "Cloudflare Turnstile", "reCAPTCHA", "hCaptcha", "Turnstile" or '"unusual traffic" page'. */
  name: string;
  /** Whose check it is, for the summary's `wall.name`: a Cloudflare page with a Turnstile box is `cloudflare`. */
  provider: 'cloudflare' | 'recaptcha' | 'hcaptcha' | 'turnstile' | 'unusual-traffic';
  /** The title and markers that made it a wall, at most 4; never page content beyond them. */
  evidence: string[];
}

/** A visible challenge box, by the service that draws it. */
export type ChallengeBox = 'reCAPTCHA' | 'hCaptcha' | 'Turnstile';

// A challenge page says it all at the top; comments and articles that discuss captchas sit below this.
const HEAD_CHARS = 600;
// Cloudflare's interstitial titles. Alone they prove nothing (an app may say "Just a moment..." while loading).
const CHALLENGE_TITLES = ['just a moment...', 'attention required! | cloudflare', 'please wait... | cloudflare'];
// Lines a challenge shows. A brand line is one an article quoting a challenge rarely carries along with two more.
const MARKERS: { text: string; brand?: 'Cloudflare' | 'Google' }[] = [
  { text: 'our systems have detected unusual traffic from your computer network', brand: 'Google' },
  { text: "this page checks to see if it's really you sending the requests" },
  { text: 'uses a security service to protect against malicious bots' },
  { text: 'needs to review the security of your connection' },
  { text: 'checking if the site connection is secure' },
  { text: 'enable javascript and cookies to continue' },
  { text: 'checking your browser before accessing' },
  { text: 'performance and security by cloudflare', brand: 'Cloudflare' },
  { text: 'performance & security by cloudflare', brand: 'Cloudflare' },
  { text: 'performing security verification' },
  { text: 'complete the security check' },
  { text: 'sorry, you have been blocked' },
  { text: 'verifies you are not a bot' },
  { text: 'verify you are not a bot' },
  { text: 'verifying you are human' },
  { text: 'verify you are human' },
  { text: 'unusual traffic' },
  { text: 'are you a robot' },
  { text: 'not a robot' },
  { text: 'ray id:', brand: 'Cloudflare' },
];
const MAX_EVIDENCE = 4;

const normalized = (text: string) => text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Whether a page is a bot wall, and which. A wall is a Cloudflare challenge title with at least one challenge line, or
 * 3+ distinct challenge lines including a brand line (Cloudflare's Ray ID or footer, Google's unusual-traffic
 * sentence), or a large visible challenge box with 2+ challenge lines. So an article quoting a line or two, a thread
 * about captchas, or a sign-in page is never one. Only the title and the first 600 characters of the text count.
 *
 * @example
 * detectBotWall({ title: 'Just a moment...', text: 'Performing security verification\nRay ID: …' });
 * // { name: 'Cloudflare', provider: 'cloudflare', evidence: ['title "just a moment..."', 'ray id:', 'performing security verification'] }
 */
export const detectBotWall = (page: Pick<PageState, 'title' | 'text'>, boxes: ChallengeBox[] = []): BotWall | undefined => {
  const title = normalized(page.title);
  const head = normalized(page.text).slice(0, HEAD_CHARS);
  const titleHit = CHALLENGE_TITLES.find((candidate) => title.includes(candidate));
  // Longest first, so a line counted once never counts again through a shorter marker inside it.
  const matched: typeof MARKERS = [];
  for (const marker of MARKERS) {
    if (head.includes(marker.text) && !matched.some((m) => m.text.includes(marker.text))) matched.push(marker);
  }
  const brands = new Set(matched.flatMap((m) => (m.brand ? [m.brand] : [])));
  const isWall =
    (titleHit && matched.length >= 1) || (matched.length >= 3 && brands.size > 0) || (boxes.length > 0 && matched.length >= 2);
  if (!isWall) return undefined;
  const cloudflare = Boolean(titleHit) || brands.has('Cloudflare');
  const name = cloudflare
    ? boxes.includes('Turnstile') ? 'Cloudflare Turnstile' : 'Cloudflare'
    : (boxes[0] ?? '"unusual traffic" page');
  // The brand lines say whose check it is, so they lead; the rest follow in page order.
  const inPageOrder = [...matched].sort((a, b) => Number(!a.brand) - Number(!b.brand) || head.indexOf(a.text) - head.indexOf(b.text));
  const evidence = [...(titleHit ? [`title "${titleHit}"`] : []), ...inPageOrder.map((m) => m.text)].slice(0, MAX_EVIDENCE);
  const provider = cloudflare ? 'cloudflare' : boxes[0] ? PROVIDER_OF_BOX[boxes[0]] : 'unusual-traffic';
  return { name, provider, evidence };
};

const PROVIDER_OF_BOX = { reCAPTCHA: 'recaptcha', hCaptcha: 'hcaptcha', Turnstile: 'turnstile' } as const;

// In-page: the visible challenge boxes at least 16000 px² (a checkbox widget is ~300×78), never an invisible reCAPTCHA.
export const CHALLENGE_BOXES = `(() => {
  const nameOf = (s) => /recaptcha/i.test(s) ? 'reCAPTCHA' : /h-?captcha/i.test(s) ? 'hCaptcha' : /challenges\\.cloudflare\\.com|turnstile/i.test(s) ? 'Turnstile' : '';
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    return r.width * r.height >= 16000 && e.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false;
  };
  const found = [];
  for (const frame of document.querySelectorAll('iframe[src]')) {
    const src = frame.getAttribute('src') || '';
    if (nameOf(src) && !/size=invisible/.test(src) && shown(frame)) found.push(nameOf(src));
  }
  for (const box of document.querySelectorAll('.g-recaptcha,.h-captcha,.cf-turnstile')) {
    const name = nameOf(box.getAttribute('class') || '');
    if (name && shown(box)) found.push(name);
  }
  return [...new Set(found)];
})()`;

/**
 * The bot wall on an observed page, if any. The page's text decides; only text that already looks like a challenge
 * costs one more read (the challenge boxes, which sit in iframes the text can't see), and a failed read still finds the
 * wall from its text.
 *
 * @example
 * const wall = await findBotWall(tab, await tab.observe()); // { name: 'Cloudflare', provider: 'cloudflare', evidence: [...] } on npm's challenge
 */
export const findBotWall = async (tab: { evaluate(expression: string): Promise<unknown> }, page: Pick<PageState, 'title' | 'text'>) => {
  const head = normalized(page.text).slice(0, HEAD_CHARS);
  if (!MARKERS.some((marker) => head.includes(marker.text))) return undefined;
  let boxes: ChallengeBox[] = [];
  try {
    const read = await tab.evaluate(CHALLENGE_BOXES);
    if (Array.isArray(read)) boxes = read;
  } catch {
    // A page navigating away mid-read: the text alone still decides.
  }
  return detectBotWall(page, boxes);
};
