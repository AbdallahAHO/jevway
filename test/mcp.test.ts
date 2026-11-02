import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The MCP server runs as written; only its stdio and its browser runner are swapped for in-memory fakes, so listing
// tools and running a task start no browser and need no real key. The server's own serveStdio call only hands over its
// factory; each client below gets its own connection from the real serveStdio, which picks the protocol era.
const fakes = vi.hoisted(() => ({
  factory: undefined as McpServerFactory | undefined,
  /** What each run of the fake task saw: its signal, and when it started and ended. */
  runs: [] as { signal?: AbortSignal; events: string[] }[],
  events: [] as string[],
}));

vi.mock('@modelcontextprotocol/server/stdio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/server/stdio')>()),
  serveStdio: (factory: McpServerFactory) => {
    fakes.factory = factory;
    return { close: async () => undefined };
  },
}));

vi.mock('../src/task/start-task.ts', () => ({
  createRunner: () => ({
    close: async () => undefined,
    requireKey: () => undefined,
    start: async () => ({
      tab: { close: async () => undefined },
      update: () => undefined,
      // A run that lasts until its signal aborts (then 100 ms more, like an input in flight), or 50 ms without one.
      run: async ({ signal }: { signal?: AbortSignal } = {}) => {
        const index = fakes.runs.push({ signal, events: [] }) - 1;
        fakes.events.push(`start ${index}`);
        await new Promise((resolve) => {
          if (index !== 1) return setTimeout(resolve, 50);
          signal?.addEventListener('abort', () => setTimeout(resolve, 100), { once: true });
        });
        fakes.events.push(`end ${index}`);
        return { status: signal?.aborted ? 'blocked' : 'done', reason: signal?.aborted ? 'Cancelled by the caller' : 'ok' };
      },
    }),
  }),
}));

/** A client on its own stdio-like connection to the server; `pin` speaks 2026-07-28, the default a 2025 `initialize`. */
const connect = async (versionNegotiation?: NonNullable<ConstructorParameters<typeof Client>[1]>['versionNegotiation']) => {
  const { serveStdio } = await vi.importActual<typeof import('@modelcontextprotocol/server/stdio')>('@modelcontextprotocol/server/stdio');
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  serveStdio(fakes.factory!, { transport: serverEnd, onerror: (error) => console.error(error) });
  const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation });
  await client.connect(clientEnd);
  return client;
};

let client: Client;

beforeAll(async () => {
  await import('../src/mcp.ts');
  client = await connect();
});

const expectedHints = {
  jevway_task: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  jevway_end: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  jevway_look: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  jevway_journey_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  jevway_journey_step: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  jevway_journey_autopilot: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  jevway_journey_annotate: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  jevway_journey_finish: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
/** Each tool's inputs: every field it accepts, required ones marked with `!`. */
const expectedInputs = {
  jevway_task: 'goal! url tab values secret_keys files done_when checks session confirm_irreversible confirm_target max_steps max_seconds allowed_hosts blocked_hosts allow_coordinate_clicks record_dir',
  jevway_end: 'session! keep_tab',
  jevway_look: 'session tab url',
  jevway_journey_start: 'url! device intent values stay_within out_dir',
  jevway_journey_step: 'journey! next! value flow description insight',
  jevway_journey_autopilot: 'journey! screens flow intent',
  jevway_journey_annotate: 'journey! screen! description insight relabel',
  jevway_journey_finish: 'journey! keep_tab',
};
type ListedTool = { name: string; annotations?: object; inputSchema: { properties?: object; required?: string[] } };
const expectSameTools = (tools: ListedTool[]) => {
  expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual(
    Object.fromEntries(Object.entries(expectedHints).map(([name, hints]) => [name, expect.objectContaining(hints)])),
  );
  const inputsOf = ({ inputSchema }: ListedTool) =>
    Object.keys(inputSchema.properties ?? {})
      .map((key) => (inputSchema.required?.includes(key) ? `${key}!` : key))
      .join(' ');
  expect(Object.fromEntries(tools.map((tool) => [tool.name, inputsOf(tool)]))).toEqual(expectedInputs);
};

describe('tools/list', () => {
  it("tells a client which tools can change a site and which only touch jevway's own state, and what each accepts", async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expectSameTools((await client.listTools()).tools);
  });
});

describe('jevway_task over MCP', () => {
  const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
    client.callTool({ name: 'jevway_task', arguments: { goal: 'Open', ...args } }, signal && { signal });

  it("passes the request's signal to the run, aborts it when the client cancels, and runs the session's next call only after the cancelled one ends", async () => {
    const first: any = await call({ url: 'http://fixture/' });
    const { session } = JSON.parse(first.content[0].text);
    expect(fakes.runs[0].signal).toBeInstanceOf(AbortSignal);

    const controller = new AbortController();
    const cancelled = call({ session }, controller.signal).catch((error: Error) => error);
    await vi.waitFor(() => expect(fakes.runs).toHaveLength(2));
    controller.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(fakes.runs[1].signal?.aborted).toBe(true));

    const next: any = await call({ session });
    expect(JSON.parse(next.content[0].text)).toMatchObject({ session, status: 'done' });
    expect(fakes.events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });
});

describe('a 2026-07-28 client (no initialize, the protocol version on every request)', () => {
  it('connects, lists the same 8 tools with the same hints and inputs, and runs a task', async () => {
    const modern = await connect({ mode: { pin: '2026-07-28' } });
    expect(modern.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(modern.getServerVersion()).toMatchObject({ name: 'jevway' });

    expectSameTools((await modern.listTools()).tools);

    const result: any = await modern.callTool({ name: 'jevway_task', arguments: { goal: 'Open', url: 'http://fixture/' } });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'done', session: expect.any(String) });
    await modern.close();
  });
});
