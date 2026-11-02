import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createInbox, InboxError, listMessages, readMessage, waitForMessage } from '../../src/inbox/inbox.ts';
import { createInboxRegistry } from '../../src/inbox/inbox-registry.ts';
import { fakeClock, fakeMail, MAIL_GW, MAIL_TM, verificationEmail } from './fake-mail.ts';

const client = (mail = fakeMail(), clock = fakeClock()) => ({ mail, clock, options: { fetch: mail.fetch, delay: clock.delay, now: clock.now } });

/** Every credential the fake issued must be absent from `text`. */
const expectNoCredentials = (mail: ReturnType<typeof fakeMail>, text: string) => {
  for (const secret of [...mail.passwords(), ...mail.tokens()]) expect(text).not.toContain(secret);
};

describe('createInbox', () => {
  it('makes a test-<hex> address on mail.tm on its first active domain', async () => {
    const { mail, options } = client(
      fakeMail({ domains: { [MAIL_TM]: [{ domain: 'old.example', isActive: false }, { domain: 'tm-domain.example', isActive: true }] } }),
    );
    const inbox = await createInbox(options);
    expect(inbox.address).toMatch(/^test-[0-9a-f]{10}@tm-domain\.example$/);
    expect(inbox.api).toBe(MAIL_TM);
    expect(mail.accounts.get(inbox.address)?.api).toBe(MAIL_TM);
  });

  it('never shows the password when the inbox is serialized or logged', async () => {
    const { mail, options } = client();
    const inbox = await createInbox(options);
    expect(inbox.password).toBe(mail.passwords()[0]);
    expect(JSON.parse(JSON.stringify(inbox))).toEqual({ address: inbox.address, api: MAIL_TM });
    expectNoCredentials(mail, inspect(inbox));
  });

  it('falls back to mail.gw once when mail.tm is down', async () => {
    const { mail, options } = client(fakeMail({ domains: { [MAIL_GW]: [{ domain: 'gw-domain.example', isActive: true }] } }));
    const inbox = await createInbox(options);
    expect(inbox).toMatchObject({ api: MAIL_GW, address: expect.stringMatching(/@gw-domain\.example$/) });
    expect(mail.requests.filter((request) => request.url.startsWith(MAIL_GW) && request.url.endsWith('/domains'))).toHaveLength(1);
  });

  it('falls back when mail.tm offers no active domain, or rejects the account, or answers 5xx', async () => {
    for (const setup of [
      (mail: ReturnType<typeof fakeMail>) => mail.fail(MAIL_TM, '/domains', 503),
      (mail: ReturnType<typeof fakeMail>) => mail.fail(MAIL_TM, '/accounts', 422),
      (mail: ReturnType<typeof fakeMail>) => mail.fail(MAIL_TM, '/accounts', 429),
    ]) {
      const { mail, options } = client();
      setup(mail);
      expect((await createInbox(options)).api).toBe(MAIL_GW);
    }
    const inactive = client(fakeMail({ domains: { [MAIL_TM]: [{ domain: 'x.example', isActive: false }], [MAIL_GW]: [{ domain: 'gw.example', isActive: true }] } }));
    expect((await createInbox(inactive.options)).api).toBe(MAIL_GW);
  });

  it('fails with a hint when both providers fail, without trying a third time', async () => {
    const { mail, options } = client(fakeMail({ domains: {} }));
    const error = await createInbox(options).catch((caught) => caught);
    expect(error).toBeInstanceOf(InboxError);
    expect(error).toMatchObject({ code: 'inbox_unavailable', message: expect.stringMatching(/mail\.tm.*mail\.gw/s), hint: expect.stringMatching(/user/) });
    expect(mail.requests).toHaveLength(2);
  });

  it('uses only the provider asked for: a site that rejected one domain gets the other, once', async () => {
    const { mail, options } = client();
    expect((await createInbox({ ...options, api: MAIL_GW })).api).toBe(MAIL_GW);
    mail.fail(MAIL_GW, '/domains', 503);
    const error = await createInbox({ ...options, api: MAIL_GW }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect(mail.requests.some((request) => request.url.startsWith(MAIL_TM))).toBe(false);
  });
});

describe('waitForMessage', () => {
  it('polls every 3 s until a matching email arrives, then returns its code and links', async () => {
    const { mail, clock, options } = client();
    const inbox = await createInbox(options);
    mail.arrive(inbox.address, verificationEmail({ id: 'other', from: { address: 'news@else.example' }, subject: 'Our news' }), 0);
    mail.arrive(inbox.address, verificationEmail(), 2);
    const polled: number[] = [];
    const message = await waitForMessage(inbox, { ...options, from: 'staylist', timeoutMs: 60_000, onPoll: (elapsedMs) => polled.push(elapsedMs) });
    expect(message).toMatchObject({
      id: 'msg-1',
      from: 'no-reply@staylist.example',
      subject: 'Verify your Staylist account',
      received_at: '2026-11-02T09:05:00+00:00',
      code: '482913',
      links: ['https://staylist.example/verify?token=abc&user=7'],
      text: expect.stringContaining('Your verification code is 482913'),
    });
    expect(clock.sleeps).toEqual([3000, 3000]);
    expect(polled).toEqual([0, 3000, 6000]);
    expect(mail.polls).toBe(3);
  });

  it('returns the newest match', async () => {
    const { mail, options } = client();
    const inbox = await createInbox(options);
    mail.arrive(inbox.address, verificationEmail({ id: 'first', text: 'code 1111' }));
    mail.arrive(inbox.address, verificationEmail({ id: 'resent', text: 'code 2222' }));
    expect(await waitForMessage(inbox, { ...options, timeoutMs: 10_000 })).toMatchObject({ id: 'resent', code: '2222' });
  });

  it('gives up at the timeout with no result, polling once more at the deadline', async () => {
    const { mail, clock, options } = client();
    const inbox = await createInbox(options);
    expect(await waitForMessage(inbox, { ...options, timeoutMs: 7_000 })).toBeUndefined();
    expect(clock.sleeps).toEqual([3000, 3000, 1000]);
    expect(mail.polls).toBe(4);
  });

  it('rides out one failed poll, gets a new token on a 401, and stops after 3 failed polls in a row', async () => {
    const { mail, options } = client();
    const inbox = await createInbox(options);
    mail.fail(MAIL_TM, '/messages', 502, 1);
    mail.fail(MAIL_TM, '/messages', 401, 1);
    mail.arrive(inbox.address, verificationEmail(), 0);
    expect(await waitForMessage(inbox, { ...options, timeoutMs: 60_000 })).toMatchObject({ code: '482913' });

    mail.fail(MAIL_TM, '/messages', 503, 3);
    const error = await waitForMessage(inbox, { ...options, timeoutMs: 60_000 }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'provider_unavailable', hint: expect.any(String) });
    expectNoCredentials(mail, `${error.message} ${error.hint}`);
  });

  it('stops at once when the caller cancels', async () => {
    const { options } = client();
    const inbox = await createInbox(options);
    const controller = new AbortController();
    const waiting = waitForMessage(inbox, { ...options, timeoutMs: 60_000, signal: controller.signal, onPoll: () => controller.abort() });
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('listMessages and readMessage', () => {
  it('list newest first without bodies, and read one in full', async () => {
    const { mail, options } = client();
    const inbox = await createInbox(options);
    mail.arrive(inbox.address, verificationEmail({ id: 'a', subject: 'First' }));
    mail.arrive(inbox.address, verificationEmail({ id: 'b', subject: 'Second' }));
    expect(await listMessages(inbox, options)).toEqual([
      { id: 'b', from: 'no-reply@staylist.example', subject: 'Second', received_at: '2026-11-02T09:05:00+00:00' },
      { id: 'a', from: 'no-reply@staylist.example', subject: 'First', received_at: '2026-11-02T09:05:00+00:00' },
    ]);
    expect(await readMessage(inbox, 'a', options)).toMatchObject({ id: 'a', subject: 'First', code: '482913' });
    await expect(readMessage(inbox, 'missing', options)).rejects.toMatchObject({ code: 'message_not_found' });
  });

  it('keep the password and token out of every error, even when the provider echoes them', async () => {
    const { mail, options } = client();
    const inbox = await createInbox(options);
    const echoing = {
      ...options,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const answer = await mail.fetch(input, init);
        if (!String(input).endsWith('/messages')) return answer;
        return new Response(`bad request for ${inbox.password} with ${init?.headers && new Headers(init.headers).get('authorization')}`, { status: 400 });
      }) as typeof fetch,
    };
    const error = await listMessages(inbox, echoing).catch((caught) => caught);
    expect(error).toBeInstanceOf(InboxError);
    expectNoCredentials(mail, `${error.message} ${error.hint}`);
  });
});

describe('the inbox registry', () => {
  it('names each inbox by a UUID and finds it by that id or its address', async () => {
    const { mail, options } = client();
    const inboxes = createInboxRegistry(options);
    const created = await inboxes.create();
    expect(created).toEqual({ inbox: expect.stringMatching(/^[0-9a-f-]{36}$/), address: expect.stringMatching(/^test-/), provider: 'mail.tm' });
    mail.arrive(created.address, verificationEmail());
    expect(await inboxes.wait(created.inbox, { timeoutMs: 1_000 })).toMatchObject({ code: '482913' });
    expect(await inboxes.list(created.address)).toHaveLength(1);
    expect(await inboxes.read(created.address, 'msg-1')).toMatchObject({ id: 'msg-1' });
  });

  it('an unknown inbox is unknown_inbox, saying inboxes end with the process', async () => {
    const inboxes = createInboxRegistry(client().options);
    await expect(inboxes.wait('nope', { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'unknown_inbox',
      message: expect.stringContaining('"nope"'),
      hint: expect.stringContaining('create'),
    });
  });

  it('starts on mail.gw when asked', async () => {
    const inboxes = createInboxRegistry(client().options);
    expect(await inboxes.create({ provider: 'mail.gw' })).toMatchObject({ provider: 'mail.gw', address: expect.stringMatching(/@gw-domain\.example$/) });
  });
});
