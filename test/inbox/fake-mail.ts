// A mail.tm-compatible provider as a `fetch`: domains, accounts, tokens and messages per API base, with failures and
// arrivals scripted per test. No network.

export const MAIL_TM = 'https://api.mail.tm';
export const MAIL_GW = 'https://api.mail.gw';

export interface FakeMessage {
  id: string;
  from: { name?: string; address: string };
  subject: string;
  text?: string;
  html?: string[];
  createdAt: string;
}

interface Account {
  address: string;
  password: string;
  api: string;
  messages: FakeMessage[];
}

/** A verification email as a site sends one. */
export const verificationEmail = (overrides: Partial<FakeMessage> = {}): FakeMessage => ({
  id: 'msg-1',
  from: { name: 'Staylist', address: 'no-reply@staylist.example' },
  subject: 'Verify your Staylist account',
  text: 'Welcome to Staylist!\n\nYour verification code is 482913. It expires in 10 minutes.\n\nOr confirm here: https://staylist.example/verify?token=abc&amp;user=7\n',
  html: [
    '<html><head><style>p{color:red}</style></head><body><img src="https://staylist.example/logo.png"><p>Your verification code is <b>482913</b>.</p><a href="https://staylist.example/verify?token=abc&amp;user=7">Confirm</a><a href="http://www.w3.org/1999/xhtml">ns</a></body></html>',
  ],
  createdAt: '2026-11-02T09:05:00+00:00',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/ld+json' } });

/**
 * A fake provider. `domains[api]` lists what `/domains` offers (absent: the API is unreachable); `fail(api, path,
 * status, times)` answers that path with `status`; `arrive(address, message, afterPolls)` puts a message in the inbox
 * once `/messages` has been polled that many times.
 */
export const fakeMail = ({
  domains = { [MAIL_TM]: [{ domain: 'tm-domain.example', isActive: true }], [MAIL_GW]: [{ domain: 'gw-domain.example', isActive: true }] },
}: { domains?: Record<string, { domain: string; isActive: boolean }[]> } = {}) => {
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, string>();
  const failures: { api: string; path: string; status: number; times: number }[] = [];
  const arrivals: { address: string; message: FakeMessage; afterPolls: number }[] = [];
  const requests: { method: string; url: string; body?: string; authorization?: string }[] = [];
  let polls = 0;
  let issued = 0;

  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const api = url.origin;
    const path = url.pathname;
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    requests.push({ method, url: url.href, body, authorization: headers.get('authorization') ?? undefined });
    init.signal?.throwIfAborted();
    if (!domains[api]) throw new TypeError('fetch failed');
    const failure = failures.find((entry) => entry.api === api && path.startsWith(entry.path) && entry.times > 0);
    if (failure) {
      failure.times--;
      return json(failure.status, { 'hydra:description': `scripted ${failure.status}` });
    }

    if (method === 'GET' && path === '/domains') return json(200, { 'hydra:member': domains[api] });
    if (method === 'POST' && path === '/accounts') {
      const { address, password } = JSON.parse(body!);
      const domain = address.split('@')[1];
      if (!domains[api].some((entry) => entry.domain === domain && entry.isActive)) {
        return json(422, { 'hydra:description': `address: This value is not valid. (${address})` });
      }
      accounts.set(address, { address, password, api, messages: [] });
      return json(201, { id: `acc-${accounts.size}`, address });
    }
    if (method === 'POST' && path === '/token') {
      const { address, password } = JSON.parse(body!);
      const account = accounts.get(address);
      if (!account || account.password !== password || account.api !== api) return json(401, { message: 'Invalid credentials.' });
      const token = `tok-${++issued}`;
      tokens.set(token, address);
      return json(200, { token, id: 'acc' });
    }
    const owner = tokens.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    const account = owner ? accounts.get(owner) : undefined;
    if (!account) return json(401, { message: 'JWT Token not found' });
    if (method === 'GET' && path === '/messages') {
      polls++;
      for (const arrival of arrivals.filter((entry) => entry.address === account.address && entry.afterPolls < polls)) {
        account.messages.unshift(arrival.message);
        arrivals.splice(arrivals.indexOf(arrival), 1);
      }
      return json(200, {
        'hydra:member': account.messages.map(({ id, from, subject, createdAt }) => ({ id, from, subject, intro: '', createdAt })),
      });
    }
    const id = /^\/messages\/(.+)$/.exec(path)?.[1];
    const message = account.messages.find((entry) => entry.id === id);
    if (method === 'GET' && message) return json(200, message);
    return json(404, { 'hydra:description': 'Not Found' });
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    accounts,
    get polls() {
      return polls;
    },
    fail: (api: string, path: string, status: number, times = 1) => failures.push({ api, path, status, times }),
    arrive: (address: string, message: FakeMessage, afterPolls = 0) => arrivals.push({ address, message, afterPolls }),
    /** Every byte the fake answered or was sent, for "never leaks" checks. */
    passwords: () => [...accounts.values()].map((account) => account.password),
    tokens: () => [...tokens.keys()],
  };
};

/** A clock the client sleeps on: `delay` advances it instead of waiting. */
export const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    delay: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
};
