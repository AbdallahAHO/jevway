import type { Tab } from '../browser/tab.ts';

export interface Diagnostics {
  consoleErrors: string[];
  failedRequests: { url: string; status?: number; error?: string }[];
}

const MAX_ENTRIES = 20;
const clip = (text: string, length = 300) => (text.length > length ? `${text.slice(0, length)}…` : text);

/**
 * Collects console errors, uncaught exceptions and failed requests for a tab, and tracks in-flight
 * requests so a screenshot waits for the screen to finish loading.
 *
 * @example
 * const diagnostics = await watchDiagnostics(tab);
 * await tab.act(action, page);
 * await diagnostics.waitForIdle();
 * const { consoleErrors, failedRequests } = diagnostics.drain(); // errors since the last drain
 */
export const watchDiagnostics = async (tab: Tab) => {
  let current: Diagnostics = { consoleErrors: [], failedRequests: [] };
  const urls = new Map<string, string>();
  const inflight = new Set<string>();
  let lastActivity = Date.now();

  const addError = (text: string) => {
    if (current.consoleErrors.length < MAX_ENTRIES) current.consoleErrors.push(clip(text));
  };
  const addFailure = (failure: Diagnostics['failedRequests'][number]) => {
    // Ad blockers and cancelled navigations are the viewer's environment, not the site's bugs.
    const environmental = failure.error === 'net::ERR_BLOCKED_BY_CLIENT' || failure.error === 'net::ERR_ABORTED';
    if (environmental || failure.url.startsWith('data:') || current.failedRequests.length >= MAX_ENTRIES) return;
    if (current.failedRequests.some((existing) => existing.url === clip(failure.url, 200))) return;
    current.failedRequests.push({ ...failure, url: clip(failure.url, 200) });
  };

  const unsubscribe = tab.onEvent((method, params) => {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        if (params.type === 'error') addError(params.args.map((arg: any) => arg.value ?? arg.description).join(' '));
        break;
      case 'Runtime.exceptionThrown':
        addError(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
        break;
      case 'Network.requestWillBeSent':
        urls.set(params.requestId, params.request.url);
        inflight.add(params.requestId);
        lastActivity = Date.now();
        break;
      case 'Network.responseReceived':
        if (params.response.status >= 400) addFailure({ url: params.response.url, status: params.response.status });
        break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        inflight.delete(params.requestId);
        lastActivity = Date.now();
        if (method === 'Network.loadingFailed' && !params.canceled) {
          addFailure({ url: urls.get(params.requestId) ?? '', error: params.errorText });
        }
        break;
    }
  });
  await Promise.all([tab.send('Runtime.enable'), tab.send('Network.enable')]);

  return {
    /** Returns everything collected since the previous drain. */
    drain(): Diagnostics {
      const collected = current;
      current = { consoleErrors: [], failedRequests: [] };
      return collected;
    },
    /** Waits until the network is quiet, then for visible images to decode. Never waits longer than maxMs. */
    async waitForIdle({ quietMs = 400, maxMs = 4000 } = {}) {
      const deadline = Date.now() + maxMs;
      // Long-polling and analytics beacons can keep a request open forever; quiet time still counts past 2 in flight.
      while (Date.now() < deadline && (inflight.size > 2 || Date.now() - lastActivity < quietMs)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await tab
        .evaluate(
          `Promise.race([
            Promise.all([...document.images]
              .filter(i => !i.complete && i.getBoundingClientRect().top < innerHeight)
              .map(i => new Promise(r => { i.onload = i.onerror = r; }))),
            new Promise(r => setTimeout(r, ${Math.max(0, Math.min(1500, deadline - Date.now()))}))
          ]).then(() => true)`,
        )
        .catch(() => undefined);
    },
    stop: unsubscribe,
  };
};

export type DiagnosticsWatcher = Awaited<ReturnType<typeof watchDiagnostics>>;
