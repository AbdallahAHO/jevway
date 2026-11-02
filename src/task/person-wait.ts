/**
 * Waiting for a person at a wall: which pages count as an SSO sign-in or as still signing in, and the wait itself.
 * Code only: the page is read, never acted on, and no model is asked.
 */
import type { PageState } from '../browser/tab.ts';

export type SsoProvider = 'Google' | 'Apple' | 'Microsoft';

// Identity providers' sign-in hosts. Their own pages (sign-up, settings) carry no request from another site.
const SSO_HOSTS: Record<string, SsoProvider> = {
  'accounts.google.com': 'Google',
  'appleid.apple.com': 'Apple',
  'login.microsoftonline.com': 'Microsoft',
  'login.live.com': 'Microsoft',
};
// A path segment that is a step of signing in: a page there is still the sign-in, whatever it shows.
const SIGN_IN_STEP = /^(log-?in|sign-?in|sign_in|sessions?|auth|oauth2?|sso|saml2?|2fa|two-factor|mfa|otp|verify|challenge)$/i;

// A query decoded up to twice: Google nests the OAuth request URL-encoded inside `continue`.
const decodedQuery = (search: string) => {
  let query = search;
  for (let i = 0; i < 2; i++) {
    try {
      query = decodeURIComponent(query);
    } catch {
      break;
    }
  }
  return query;
};

/**
 * The identity provider when `url` is its sign-in for another site: a provider host whose query carries an OAuth or
 * OIDC request (`client_id` and `redirect_uri`, possibly nested in `continue`) or a SAML one (`SAMLRequest`).
 *
 * @example
 * ssoProviderOf('https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=https%3A%2F%2Fapp.example') // 'Google'
 * ssoProviderOf('https://accounts.google.com/signup') // undefined
 */
export const ssoProviderOf = (url: string): SsoProvider | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const provider = SSO_HOSTS[parsed.hostname];
  if (!provider) return undefined;
  const query = decodedQuery(parsed.search);
  const oauth = /[?&]client_id=/.test(query) && /[?&]redirect_uri=/.test(query);
  return oauth || /[?&]SAMLRequest=/.test(query) ? provider : undefined;
};

const pathOf = (url: string) => {
  try {
    const { origin, pathname } = new URL(url);
    return { at: `${origin}${pathname}`, segments: pathname.split('/').filter(Boolean) };
  } catch {
    return { at: url, segments: [] };
  }
};

/**
 * Whether `page` is still the sign-in `wall` was on: it shows a password field (typed or not), it is the wall's page
 * still listing a field the wall had empty (filled or not), its path is a sign-in step (`/login`, `/sessions/two-factor`,
 * `/auth/callback`), or it is an SSO page. Conservative: a person mid-way is never taken for done.
 *
 * @example
 * stillSigningIn(dashboard, loginPage) // false
 */
export const stillSigningIn = (page: PageState, wall: PageState) => {
  if (page.passwordFields?.length) return true;
  const here = pathOf(page.url);
  if (here.at === pathOf(wall.url).at) {
    const wallFields = new Set(wall.actions.filter((action) => action.kind === 'fill' && !action.value).map((action) => action.label));
    if (page.actions.some((action) => action.kind === 'fill' && wallFields.has(action.label))) return true;
  }
  return here.segments.some((segment) => SIGN_IN_STEP.test(segment)) || Boolean(ssoProviderOf(page.url));
};

/** How a wait for a person ended: they got past the wall, the time ran out, the call was stopped, or the tab went away. */
export type WaitOutcome = 'passed' | 'ran_out' | 'stopped' | 'gone';

export interface PersonWaitLoop {
  waitMs: number;
  /** How often the page is read again, and how often a countdown note is told. */
  pollMs: number;
  tickMs: number;
  /** Reads that must in a row not be the wall: 2 for a sign-in, so a blank page mid-redirect never counts. */
  clearReads: number;
  /** The page now, or undefined once the tab is gone. */
  read: () => Promise<PageState | undefined>;
  isWall: (page: PageState) => Promise<boolean> | boolean;
  /** Sleeps, or less when the call is stopped. */
  pause: (ms: number) => Promise<void>;
  stopped: () => boolean;
  /** Hears the seconds left: at once, then every `tickMs`. */
  tell: (secondsLeft: number) => void;
}

/**
 * Reads the page until the wall is gone for `clearReads` reads in a row, the wait runs out, or the call is stopped.
 *
 * @example
 * const { outcome, page } = await waitForPersonLoop({ waitMs: 120_000, pollMs: 1000, tickMs: 10_000, clearReads: 1, read, isWall, pause, stopped, tell });
 */
export const waitForPersonLoop = async ({ waitMs, pollMs, tickMs, clearReads, read, isWall, pause, stopped, tell }: PersonWaitLoop) => {
  const deadline = performance.now() + waitMs;
  let nextTick = performance.now();
  let clear = 0;
  let page: PageState | undefined;
  for (;;) {
    const now = performance.now();
    if (now >= deadline) return { outcome: 'ran_out' as WaitOutcome, page };
    if (now >= nextTick) {
      tell(Math.ceil((deadline - now) / 1000));
      nextTick = now + tickMs;
    }
    await pause(Math.min(pollMs, deadline - now));
    if (stopped()) return { outcome: 'stopped' as WaitOutcome, page };
    const next = await read();
    if (!next) return { outcome: 'gone' as WaitOutcome, page };
    page = next;
    clear = (await isWall(page)) ? 0 : clear + 1;
    if (clear >= clearReads) return { outcome: 'passed' as WaitOutcome, page };
  }
};
