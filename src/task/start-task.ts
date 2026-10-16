import { connectChrome, type BrowserSource, type ChromeHandle } from '../browser/chrome.ts';
import { Tab } from '../browser/tab.ts';
import { createAsk, profileOptions, resolveModel } from '../jev/model.ts';
import { JourneySession, type JourneyOptions } from '../journeys/journey-session.ts';
import { BrowserTask, type TaskOptions } from './run-task.ts';

export interface StartOptions extends TaskOptions {
  /** Open this URL in a new background tab. */
  url?: string;
  /** Or drive an already-open tab whose URL contains this text. */
  tab?: string;
  /** Allow exactly one irreversible click on this first call, as `update({ confirmIrreversible })` does on a later one. */
  confirmIrreversible?: boolean;
}

/**
 * Connects a browser once and starts tasks on tabs inside it. Needs the chosen model's key:
 * `TYPESAFE_API_KEY` for Jev (default), `OPENROUTER_API_KEY` for Clef-omni.
 *
 * @example
 * const runner = createRunner('auto', { model: 'pplx-decider', screenshots: 'always' });
 * const task = await runner.start({ url: 'https://en.wikipedia.org', goal: 'Open the article on Gödel' });
 * console.log(await task.run());
 */
export const createRunner = (source: BrowserSource, choice: { model?: string; screenshots?: string } = {}) => {
  const { profile, screenshots } = resolveModel(choice);
  const ask = createAsk(profile);
  let chrome: Promise<ChromeHandle> | undefined;
  const browser = () => (chrome ??= connectChrome(source));

  return {
    async start({ url, tab, confirmIrreversible, ...options }: StartOptions) {
      const { cdp } = await browser();
      if (!url && !tab) throw new Error('Pass `url` to open a new tab or `tab` to reuse an open one.');
      const page = url ? await Tab.open(cdp, url) : await Tab.find(cdp, tab!);
      const task = new BrowserTask(page, ask, {
        ...profileOptions(profile),
        ...definedOnly(options),
        screenshots: options.screenshots ?? screenshots,
      });
      task.update({ confirmIrreversible });
      return task;
    },
    /** Mobile journey mapping; in the user's own Chrome it opens a separate window so screenshots keep rendering. */
    async startJourney(options: JourneyOptions) {
      const { cdp } = await browser();
      return JourneySession.start(cdp, ask, {
        newWindow: source === 'auto',
        ...profileOptions(profile),
        ...options,
        screenshots: options.screenshots ?? screenshots,
      });
    },
    async close() {
      if (chrome) await (await chrome).close();
      chrome = undefined;
    },
  };
};

// Optional MCP/CLI arguments arrive as explicit undefined; they must not erase profile settings.
const definedOnly = <T extends object>(options: T) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;
