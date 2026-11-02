import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { TaskStatus } from '../../src/task/run-task.ts';
import { page } from '../fakes.ts';
import { connect, END_PAGE, fakeService, runTo, summaryFor } from './connect.ts';

// What an agent reads back from each tool: one JSON result (text and structuredContent alike) that leads with how the
// call ended, links to the files it left, the end page inline when the agent must decide, and progress as it runs.

const STATUSES: TaskStatus[] = ['done', 'needs_input', 'needs_confirmation', 'uncertain', 'blocked', 'step_budget'];
const HAND_BACKS: TaskStatus[] = ['needs_input', 'needs_confirmation', 'uncertain', 'blocked'];
const UNKNOWN = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** A connected client whose tool list is loaded, so the client checks every result against its output schema. */
const setUp = async (env: Record<string, string> = {}) => {
  const fake = fakeService();
  const client = await connect({ ...fake, env });
  await client.listTools();
  const task = async (args: Record<string, unknown>, options?: Parameters<Client['callTool']>[1]) =>
    (await client.callTool(
      { name: 'jevway_task', arguments: { goal: 'Find stays in Lisbon', ...args } },
      options,
    )) as any;
  return { ...fake, client, task };
};

const textOf = (result: any) => result.content.find((block: any) => block.type === 'text').text as string;
const imagesOf = (result: any) => result.content.filter((block: any) => block.type === 'image');
const linksOf = (result: any) => result.content.filter((block: any) => block.type === 'resource_link');

describe('jevway_task results', () => {
  it.each(STATUSES)(
    'a %s result is one JSON object in both the text block and structuredContent, leading with status, reason, story and next',
    async (status) => {
      const { task, runs } = await setUp();
      runs.push(runTo(summaryFor(status)));
      const result = await task({ url: 'http://fixture/stays' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      const out = result.structuredContent;
      expect(Object.keys(out).slice(0, 5)).toEqual(['status', 'reason', 'story', 'next', 'session']);
      expect(Object.keys(out).at(-1)).toBe('page_text');
      expect(out).toMatchObject({
        status,
        story: ['Typed the "city" value into "Where are you going?".', 'Clicked "Search".'],
        next: expect.any(String),
        files: {
          run_dir: expect.stringContaining('.jevway/runs/'),
          manifest: expect.stringMatching(/manifest\.json$/),
        },
      });
      expect(out).not.toHaveProperty('steps');
      expect(out).not.toHaveProperty('jev');
    },
  );

  it.each(STATUSES)(
    'a %s result with detail "full" adds the raw steps, Jev stats and the stuck candidates',
    async (status) => {
      const { task, runs } = await setUp();
      runs.push(runTo(summaryFor(status)));
      const result = await task({ url: 'http://fixture/stays', detail: 'full' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        status,
        steps: [{ confidence: 0.97 }, { confidence: 0.95 }],
        jev: { requests: 3 },
      });
      if (status !== 'done' && status !== 'step_budget') expect(result.structuredContent.stuck).toBeDefined();
    },
  );

  it('carries what each hand-back needs: missing fields, the wall, the checks and evidence', async () => {
    const { task, runs } = await setUp();
    runs.push(runTo(summaryFor('needs_input')), runTo(summaryFor('blocked')), runTo(summaryFor('done')));
    expect((await task({ url: 'http://fixture/stays' })).structuredContent.missing).toEqual([
      { label: 'Email', role: 'textbox', path: '/search' },
    ]);
    expect((await task({ url: 'http://fixture/stays' })).structuredContent.wall).toEqual({
      kind: 'sign_in',
      origin: 'https://stays.example',
    });
    const done = (await task({ url: 'http://fixture/stays' })).structuredContent;
    expect(done.evidence).toMatchObject({ quote: 'Stays in Lisbon' });
    expect(done.checks).toEqual([expect.objectContaining({ type: 'url_contains', pass: true })]);
  });

  it('links the end page, summary and manifest as file:// resources in the run folder', async () => {
    const { task } = await setUp();
    const result = await task({ url: 'http://fixture/stays' });
    const runDir = result.structuredContent.files.run_dir;
    expect(linksOf(result)).toEqual([
      expect.objectContaining({
        uri: pathToFileURL(join(runDir, 'final.jpg')).href,
        name: 'final.jpg',
        mimeType: 'image/jpeg',
      }),
      expect.objectContaining({
        uri: pathToFileURL(join(runDir, 'summary.json')).href,
        name: 'summary.json',
        mimeType: 'application/json',
      }),
      expect.objectContaining({
        uri: pathToFileURL(join(runDir, 'manifest.json')).href,
        name: 'manifest.json',
        mimeType: 'application/json',
      }),
    ]);
    for (const link of linksOf(result)) expect(link.description).toEqual(expect.any(String));
  });

  it('with record, keeps the recording in the run folder and links its page and video too', async () => {
    const { task, started } = await setUp();
    const result = await task({ url: 'http://fixture/stays', record: true });
    expect(started[0].output).toMatchObject({ record: true, dir: result.structuredContent.files.run_dir });
    expect(linksOf(result).map((link: any) => link.name)).toEqual([
      'final.jpg',
      'index.html',
      'run.mp4',
      'summary.json',
      'manifest.json',
    ]);
    expect(linksOf(result).find((link: any) => link.name === 'run.mp4').mimeType).toBe('video/mp4');
  });

  it('record_dir puts the whole run folder there, with the recording on', async () => {
    const { task, started, outDir } = await setUp();
    const recordDir = join(outDir, '..', 'my-record');
    const result = await task({ url: 'http://fixture/stays', record_dir: recordDir });
    expect(started[0].output).toEqual({ dir: recordDir, record: true });
    expect(result.structuredContent.files.run_dir).toBe(recordDir);
  });
});

describe('the end page inline (JEVWAY_IMAGE_RESPONSES)', () => {
  const imageCase = async (env: Record<string, string>, status: TaskStatus, args: Record<string, unknown> = {}) => {
    const { task, runs } = await setUp(env);
    runs.push(runTo(summaryFor(status)));
    return imagesOf(await task({ url: 'http://fixture/stays', ...args }));
  };

  it.each(HAND_BACKS)(
    'auto (the default) attaches it on a %s hand-back, where the agent decides next',
    async (status) => {
      expect(await imageCase({}, status)).toEqual([
        { type: 'image', data: END_PAGE.toString('base64'), mimeType: 'image/jpeg' },
      ]);
    },
  );

  it.each(['done', 'step_budget'] as TaskStatus[])(
    'auto leaves it out on %s unless the call asks with screenshot: true',
    async (status) => {
      expect(await imageCase({}, status)).toEqual([]);
      expect(await imageCase({}, status, { screenshot: true })).toHaveLength(1);
    },
  );

  it('always attaches it on every status', async () => {
    expect(await imageCase({ JEVWAY_IMAGE_RESPONSES: 'always' }, 'done')).toHaveLength(1);
  });

  it('never leaves it out, even on a hand-back with screenshot: true; the link stays', async () => {
    const { task, runs } = await setUp({ JEVWAY_IMAGE_RESPONSES: 'never' });
    runs.push(runTo(summaryFor('needs_confirmation')));
    const result = await task({ url: 'http://fixture/stays', screenshot: true });
    expect(imagesOf(result)).toEqual([]);
    expect(linksOf(result)[0].name).toBe('final.jpg');
  });

  it('a failed capture leaves both the image and its link out', async () => {
    const { task, runs, state } = await setUp();
    runs.push(runTo(summaryFor('needs_input')));
    state.noScreenshot = true;
    const result = await task({ url: 'http://fixture/stays' });
    expect(imagesOf(result)).toEqual([]);
    expect(linksOf(result).map((link: any) => link.name)).toEqual(['summary.json', 'manifest.json']);
  });
});

describe('progress while a call runs', () => {
  it('sends one notification per step, in order, with the step as a sentence and max_steps as the total, before the result', async () => {
    const { task } = await setUp();
    const heard: { progress: number; total?: number; message?: string }[] = [];
    const result = await task(
      { url: 'http://fixture/stays', max_steps: 5 },
      { onprogress: (progress) => heard.push(progress) },
    );
    expect(result.isError).toBeFalsy();
    expect(heard).toEqual([
      { progress: 1, total: 5, message: 'Step 1: Typed the "city" value into "Where are you going?".' },
      { progress: 2, total: 5, message: 'Step 2: Clicked "Search".' },
    ]);
  });

  it('leaves the total out when the call names no max_steps', async () => {
    const { task } = await setUp();
    const heard: { total?: number }[] = [];
    await task({ url: 'http://fixture/stays' }, { onprogress: (progress) => heard.push(progress) });
    expect(heard).toHaveLength(2);
    expect(heard.every((progress) => progress.total === undefined)).toBe(true);
  });
});

describe('continuing and ending a session', () => {
  it('continues with session and the new values, and ends it with its run folder named', async () => {
    const { task, client, runs, updates } = await setUp();
    runs.push(runTo(summaryFor('needs_input')));
    const first = (await task({ url: 'http://fixture/stays' })).structuredContent;
    const next = (await task({ session: first.session, values: { email: 'ada@example.com' } })).structuredContent;
    expect(next).toMatchObject({ session: first.session, status: 'done' });
    expect(updates.at(-1)).toMatchObject({ values: { email: 'ada@example.com' } });
    await task({ session: first.session, totp: { otp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' } });
    expect(updates.at(-1)).toMatchObject({ totp: { otp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' } });

    const ended: any = await client.callTool({ name: 'jevway_end', arguments: { session: first.session } });
    expect(ended.structuredContent).toEqual({ session: first.session, ended: true, run_dir: first.files.run_dir });
    expect(ended.content[0].text).toMatch(/ended/);
  });

  it("passes the request's signal to the run and runs the session's next call only after the cancelled one ends", async () => {
    const { task, runs } = await setUp();
    const events: string[] = [];
    const first = (await task({ url: 'http://fixture/stays' })).structuredContent;
    let signal: AbortSignal | undefined;
    runs.push(async (context) => {
      signal = context.signal;
      events.push('start cancelled');
      await new Promise((resolve) =>
        context.signal?.addEventListener('abort', () => setTimeout(resolve, 100), { once: true }),
      );
      events.push('end cancelled');
      return { ...summaryFor('blocked'), reason: 'Cancelled by the caller' };
    });
    runs.push(async (context) => {
      events.push('start next');
      return runTo(summaryFor('done'))(context);
    });
    const controller = new AbortController();
    const cancelled = task({ session: first.session }, { signal: controller.signal }).catch((error: Error) => error);
    await vi.waitFor(() => expect(events).toEqual(['start cancelled']));
    controller.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    const next = await task({ session: first.session });
    expect(next.structuredContent).toMatchObject({ session: first.session, status: 'done' });
    expect(events).toEqual(['start cancelled', 'end cancelled', 'start next']);
  });
});

describe('errors that say what to do', () => {
  it.each([
    ['jevway_task', { goal: 'Open', session: UNKNOWN }],
    ['jevway_look', { session: UNKNOWN }],
    ['jevway_end', { session: UNKNOWN }],
  ])('%s on an unknown session says why it is gone and to start again with url', async (name, args) => {
    const { client } = await setUp();
    const result: any = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      `Unknown session "${UNKNOWN}". Sessions end when the server restarts; start a new one with \`url\` (or \`tab\`).`,
    );
  });

  it('an unknown journey says to start a new one', async () => {
    const { client } = await setUp();
    const result: any = await client.callTool({
      name: 'jevway_journey_step',
      arguments: { journey: UNKNOWN, next: 1 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`Unknown journey "${UNKNOWN}"`);
  });

  it('a task with no url, tab or session names the three and shows a call, before any browser work', async () => {
    const { task, runner } = await setUp();
    const result = await task({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/`url`.*`tab`.*`session`/s);
    expect(textOf(result)).toContain('{"goal":');
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('a bad authenticator secret names its key, never the secret, before any browser work', async () => {
    const { task, runner } = await setUp();
    const result = await task({ url: 'http://fixture/stays', totp: { otp: 'JBSW1Y3DP-PRIVATEPART' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/totp\.otp: /);
    expect(textOf(result)).not.toContain('PRIVATEPART');
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('a bad check names its place and field and shows a valid check', async () => {
    const { task, runner } = await setUp();
    const result = await task({ url: 'http://fixture/stays', checks: [{ type: 'url_contains' }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/checks\[0\]\.text/);
    expect(textOf(result)).toContain('{"type":"url_contains","text":');
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('a missing goal or a non-text value names the field with an example', async () => {
    const { client } = await setUp();
    const noGoal: any = await client.callTool({ name: 'jevway_task', arguments: { url: 'http://fixture/' } });
    expect(noGoal.isError).toBe(true);
    expect(textOf(noGoal)).toMatch(/goal.*e\.g\./s);
    const badValues: any = await client.callTool({
      name: 'jevway_task',
      arguments: { goal: 'Open', url: 'http://fixture/', values: { guests: 2 } },
    });
    expect(badValues.isError).toBe(true);
    expect(textOf(badValues)).toMatch(/values.*\{"city":"Lisbon"\}/s);
  });
});

describe('jevway_look', () => {
  it('returns the page as JSON in text and structuredContent, with no model call', async () => {
    const { client } = await setUp();
    const result: any = await client.callTool({ name: 'jevway_look', arguments: { url: 'http://fixture/stays' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      url: 'http://fixture/stays',
      title: 'Staylist',
      page_text: 'Looked at',
      elements: expect.any(Array),
    });
  });

  it('saves a PDF of the page with `pdf` and returns its path', async () => {
    const { client, runner } = await setUp();
    runner.look.mockImplementationOnce(async ({ url }: { url?: string }) => ({ ...page({ url: url!, text: 'Looked at' }), pdf: Buffer.from('%PDF-1.4') }));
    const result: any = await client.callTool({ name: 'jevway_look', arguments: { url: 'http://fixture/stays', pdf: true } });
    expect(result.isError).toBeFalsy();
    expect(runner.look).toHaveBeenLastCalledWith({ url: 'http://fixture/stays', tab: undefined, pdf: true });
    expect(result.structuredContent.pdf).toMatch(/[/\\]looks[/\\].+[/\\]page\.pdf$/);
  });

  it('asks for exactly one of session, tab or url, with an example', async () => {
    const { client } = await setUp();
    const result: any = await client.callTool({ name: 'jevway_look', arguments: { url: 'http://a/', tab: 'b' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/exactly one of `session`, `tab` or `url`.*\{"url":/s);
  });
});

describe('journey replies', () => {
  it('start, step and autopilot carry the report and the screen image; finish links the viewer, the map and the manifest', async () => {
    const { client } = await setUp({ JEVWAY_IMAGE_RESPONSES: 'never' });
    const started: any = await client.callTool({ name: 'jevway_journey_start', arguments: { url: 'http://fixture/' } });
    expect(started.isError).toBeFalsy();
    expect(started.content[1]).toEqual({ type: 'image', data: END_PAGE.toString('base64'), mimeType: 'image/jpeg' });
    const { journey } = JSON.parse(started.content[0].text);
    expect(started.structuredContent).toMatchObject({ journey, screen: { id: 's01' } });

    const stepped: any = await client.callTool({ name: 'jevway_journey_step', arguments: { journey, next: 1 } });
    expect(stepped.content[1].type).toBe('image');
    const annotated: any = await client.callTool({
      name: 'jevway_journey_annotate',
      arguments: { journey, screen: 's02', description: 'Results' },
    });
    expect(annotated.isError).toBeFalsy();

    const finished: any = await client.callTool({ name: 'jevway_journey_finish', arguments: { journey } });
    expect(finished.structuredContent).toMatchObject({
      screens: 3,
      viewer: expect.stringMatching(/index\.html$/),
      flows: [{ name: 'Explore' }],
    });
    expect(linksOf(finished).map((link: any) => link.name)).toEqual(['index.html', 'journey.json', 'manifest.json']);
  });
});
