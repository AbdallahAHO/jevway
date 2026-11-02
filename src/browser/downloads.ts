import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { CdpConnection } from './cdp.ts';
import type { BrowserSource } from './chrome.ts';

// jevway: downloads are browser-wide in Chrome (`Browser.setDownloadBehavior` is per browser context, and every session
// shares one), so a session's run folder can't be the download path. jevway's own browser downloads into a staging
// folder; the person's own Chrome keeps saving where it always does. Either way the browser reports each download, and
// the tab that started it claims it.

/** One download a tab started, as the browser reports it. */
export interface Download {
  guid: string;
  /** The name the site suggested; not yet made safe. */
  name: string;
  url: string;
  state: 'inProgress' | 'completed' | 'canceled';
  /** Bytes received so far. */
  bytes: number;
  /** Where Chrome saved it, once completed. */
  filePath?: string;
  /** Saved in jevway's own staging folder (a launched browser), so it may be moved rather than copied. */
  staged: boolean;
}

const STAGING = new WeakMap<CdpConnection, string>();

/**
 * Sets how the browser behind `cdp` downloads, once per connection: jevway's launched browser saves every download under
 * its guid in a staging folder of its own; the person's Chrome (`auto`, a debugging URL) keeps its own behaviour and only
 * reports downloads. A browser that refuses never fails a run: its downloads go unreported.
 *
 * @example
 * await useDownloads(cdp, 'launch-headless'); // Browser.setDownloadBehavior { behavior: 'allowAndName', downloadPath: '/tmp/jevway-downloads-…' }
 */
export const useDownloads = async (cdp: CdpConnection, source: BrowserSource) => {
  if (source !== 'launch' && source !== 'launch-headless') {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true }).catch(() => undefined);
    return;
  }
  const downloadPath = mkdtempSync(join(tmpdir(), 'jevway-downloads-'));
  STAGING.set(cdp, downloadPath);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true }).catch(() => undefined);
};

/** Removes the staging folder of a launched browser's connection, with whatever was never kept. */
export const dropStagedDownloads = (cdp: CdpConnection) => {
  const dir = STAGING.get(cdp);
  if (dir) rmSync(dir, { recursive: true, force: true });
  STAGING.delete(cdp);
};

const inside = (dir: string | undefined, path: string | undefined) => {
  if (!dir || !path) return false;
  const rel = relative(dir, path);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * The downloads one tab started: `owns` says whether a frame id is the tab's (its page, one of its frames, a tab it
 * opened). Every other download, in the person's other tabs too, is never recorded.
 *
 * @example
 * const downloads = new TabDownloads(cdp, (frameId) => frameId === targetId);
 * const finished = await downloads.settle({ waitMs: 30_000 });
 */
export class TabDownloads {
  #cdp: CdpConnection;
  #owns: (frameId: string) => boolean;
  #all = new Map<string, Download>();
  #untaken: string[] = [];
  #changed = new Set<() => void>();

  constructor(cdp: CdpConnection, owns: (frameId: string) => boolean) {
    this.#cdp = cdp;
    this.#owns = owns;
  }

  /** Starts listening; returns the unsubscribe. */
  watch() {
    return this.#cdp.onEvent((method, params, sessionId) => {
      if (sessionId || !method.startsWith('Browser.download')) return;
      if (method === 'Browser.downloadWillBegin' && this.#owns(params.frameId)) {
        this.#all.set(params.guid, { guid: params.guid, name: params.suggestedFilename, url: params.url, state: 'inProgress', bytes: 0, staged: false });
        this.#untaken.push(params.guid);
      }
      const known = method === 'Browser.downloadProgress' && this.#all.get(params.guid);
      if (!known) return;
      const filePath = params.filePath ?? known.filePath;
      this.#all.set(params.guid, {
        ...known,
        state: params.state,
        bytes: params.receivedBytes ?? known.bytes,
        ...(filePath && { filePath }),
        staged: inside(STAGING.get(this.#cdp), filePath),
      });
      for (const changed of this.#changed) changed();
    });
  }

  /**
   * Takes the downloads begun since the last take, after waiting up to `waitMs` (or until `signal`) for those still
   * running. Each comes back as it stands then: completed, canceled, or still in progress.
   */
  async settle({ waitMs, signal }: { waitMs: number; signal?: AbortSignal }): Promise<Download[]> {
    const taken = this.#untaken.splice(0);
    const running = () => taken.some((guid) => this.#all.get(guid)?.state === 'inProgress');
    if (taken.length && running() && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          this.#changed.delete(check);
          resolve();
        };
        const check = () => {
          if (!running()) done();
        };
        const timer = setTimeout(done, waitMs);
        signal?.addEventListener('abort', done, { once: true });
        this.#changed.add(check);
      });
    }
    return taken.map((guid) => ({ ...this.#all.get(guid)! }));
  }
}
