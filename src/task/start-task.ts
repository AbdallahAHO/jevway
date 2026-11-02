import { connectChrome, type BrowserSource, type ChromeHandle } from '../browser/chrome.ts';
import { Tab } from '../browser/tab.ts';
import type { Ask } from '../jev/decide.ts';
import { createAsk, profileOptions, resolveModel } from '../jev/model.ts';
import { replayMode } from '../jev/replay.ts';
import { JourneySession, type JourneyOptions } from '../journeys/journey-session.ts';
import { missingKeyMessage } from '../setup/env-file.ts';
import { hostsFromEnv, narrowHosts, outsideHosts, type HostRules } from './hosts.ts';
import { BrowserTask, type TaskOptions } from './run-task.ts';

export interface StartOptions extends TaskOptions {
  /** Open this URL in a new background tab. */
  url?: string;
  /** Or drive an already-open tab whose URL contains this text. */
  tab?: string;
  /** Allow exactly one irreversible click on this first call, as `update({ confirmIrreversible })` does on a later one. */
  confirmIrreversible?: boolean;
  /** With `confirmIrreversible`: the user's own words that name what the click acts on; the page must show them. */
  confirmTarget?: string;
  /** Hosts this session may be on, inside the server's `JEVWAY_ALLOWED_HOSTS`; and hosts it must never be on, besides `JEVWAY_BLOCKED_HOSTS`. */
  allowedHosts?: string[];
  blockedHosts?: string[];
}

/**
 * Connects a browser once and starts tasks on tabs inside it. Tasks and journeys need the chosen model's key:
 * `TYPESAFE_API_KEY` for Jev (default), `OPENROUTER_API_KEY` for Clef-omni. Without it the runner is still made, so an
 * MCP server can list its tools; `start` and `startJourney` then reject with the fix before any browser connects, and
 * `look` (no model call) works as usual.
 *
 * @example
 * const runner = createRunner('auto', { model: 'pplx-decider', screenshots: 'always' });
 * const task = await runner.start({ url: 'https://en.wikipedia.org', goal: 'Open the article on Gödel' });
 * console.log(await task.run());
 */
export const createRunner = (source: BrowserSource, choice: { model?: string; screenshots?: string } = {}) => {
  const { profile, screenshots } = resolveModel(choice);
  // Made on first use: a missing key fails the call that needs the model, not the server that lists the tools.
  let client: Ask | undefined;
  const ask = (): Ask => {
    // A replay answers from recordings and needs no key.
    const missing = replayMode() === 'replay' ? undefined : missingKeyMessage(profile);
    if (missing) throw new Error(missing);
    return (client ??= createAsk(profile));
  };
  let chrome: Promise<ChromeHandle> | undefined;
  const browser = () => (chrome ??= connectChrome(source));

  return {
    /** Throws the missing-key message, so the CLI can report it as a usage error before any browser starts. */
    requireKey() {
      ask();
    },
    async start({ url, tab, confirmIrreversible, confirmTarget, allowedHosts, blockedHosts, ...options }: StartOptions) {
      const decider = ask();
      // The server's lists, narrowed by the call; a start URL outside them is never opened.
      const hosts = narrowHosts(hostsFromEnv(), { allowed: allowedHosts, blocked: blockedHosts });
      if (url) refuseOutside(url, hosts);
      const { cdp } = await browser();
      if (!url && !tab) throw new Error('Pass `url` to open a new tab or `tab` to reuse an open one.');
      const page = url ? await Tab.open(cdp, url) : await Tab.find(cdp, tab!);
      const task = new BrowserTask(page, decider, {
        ...profileOptions(profile),
        ...definedOnly(options),
        hosts,
        screenshots: options.screenshots ?? screenshots,
      });
      task.update({ confirmIrreversible, confirmTarget });
      return task;
    },
    /** Reads a page with no model call and no input: an open tab by URL part, or a URL in a background tab closed again. */
    async look({ url, tab }: { url?: string; tab?: string }) {
      if (!url && !tab) throw new Error('Pass `url` to open a page or `tab` to read an open one.');
      if (url) refuseOutside(url, hostsFromEnv());
      const { cdp } = await browser();
      const page = url ? await Tab.open(cdp, url) : await Tab.find(cdp, tab!);
      try {
        return await page.observe();
      } finally {
        if (url) await page.close();
      }
    },
    /** Mobile journey mapping; in the user's own Chrome it opens a separate window so screenshots keep rendering. */
    async startJourney(options: JourneyOptions) {
      const decider = ask();
      // The server's host lists hold for journeys too: a start page outside them is never opened, and a step that
      // lands outside them is refused before Jev is asked about the page.
      const hosts = hostsFromEnv();
      refuseOutside(options.startUrl, hosts);
      const { cdp } = await browser();
      return JourneySession.start(cdp, decider, {
        newWindow: source === 'auto',
        ...profileOptions(profile),
        ...options,
        hosts,
        screenshots: options.screenshots ?? screenshots,
      });
    },
    async close() {
      if (chrome) await (await chrome).close();
      chrome = undefined;
    },
  };
};

/** Throws before a page outside the host rules is opened. */
const refuseOutside = (url: string, hosts: HostRules) => {
  const outside = outsideHosts(url, hosts);
  if (outside) throw new Error(`Not opened: ${outside}`);
};

// Optional MCP/CLI arguments arrive as explicit undefined; they must not erase profile settings.
const definedOnly = <T extends object>(options: T) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;
