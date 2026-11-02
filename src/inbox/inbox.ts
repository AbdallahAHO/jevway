import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { callApi, cancelled, InboxError, membersOf, type InboxClient } from './mail-api.ts';
import { bodyText, extractCode, extractLinks, matchesFilters, type ProviderMessage } from './message.ts';

export { InboxError, type InboxClient } from './mail-api.ts';

/** The mail.tm-compatible providers, mail.tm first; the tools take a name, never a URL. */
export const PROVIDERS = { 'mail.tm': 'https://api.mail.tm', 'mail.gw': 'https://api.mail.gw' } as const;
export type Provider = keyof typeof PROVIDERS;

/** A receiving address and its credentials. `password` is non-enumerable: `JSON.stringify` and `console.log` skip it. */
export interface Inbox {
  readonly address: string;
  readonly api: string;
  readonly password: string;
}

export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  received_at: string;
}

/** An email read in full: the first code and every link a person could follow, already pulled out. */
export interface ReceivedMessage extends MessageSummary {
  code?: string;
  links: string[];
  text: string;
}

const POLL_INTERVAL_MS = 3_000;
const FAILED_POLLS_LIMIT = 3;

/** An inbox from stored credentials, with the password hidden from serialization. */
export const inboxFrom = ({ address, password, api }: { address: string; password: string; api: string }): Inbox =>
  Object.defineProperty({ address, api }, 'password', { value: password, enumerable: false }) as Inbox;

/** `mail.tm` for its API URL; the URL itself for any other. */
export const providerOf = (api: string) =>
  (Object.keys(PROVIDERS) as Provider[]).find((name) => PROVIDERS[name] === api) ?? api;

const summaryOf = (message: ProviderMessage): MessageSummary => ({
  id: message.id ?? '',
  from: message.from?.address ?? '',
  subject: message.subject ?? '',
  received_at: message.createdAt ?? '',
});

const receivedOf = (message: ProviderMessage): ReceivedMessage => {
  const code = extractCode(message);
  return { ...summaryOf(message), ...(code && { code }), links: extractLinks(message), text: bodyText(message) };
};

const createOn = async (api: string, client: InboxClient) => {
  const domains = membersOf(await callApi<{ domain: string; isActive?: boolean }[]>(client, api, '/domains'));
  const domain = domains.find((entry) => entry.isActive !== false)?.domain;
  if (!domain) throw new InboxError('provider_rejected', `${api} offers no active domain`, 'Try the other provider.');
  const address = `test-${randomBytes(5).toString('hex')}@${domain}`;
  const password = randomBytes(18).toString('base64url');
  await callApi(client, api, '/accounts', { method: 'POST', body: { address, password }, secrets: [password] });
  return inboxFrom({ address, password, api });
};

/**
 * A new inbox on `api`, or on mail.tm and then, if mail.tm is down, offers no active domain or refuses the account,
 * on mail.gw once. Both failing is `inbox_unavailable`.
 *
 * @example
 * const inbox = await createInbox(); // { address: 'test-0a1b2c3d4e@<domain>', api: 'https://api.mail.tm' }
 */
export const createInbox = async ({ api, ...client }: InboxClient & { api?: string } = {}): Promise<Inbox> => {
  if (api) return createOn(api, client);
  try {
    return await createOn(PROVIDERS['mail.tm'], client);
  } catch (first) {
    if (!(first instanceof InboxError)) throw first;
    try {
      return await createOn(PROVIDERS['mail.gw'], client);
    } catch (second) {
      throw new InboxError(
        'inbox_unavailable',
        `No inbox could be made: mail.tm failed (${first.message}), then mail.gw failed (${(second as Error).message}).`,
        'Both disposable inbox providers are down or refusing new accounts. Ask the user for a test mailbox of their own.',
      );
    }
  }
};

const fetchToken = async (inbox: Inbox, client: InboxClient, signal?: AbortSignal) =>
  (
    await callApi<{ token: string }>(client, inbox.api, '/token', {
      method: 'POST',
      body: { address: inbox.address, password: inbox.password },
      secrets: [inbox.password],
      signal,
    })
  ).token;

const listWith = async (inbox: Inbox, client: InboxClient, token: string, signal?: AbortSignal) =>
  membersOf(await callApi<ProviderMessage[]>(client, inbox.api, '/messages', { token, signal, secrets: [inbox.password] }));

const readWith = async (inbox: Inbox, client: InboxClient, token: string, id: string, signal?: AbortSignal) => {
  try {
    return receivedOf(
      await callApi<ProviderMessage>(client, inbox.api, `/messages/${encodeURIComponent(id)}`, { token, signal, secrets: [inbox.password] }),
    );
  } catch (error) {
    if (error instanceof InboxError && error.status === 404) {
      throw new InboxError('message_not_found', `No message "${id}" in ${inbox.address}`, 'List the inbox for its message ids.', 404);
    }
    throw error;
  }
};

/** The inbox's messages, newest first, without their bodies. */
export const listMessages = async (inbox: Inbox, { signal, ...client }: InboxClient & { signal?: AbortSignal } = {}) =>
  (await listWith(inbox, client, await fetchToken(inbox, client, signal), signal)).map(summaryOf);

/** One message in full, with its code and links. */
export const readMessage = async (inbox: Inbox, id: string, { signal, ...client }: InboxClient & { signal?: AbortSignal } = {}) =>
  readWith(inbox, client, await fetchToken(inbox, client, signal), id, signal);

export interface WaitOptions {
  from?: string;
  subject?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called before each poll with the time waited so far. */
  onPoll?: (elapsedMs: number) => void;
}

const defaultDelay = async (ms: number, signal?: AbortSignal) => {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    throw cancelled();
  }
};

/**
 * Polls the inbox now and every 3 s until the newest message matching `from` and `subject` arrives, then reads it
 * in full; undefined once `timeoutMs` has passed (with one last poll at the deadline). A 401 gets a new token; 3
 * failed polls in a row end the wait with the provider's error. Aborting `signal` stops it with `cancelled`.
 *
 * @example
 * await waitForMessage(inbox, { from: 'staylist', timeoutMs: 120_000 }) // { code: '482913', links: [...], … }
 */
export const waitForMessage = async (
  inbox: Inbox,
  { from, subject, timeoutMs, signal, onPoll, ...client }: WaitOptions & InboxClient,
): Promise<ReceivedMessage | undefined> => {
  const now = client.now ?? Date.now;
  const delay = client.delay ?? defaultDelay;
  const started = now();
  let token = await fetchToken(inbox, client, signal);
  let failures = 0;
  for (;;) {
    if (signal?.aborted) throw cancelled();
    onPoll?.(now() - started);
    try {
      const match = (await listWith(inbox, client, token, signal)).find((message) => matchesFilters(message, { from, subject }));
      if (match?.id) return await readWith(inbox, client, token, match.id, signal);
      failures = 0;
    } catch (error) {
      if (!(error instanceof InboxError) || error.code === 'cancelled' || error.code === 'message_not_found') throw error;
      if (++failures >= FAILED_POLLS_LIMIT) throw error;
      if (error.status === 401) {
        token = await fetchToken(inbox, client, signal);
        continue;
      }
    }
    const remaining = started + timeoutMs - now();
    if (remaining <= 0) return undefined;
    await delay(Math.min(POLL_INTERVAL_MS, remaining), signal);
  }
};
