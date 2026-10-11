import { connectChrome, type BrowserSource, type ChromeHandle } from '../browser/chrome.ts';
import { Tab } from '../browser/tab.ts';
import { createAsk, resolveModel } from '../jev/model.ts';
import { JourneySession, type JourneyOptions } from '../journeys/journey-session.ts';
import { BrowserTask, type TaskOptions } from './run-task.ts';

export interface StartOptions extends TaskOptions {
  /** Open this URL in a new background tab. */
  url?: string;
  /** Or drive an already-open tab whose URL contains this text. */
  tab?: string;
}

/**
 * Connects a browser once and starts tasks on tabs inside it. Needs the chosen model's key:
 * `TYPESAFE_API_KEY` for Jev (default), `OPENROUTER_API_KEY` for Clef-omni.
 *
 * @example
 * const runner = createRunner('auto', { model: 'clef' });
 * const task = await runner.start({ url: 'https://en.wikipedia.org', goal: 'Open the article on Gödel' });
 * console.log(await task.run());
 */
export const createRunner = (source: BrowserSource, choice: { model?: string } = {}) => {
  const { profile } = resolveModel({ ...choice, screenshots: 'off' });
  const ask = createAsk(profile);
  let chrome: Promise<ChromeHandle> | undefined;
  const browser = () => (chrome ??= connectChrome(source));

  return {
    async start({ url, tab, ...options }: StartOptions) {
      const { cdp } = await browser();
      if (!url && !tab) throw new Error('Pass `url` to open a new tab or `tab` to reuse an open one.');
      const page = url ? await Tab.open(cdp, url) : await Tab.find(cdp, tab!);
      return new BrowserTask(page, ask, {
        ...options,
        minConfidence: options.minConfidence ?? profile.minConfidence,
        compactRules: profile.compactRules,
        elementRisk: profile.elementRisk,
      });
    },
    /** Mobile journey mapping; in the user's own Chrome it opens a separate window so screenshots keep rendering. */
    async startJourney(options: JourneyOptions) {
      const { cdp } = await browser();
      return JourneySession.start(cdp, ask, {
        newWindow: source === 'auto',
        ...options,
        compactRules: profile.compactRules,
        elementRisk: profile.elementRisk,
      });
    },
    async close() {
      if (chrome) await (await chrome).close();
      chrome = undefined;
    },
  };
};
