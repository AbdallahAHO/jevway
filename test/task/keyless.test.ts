import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { connectChrome } from '../../src/browser/chrome.ts';
import { createRunner } from '../../src/task/start-task.ts';

// MCP clients start servers before people add a key. With none, the server must still list its tools and answer each
// call with the fix, without starting or attaching a browser. Only stdio and the browser connection are faked here;
// the last block runs the real server process.
const fakes = vi.hoisted(() => ({ factory: undefined as McpServerFactory | undefined }));

vi.mock('@modelcontextprotocol/server/stdio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/server/stdio')>()),
  serveStdio: (factory: McpServerFactory) => {
    fakes.factory = factory;
    return { close: async () => undefined };
  },
}));

vi.mock('../../src/browser/chrome.ts', () => ({
  connectChrome: vi.fn(async () => {
    throw new Error('no browser in this test');
  }),
}));

const client = new Client({ name: 'test', version: '0.0.0' });
const toolNames = [
  'jevway_end',
  'jevway_journey_annotate',
  'jevway_journey_autopilot',
  'jevway_journey_finish',
  'jevway_journey_start',
  'jevway_journey_step',
  'jevway_look',
  'jevway_task',
];
const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

beforeAll(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('JEVWAY_MODEL', '');
  vi.stubEnv('JEVWAY_SCREENSHOTS', '');
  vi.stubEnv('JEVWAY_BROWSER', 'launch-headless');
  // An empty config folder, so a real ~/.config/jevway/env on this machine is never read.
  vi.stubEnv('XDG_CONFIG_HOME', mkdtempSync(join(tmpdir(), 'jevway-cfg-')));
  await import('../../src/mcp.ts');
  const { serveStdio } = await vi.importActual<typeof import('@modelcontextprotocol/server/stdio')>('@modelcontextprotocol/server/stdio');
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  serveStdio(fakes.factory!, { transport: serverEnd });
  await client.connect(clientEnd);
});

describe('without an API key', () => {
  it('a runner still starts, and a task names both keys and the doctor before any browser connects', async () => {
    const runner = createRunner('launch-headless');
    await expect(runner.start({ url: 'http://fixture/', goal: 'Open' })).rejects.toThrow(
      /TYPESAFE_API_KEY.*OPENROUTER_API_KEY.*jevway\/env.*jevway doctor/s,
    );
    expect(connectChrome).not.toHaveBeenCalled();
  });

  it('looking at a page needs no key: it calls no model', async () => {
    await expect(createRunner('launch-headless').look({ url: 'http://fixture/' })).rejects.toThrow('no browser in this test');
  });

  it('a model that runs through OpenRouter names OPENROUTER_API_KEY only', async () => {
    const runner = createRunner('launch-headless', { model: 'clef' });
    const failure = runner.start({ url: 'http://fixture/', goal: 'Open' });
    await expect(failure).rejects.toThrow(/OPENROUTER_API_KEY/);
    await expect(failure).rejects.not.toThrow(/TYPESAFE_API_KEY/);
  });

  it('requireKey() lets the CLI report the missing key as a usage error before any browser starts', () => {
    expect(() => createRunner('launch-headless').requireKey()).toThrow(/TYPESAFE_API_KEY/);
  });

  it('the MCP server starts, lists every jevway tool, and reports its package version', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(toolNames);
    expect(client.getServerVersion()).toMatchObject({ name: 'jevway', version: packageVersion });
  });

  it('jevway_task and jevway_journey_start answer with the fix instead of crashing', async () => {
    vi.mocked(connectChrome).mockClear();
    const task: any = await client.callTool({ name: 'jevway_task', arguments: { goal: 'Open', url: 'http://fixture/' } });
    expect(task.isError).toBe(true);
    expect(task.content[0].text).toMatch(/TYPESAFE_API_KEY.*jevway doctor/s);

    const journey: any = await client.callTool({ name: 'jevway_journey_start', arguments: { url: 'http://fixture/' } });
    expect(journey.isError).toBe(true);
    expect(journey.content[0].text).toMatch(/TYPESAFE_API_KEY/);
    expect(connectChrome).not.toHaveBeenCalled();
  });
});

describe('the real jevway-mcp process, without a key', () => {
  const serverPath = new URL('../../src/mcp.ts', import.meta.url).pathname;
  const keylessEnv = () => ({
    ...(process.env as Record<string, string>),
    TYPESAFE_API_KEY: '',
    OPENROUTER_API_KEY: '',
    JEVWAY_MODEL: '',
    JEVWAY_SCREENSHOTS: '',
    JEVWAY_BROWSER: 'launch-headless',
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'jevway-cfg-')),
  });

  it('serves a client that opens with initialize at 2025-06-18 (Codex, Cursor, OpenCode, older Claude Code)', async () => {
    const server = spawn(process.execPath, [serverPath], { env: keylessEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const replies = new Map<number, (message: any) => void>();
    createInterface({ input: server.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    });
    const send = (message: object) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const request = (id: number, method: string, params: object) => {
      const reply = new Promise<any>((resolve) => replies.set(id, resolve));
      send({ id, method, params });
      return reply;
    };
    try {
      const initialized = await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-2025-06-18', version: '0.0.0' },
      });
      expect(initialized.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'jevway' } });
      send({ method: 'notifications/initialized' });

      const listed = await request(2, 'tools/list', {});
      expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(toolNames);

      const called = await request(3, 'tools/call', { name: 'jevway_task', arguments: { goal: 'Open', url: 'http://fixture/' } });
      expect(called.result.isError).toBe(true);
      expect(called.result.content[0].text).toMatch(/TYPESAFE_API_KEY.*jevway doctor/s);
    } finally {
      server.kill();
    }
  }, 15_000);

  it('serves a 2026-07-28 client: it discovers the server instead of initializing, then lists and calls tools', async () => {
    const modern = new Client({ name: 'modern', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await modern.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: keylessEnv(), stderr: 'ignore' }));
    try {
      expect(modern.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await modern.listTools()).tools.map((tool) => tool.name).sort()).toEqual(toolNames);
      const called: any = await modern.callTool({ name: 'jevway_task', arguments: { goal: 'Open', url: 'http://fixture/' } });
      expect(called.isError).toBe(true);
      expect(called.content[0].text).toMatch(/TYPESAFE_API_KEY/);
    } finally {
      await modern.close();
    }
    // `auto` spawns a short-lived probe process before the real one.
  }, 15_000);
});
