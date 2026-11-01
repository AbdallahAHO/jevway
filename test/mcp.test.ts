import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The MCP server runs as written; only its stdio transport and its browser runner are swapped for in-memory fakes,
// so listing tools and running a task start no browser and need no real key.
const fakes = vi.hoisted(() => ({
  clientEnd: undefined as Transport | undefined,
  /** What each run of the fake task saw: its signal, and when it started and ended. */
  runs: [] as { signal?: AbortSignal; events: string[] }[],
  events: [] as string[],
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  fakes.clientEnd = clientEnd;
  return {
    StdioServerTransport: function StdioServerTransport() {
      return serverEnd;
    },
  };
});

vi.mock('../src/task/start-task.ts', () => ({
  createRunner: () => ({
    close: async () => undefined,
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

const client = new Client({ name: 'test', version: '0.0.0' });

beforeAll(async () => {
  await import('../src/mcp.ts');
  await client.connect(fakes.clientEnd!);
});

describe('tools/list', () => {
  it("tells a client which tools can change a site and which only touch jevway's own state", async () => {
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(hints).toEqual({
      jevway_task: expect.objectContaining({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
      jevway_end: expect.objectContaining({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
      jevway_look: expect.objectContaining({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }),
      journey_start: expect.objectContaining({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
      journey_step: expect.objectContaining({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
      journey_autopilot: expect.objectContaining({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
      journey_annotate: expect.objectContaining({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
      journey_finish: expect.objectContaining({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    });
  });
});

describe('jevway_task over MCP', () => {
  const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
    client.callTool({ name: 'jevway_task', arguments: { goal: 'Open', ...args } }, undefined, signal && { signal });

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
