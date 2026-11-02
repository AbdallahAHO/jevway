import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it } from 'vitest';
import { createInboxRegistry } from '../../src/inbox/inbox-registry.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { fakeClock, fakeMail, verificationEmail } from '../inbox/fake-mail.ts';
import { fakeService } from './connect.ts';

// The two inbox tools as an agent sees them: listed under `all` and `inbox`, the address back from create, and from
// wait the code and links of the email that arrived (or a timeout), with progress while it waits and never a password.

const setUp = async (env: Record<string, string> = {}) => {
  const mail = fakeMail();
  const clock = fakeClock();
  const inboxes = createInboxRegistry({ fetch: mail.fetch, delay: clock.delay, now: clock.now });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  serveStdio(createMcpServer({ service: fakeService().service, version: '9.9.9', env, inboxes }), { transport: serverEnd });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientEnd);
  await client.listTools();
  const call = async (name: string, args: Record<string, unknown> = {}, options?: Parameters<Client['callTool']>[1]) =>
    (await client.callTool({ name, arguments: args }, options)) as any;
  return { mail, clock, client, call };
};

const textOf = (result: any) => result.content[0].text as string;

describe('jevway_inbox_create and jevway_inbox_wait', () => {
  it('are listed last under JEVWAY_TOOLS=all, alone under inbox, and not under task or journeys', async () => {
    const names = async (tools?: string) =>
      (await (await setUp(tools ? { JEVWAY_TOOLS: tools } : {})).client.listTools()).tools.map((tool) => tool.name);
    expect((await names()).slice(-2)).toEqual(['jevway_inbox_create', 'jevway_inbox_wait']);
    expect(await names('inbox')).toEqual(['jevway_inbox_create', 'jevway_inbox_wait']);
    expect(await names('task')).toEqual(['jevway_task', 'jevway_look', 'jevway_end']);
    expect((await names('journeys')).some((name) => name.startsWith('jevway_inbox'))).toBe(false);
  });

  it('are annotated honestly: both reach the open world, create changes nothing that matters, wait only reads', async () => {
    const { tools } = await (await setUp()).client.listTools();
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(hints.jevway_inbox_create).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(hints.jevway_inbox_wait).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });

  it('state the test-and-demo-only rule once in the tools and once in the instructions', async () => {
    const { client } = await setUp();
    const { tools } = await client.listTools();
    const rule = /never to get around limits, trials or bans/;
    expect(tools.filter((tool) => rule.test(tool.description ?? ''))).toHaveLength(1);
    expect(client.getInstructions()).toMatch(rule);
    const inboxOnly = (await setUp({ JEVWAY_TOOLS: 'inbox' })).client.getInstructions()!;
    expect(inboxOnly).toMatch(rule);
    expect(inboxOnly).not.toContain('jevway_task');
  });

  it('create returns the inbox id and address, never the password', async () => {
    const { call, mail } = await setUp();
    const result = await call('jevway_inbox_create');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ inbox: expect.any(String), address: expect.stringMatching(/^test-[0-9a-f]{10}@/), provider: 'mail.tm' });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    expect(result.structuredContent.next).toMatch(/values/);
    for (const password of mail.passwords()) expect(JSON.stringify(result)).not.toContain(password);
  });

  it('wait returns the code and links, telling the agent to pass the code with secret_keys or open the link with jevway_task', async () => {
    const { call, mail } = await setUp();
    const { inbox, address } = (await call('jevway_inbox_create')).structuredContent;
    mail.arrive(address, verificationEmail(), 1);
    const heard: { progress: number; total?: number; message?: string }[] = [];
    const result = await call('jevway_inbox_wait', { inbox, from: 'staylist', timeout_seconds: 30 }, { onprogress: (progress) => heard.push(progress) });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'received',
      inbox,
      address,
      from: 'no-reply@staylist.example',
      subject: 'Verify your Staylist account',
      received_at: '2026-11-02T09:05:00+00:00',
      code: '482913',
      links: ['https://staylist.example/verify?token=abc&user=7'],
      text_excerpt: expect.stringContaining('Your verification code is 482913'),
    });
    const { next } = result.structuredContent;
    expect(next).toContain('secret_keys');
    expect(next).toContain('"482913"');
    expect(next).toContain('jevway_task');
    expect(heard).toEqual([
      { progress: 0, total: 30, message: `Waiting for an email to ${address}: 0 of 30 s` },
      { progress: 3, total: 30, message: `Waiting for an email to ${address}: 3 of 30 s` },
    ]);
    for (const secret of [...mail.passwords(), ...mail.tokens()]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('a timeout is a result saying what to check, not an error', async () => {
    const { call } = await setUp();
    const { inbox, address } = (await call('jevway_inbox_create')).structuredContent;
    const result = await call('jevway_inbox_wait', { inbox, timeout_seconds: 5 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'timeout', inbox, address, links: [], next: expect.stringMatching(/5 s.*jevway_look/s) });
  });

  it('accepts the address in place of the id, and an unknown inbox is an error naming what to do', async () => {
    const { call, mail } = await setUp();
    const { address } = (await call('jevway_inbox_create')).structuredContent;
    mail.arrive(address, verificationEmail());
    expect((await call('jevway_inbox_wait', { inbox: address })).structuredContent).toMatchObject({ status: 'received' });
    const unknown = await call('jevway_inbox_wait', { inbox: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/^jevway_inbox_wait failed: .*jevway_inbox_create/s);
  });

  it('create with provider mail.gw starts there; both providers down is an error with a hint', async () => {
    const { call } = await setUp();
    expect((await call('jevway_inbox_create', { provider: 'mail.gw' })).structuredContent).toMatchObject({ provider: 'mail.gw' });

    const down = fakeMail({ domains: {} });
    const inboxes = createInboxRegistry({ fetch: down.fetch });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    serveStdio(createMcpServer({ service: fakeService().service, version: '9.9.9', env: {}, inboxes }), { transport: serverEnd });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientEnd);
    const result = (await client.callTool({ name: 'jevway_inbox_create', arguments: {} })) as any;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/mail\.tm.*mail\.gw/s);
  });
});
