import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, fakeService } from './connect.ts';

// What a client sees before it calls anything: the tools in a fixed order, their hints and inputs, the server's
// instructions on both protocol eras, and a tool list small enough to load on every turn.

const TASK_TOOLS = ['jevway_task', 'jevway_look', 'jevway_end'];
const JOURNEY_TOOLS = [
  'jevway_journey_start',
  'jevway_journey_step',
  'jevway_journey_autopilot',
  'jevway_journey_annotate',
  'jevway_journey_finish',
];

const expectedHints = {
  jevway_task: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  jevway_look: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  jevway_end: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  jevway_journey_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  jevway_journey_step: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  jevway_journey_autopilot: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  jevway_journey_annotate: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  jevway_journey_finish: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
/** Each tool's inputs, sorted: every field it accepts, required ones marked with `!`. Every earlier input is still here. */
const expectedInputs = {
  jevway_task:
    'allow_coordinate_clicks allowed_hosts blocked_hosts checks confirm_irreversible confirm_target detail done_when files goal! max_seconds max_steps record record_dir screenshot secret_keys session tab url values',
  jevway_look: 'session tab url',
  jevway_end: 'keep_tab session!',
  jevway_journey_start: 'device intent out_dir stay_within url! values',
  jevway_journey_step: 'description flow insight journey! next! value',
  jevway_journey_autopilot: 'flow intent journey! screens',
  jevway_journey_annotate: 'description insight journey! relabel screen!',
  jevway_journey_finish: 'journey! keep_tab',
};

type ListedTool = {
  name: string;
  description?: string;
  annotations?: object;
  inputSchema: { properties?: object; required?: string[] };
  outputSchema?: object;
};

const inputsOf = ({ inputSchema }: ListedTool) =>
  Object.keys(inputSchema.properties ?? {})
    .map((key) => (inputSchema.required?.includes(key) ? `${key}!` : key))
    .sort()
    .join(' ');

/** Every object schema inside `schema`, so a test can see none of them refuses extra keys. */
const objectSchemas = (schema: unknown): Record<string, unknown>[] => {
  if (!schema || typeof schema !== 'object') return [];
  const own = (schema as { type?: string }).type === 'object' ? [schema as Record<string, unknown>] : [];
  return [...own, ...Object.values(schema).flatMap(objectSchemas)];
};

/** What a client pays to load the tool list, as tokens ≈ characters / 4 of what tools/list sends. */
const tokensOf = (value: unknown) => Math.round(JSON.stringify(value).length / 4);
// Measured 2,490 with output schemas (4,515 before plan 116, without them).
const TOOL_LIST_TOKEN_CEILING = 2_500;

afterEach(() => vi.restoreAllMocks());

describe('tools/list', () => {
  it("lists every tool in one fixed order, with hints telling which can change a site and which only touch jevway's own state", async () => {
    const client = await connect(fakeService());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TASK_TOOLS, ...JOURNEY_TOOLS]);
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual(
      Object.fromEntries(Object.entries(expectedHints).map(([name, hints]) => [name, expect.objectContaining(hints)])),
    );
  });

  it('accepts every earlier input, plus record, detail and screenshot on jevway_task', async () => {
    const client = await connect(fakeService());
    const { tools } = await client.listTools();
    expect(Object.fromEntries(tools.map((tool) => [tool.name, inputsOf(tool as ListedTool)]))).toEqual(expectedInputs);
    const task = tools.find((tool) => tool.name === 'jevway_task')!;
    expect((task.inputSchema.properties as any).detail).toMatchObject({ enum: ['concise', 'full'] });
  });

  it('declares what jevway_task, jevway_look and jevway_end return, and no schema refuses a field a later version adds', async () => {
    const client = await connect(fakeService());
    const { tools } = await client.listTools();
    for (const name of TASK_TOOLS) {
      const schema = tools.find((tool) => tool.name === name)!.outputSchema;
      expect(schema, name).toMatchObject({ type: 'object' });
    }
    const task = tools.find((tool) => tool.name === 'jevway_task')!.outputSchema as any;
    expect(task.required).toEqual(expect.arrayContaining(['status', 'reason', 'story', 'next', 'session']));
    for (const tool of tools) {
      for (const schema of objectSchemas(tool.outputSchema))
        expect(schema.additionalProperties, tool.name).not.toBe(false);
    }
  });

  it(`stays under ${TOOL_LIST_TOKEN_CEILING} tokens for all 8 tools, output schemas included, and no description passes 4,096 characters`, async () => {
    const client = await connect(fakeService());
    const { tools } = await client.listTools();
    expect(tokensOf(tools)).toBeLessThanOrEqual(TOOL_LIST_TOKEN_CEILING);
    for (const tool of tools) expect(tool.description?.length ?? 0, tool.name).toBeLessThan(4096);
  });
});

describe('JEVWAY_TOOLS', () => {
  it('task serves jevway_task, jevway_look and jevway_end only', async () => {
    const client = await connect({ ...fakeService(), env: { JEVWAY_TOOLS: 'task' } });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TASK_TOOLS);
  });

  it('journeys serves the five journey tools only', async () => {
    const client = await connect({ ...fakeService(), env: { JEVWAY_TOOLS: 'journeys' } });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(JOURNEY_TOOLS);
  });

  it('an unknown value serves every tool and says so on stderr', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = await connect({ ...fakeService(), env: { JEVWAY_TOOLS: 'everything' } });
    expect((await client.listTools()).tools).toHaveLength(8);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/JEVWAY_TOOLS.*everything.*all \| task \| journeys/));
  });
});

describe('server instructions', () => {
  it('reach a 2025 client through initialize and a 2026-07-28 client through discover, the same text', async () => {
    const legacy = await connect(fakeService());
    const modern = await connect({ ...fakeService(), versionNegotiation: { mode: { pin: '2026-07-28' } } });
    expect(modern.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(legacy.getInstructions()).toBeTruthy();
    expect(modern.getInstructions()).toBe(legacy.getInstructions());
  });

  it('say what jevway is for first, then the session pattern, consent, files and the no-model look, in at most 1,500 characters', async () => {
    const instructions = (await connect(fakeService())).getInstructions()!;
    expect(instructions.length).toBeLessThanOrEqual(1500);
    expect(instructions.slice(0, 200)).toMatch(/browser goal/i);
    for (const words of [
      'jevway_task',
      'chrome-devtools',
      '`session`',
      'confirm_irreversible',
      './.jevway/',
      'jevway_look',
      'untrusted',
      'jevway_journey_',
    ]) {
      expect(instructions, words).toContain(words);
    }
  });

  it('name only the tools the server serves', async () => {
    const task = (await connect({ ...fakeService(), env: { JEVWAY_TOOLS: 'task' } })).getInstructions()!;
    expect(task).not.toContain('jevway_journey_');
    const journeys = (await connect({ ...fakeService(), env: { JEVWAY_TOOLS: 'journeys' } })).getInstructions()!;
    expect(journeys).toContain('jevway_journey_start');
    expect(journeys).not.toContain('jevway_task');
  });
});

describe('a 2026-07-28 client (no initialize, the protocol version on every request)', () => {
  it('lists the same tools with the same hints and inputs, and runs a task', async () => {
    const modern = await connect({ ...fakeService(), versionNegotiation: { mode: { pin: '2026-07-28' } } });
    expect(modern.getServerVersion()).toMatchObject({ name: 'jevway', version: '9.9.9' });
    const { tools } = await modern.listTools();
    expect(Object.fromEntries(tools.map((tool) => [tool.name, inputsOf(tool as ListedTool)]))).toEqual(expectedInputs);
    const result: any = await modern.callTool({
      name: 'jevway_task',
      arguments: { goal: 'Open', url: 'http://fixture/' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'done', session: expect.any(String) });
  });
});
