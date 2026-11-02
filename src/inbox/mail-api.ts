/**
 * A failed inbox call, with what to do in `hint`. Codes: `provider_unavailable` (network, 5xx, 429),
 * `provider_rejected` (another 4xx), `inbox_unavailable` (both providers failed), `unknown_inbox`,
 * `message_not_found`, `cancelled`.
 */
export class InboxError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly status?: number;
  constructor(code: string, message: string, hint: string, status?: number) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

/** What the client needs from outside: `fetch`, and a clock for polling (both swapped in tests). */
export interface InboxClient {
  fetch?: typeof globalThis.fetch;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const RETRY_HINT = 'The provider is busy or down; try again in a minute, or ask the user for a test mailbox of their own.';

const scrub = (text: string, secrets: string[]) =>
  secrets.filter(Boolean).reduce((clean, secret) => clean.split(secret).join('[secret]'), text);

export const cancelled = () => new InboxError('cancelled', 'Stopped waiting: cancelled by the caller.', 'Wait again when you need the email.');

/**
 * One call to a mail.tm-compatible API, JSON in and out. Failures are `InboxError`s whose text never holds `secrets`
 * (the password and token), even when the provider echoes them.
 */
export const callApi = async <T>(
  client: InboxClient,
  api: string,
  path: string,
  { method = 'GET', body, token, signal, secrets = [] }: { method?: string; body?: object; token?: string; signal?: AbortSignal; secrets?: string[] } = {},
): Promise<T> => {
  const fetch = client.fetch ?? globalThis.fetch;
  const where = `${method} ${api}${path}`;
  let response: Response;
  try {
    response = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/ld+json',
        ...(body && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body && JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw new InboxError('provider_unavailable', `${where} failed: ${scrub((error as Error).message, [...secrets, token ?? ''])}`, RETRY_HINT);
  }
  if (response.ok) return (await response.json()) as T;
  const detail = scrub((await response.text().catch(() => '')).slice(0, 300), [...secrets, token ?? '']);
  const transient = response.status >= 500 || response.status === 429;
  throw new InboxError(
    transient ? 'provider_unavailable' : 'provider_rejected',
    `${where} → ${response.status} ${detail}`.trim(),
    transient ? RETRY_HINT : 'The provider refused the request; the message says why.',
    response.status,
  );
};

/** A collection as `{ 'hydra:member': [...] }` (ld+json) or a bare array (plain JSON). */
export const membersOf = <T>(collection: T[] | { 'hydra:member'?: T[] }) =>
  Array.isArray(collection) ? collection : (collection['hydra:member'] ?? []);
