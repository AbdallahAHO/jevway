import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { connectChrome } from '../src/browser/chrome.ts';
import { createRunner } from '../src/task/start-task.ts';

// MCP clients start servers before people add a key. With none, the server must still list its tools and answer each
// call with the fix, without starting or attaching a browser. Only stdio and the browser connection are faked.
const fakes = vi.hoisted(() => ({ clientEnd: undefined as Transport | undefined }));

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

vi.mock('../src/browser/chrome.ts', () => ({
  connectChrome: vi.fn(async () => {
    throw new Error('no browser in this test');
  }),
}));

const client = new Client({ name: 'test', version: '0.0.0' });
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

beforeAll(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('JEVWAY_MODEL', '');
  vi.stubEnv('JEVWAY_SCREENSHOTS', '');
  vi.stubEnv('JEVWAY_BROWSER', 'launch-headless');
  // An empty config folder, so a real ~/.config/jevway/env on this machine is never read.
  vi.stubEnv('XDG_CONFIG_HOME', mkdtempSync(join(tmpdir(), 'jevway-cfg-')));
  await import('../src/mcp.ts');
  await client.connect(fakes.clientEnd!);
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
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'jevway_end',
      'jevway_journey_annotate',
      'jevway_journey_autopilot',
      'jevway_journey_finish',
      'jevway_journey_start',
      'jevway_journey_step',
      'jevway_look',
      'jevway_task',
    ]);
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
