import { connectChrome, type BrowserSource, type ChromeHandle } from '../browser/chrome.ts';
import { dropStagedDownloads, useDownloads } from '../browser/downloads.ts';
import { Tab, type PageState } from '../browser/tab.ts';
import type { Ask } from '../jev/decide.ts';
import { createAsk, profileOptions, resolveModel } from '../jev/model.ts';
import { replayMode } from '../jev/replay.ts';
import { JourneySession, type JourneyOptions } from '../journeys/journey-session.ts';
import { missingKeyMessage } from '../setup/env-file.ts';
import { hostsFromEnv, narrowHosts, outsideHosts, type HostRules } from './hosts.ts';
import { BrowserTask, type TaskOptions } from './run-task.ts';
import { retryingAsk } from '../jev/retry.ts';
import { desktopNotifier } from '../notify/desktop.ts';
import type { CdpConnection } from '../browser/cdp.ts';

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
  // Downloads are set up once per connection: staged in jevway's own browser, Chrome's own behaviour in the person's.
  const browser = () =>
    (chrome ??= connectChrome(source).then(async (handle) => {
      await useDownloads(handle.cdp, source).catch(() => undefined);
      return handle;
    }));
  let shown: Promise<boolean> | undefined;

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
      const visible = await (shown ??= browserShown(source, cdp));
      const task = new BrowserTask(page, decider, {
        ...profileOptions(profile),
        ...definedOnly(options),
        hosts,
        screenshots: options.screenshots ?? screenshots,
        waitForPersonSeconds: personWaitSeconds(options.waitForPersonSeconds),
        person: { visible, notify: desktopNotifier() },
      });
      task.update({ confirmIrreversible, confirmTarget });
      return task;
    },
    /**
     * Reads a page with no model call and no input: an open tab by URL part, or a URL in a background tab closed again.
     * With `pdf`, the page printed as a PDF comes with it.
     */
    async look({ url, tab, pdf = false }: { url?: string; tab?: string; pdf?: boolean }): Promise<LookedPage> {
      if (!url && !tab) throw new Error('Pass `url` to open a page or `tab` to read an open one.');
      if (url) refuseOutside(url, hostsFromEnv());
      const { cdp } = await browser();
      const page = url ? await Tab.open(cdp, url) : await Tab.find(cdp, tab!);
      try {
        const state = await page.observe();
        return pdf ? { ...state, pdf: await page.pdf() } : state;
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
      // A journey makes one model call per screen and has no loop-level retry, so a busy API gets two more tries.
      return JourneySession.start(cdp, retryingAsk(decider, { delaysMs: JOURNEY_RETRY_MS }), {
        newWindow: source === 'auto',
        ...profileOptions(profile),
        ...options,
        hosts,
        screenshots: options.screenshots ?? screenshots,
      });
    },
    async close() {
      if (chrome) {
        const handle = await chrome;
        await handle.close();
        dropStagedDownloads(handle.cdp);
      }
      chrome = undefined;
      shown = undefined;
    },
  };
};

/** A page as a look read it, with the page as a PDF when the look asked for one. */
export type LookedPage = PageState & { pdf?: Buffer };

/** A connected browser and model client that starts tasks, looks at pages and starts journeys: what a session service drives. */
export type Runner = ReturnType<typeof createRunner>;

// Waits before each retry of a journey's model call after a busy or flaky API answer.
const JOURNEY_RETRY_MS = [1000, 3000];

// Waits for a person at a wall this long, in seconds, when the call names no wait and JEVWAY_PERSON_WAIT_SECONDS is unset.
const PERSON_WAIT_SECONDS = 120;

/**
 * The call's wait for a person, else `JEVWAY_PERSON_WAIT_SECONDS` (whole seconds), else 120. A headless browser waits 0
 * whatever this says (the task knows whether a person can see it).
 *
 * @example
 * personWaitSeconds(undefined, { JEVWAY_PERSON_WAIT_SECONDS: '60' }) // 60
 */
export const personWaitSeconds = (call: number | undefined, env: Record<string, string | undefined> = process.env) => {
  const raw = env.JEVWAY_PERSON_WAIT_SECONDS?.trim();
  return call ?? (raw && /^\d+$/.test(raw) ? Number(raw) : PERSON_WAIT_SECONDS);
};

/** Whether a person can see this browser: never `launch-headless`, nor a headless Chrome behind a port or `auto`. */
const browserShown = async (source: BrowserSource, cdp: CdpConnection) => {
  if (source === 'launch-headless') return false;
  try {
    const { userAgent } = await cdp.send('Browser.getVersion');
    return !/HeadlessChrome/.test(String(userAgent));
  } catch {
    return true;
  }
};

/** Throws before a page outside the host rules is opened. */
const refuseOutside = (url: string, hosts: HostRules) => {
  const outside = outsideHosts(url, hosts);
  if (outside) throw new Error(`Not opened: ${outside}`);
};

// Optional MCP/CLI arguments arrive as explicit undefined; they must not erase profile settings.
const definedOnly = <T extends object>(options: T) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;
