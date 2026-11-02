/**
 * Every phrase jevway says to the person at a wall: the desktop notification, the countdown the agent relays, and the
 * story line once it cleared. Built from the wall's kind, host and name only, never from the page's text.
 */

/** A wall a person can get past: a bot check by its name (`BotWall.name`), a site's sign-in by host, an SSO page by provider. */
export type PersonWall =
  | { kind: 'bot_check'; check: string }
  | { kind: 'sign_in'; host: string }
  | { kind: 'sso'; provider: 'Google' | 'Apple' | 'Microsoft' };

// '"unusual traffic" page' → 'the "unusual traffic" check'; 'Cloudflare' → 'the Cloudflare check'.
const checkName = (check: string) => `the ${check.replace(/ page$/, '')} check`;

// What the person does, as a phrase that follows "to" or starts a sentence once capitalised.
const task = (wall: PersonWall) => {
  switch (wall.kind) {
    case 'bot_check':
      return `pass ${checkName(wall.check)} in the Chrome window`;
    case 'sign_in':
      return `sign in to ${wall.host} in Chrome`;
    case 'sso':
      return `finish signing in with ${wall.provider} in Chrome`;
  }
};

/**
 * The desktop notification's body.
 *
 * @example
 * notificationText({ kind: 'sign_in', host: 'github.com' }) // 'Sign in to github.com in Chrome'
 */
export const notificationText = (wall: PersonWall) => {
  const text = task(wall);
  return `${text[0].toUpperCase()}${text.slice(1)}`;
};

/**
 * The countdown line the run tells while it waits.
 *
 * @example
 * waitingText({ kind: 'bot_check', check: 'Cloudflare' }, 45) // 'Waiting for you to pass the Cloudflare check in the Chrome window (45 s left)'
 */
export const waitingText = (wall: PersonWall, secondsLeft: number) => `Waiting for you to ${task(wall)} (${secondsLeft} s left)`;

/**
 * The step a run's history and story carry once the person got past the wall.
 *
 * @example
 * passedText({ kind: 'sso', provider: 'Google' }) // 'A person finished signing in with Google'
 */
export const passedText = (wall: PersonWall) => {
  switch (wall.kind) {
    case 'bot_check':
      return `A person passed ${checkName(wall.check)}`;
    case 'sign_in':
      return `A person signed in to ${wall.host}`;
    case 'sso':
      return `A person finished signing in with ${wall.provider}`;
  }
};
