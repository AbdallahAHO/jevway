import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choice, Image, noul, TypeSafeClient, type SystemOneRequest } from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ask } from '../src/jev/decide.ts';
import { createAsk, createLiveAsk, resolveModel } from '../src/jev/model.ts';
import { createRunner } from '../src/task/start-task.ts';
import { recordingAsk, ReplayMiss, replayingAsk, requestKey } from '../src/jev/replay.ts';

const JEV = 'jev-1.14.0';
const DIRECT = { profile: 'jev', model: JEV, route: 'direct' } as const;
const PIXELS = 'iVBORw0KGgo=';
const OTHER_PIXELS = 'R0lGODlhAQABAAAAACw=';

const freshDir = () => mkdtempSync(join(tmpdir(), 'jevway-replay-'));

// A decision request as buildRequest shapes it: a page on a local fixture port, a goal, a screenshot.
const decisionRequest = ({
  port = 51234,
  text = 'Search stays\nLisbon',
  steps = 0,
  screenshot = Image.fromBase64(PIXELS) as unknown,
  goal = 'Find stays in Lisbon',
} = {}): SystemOneRequest =>
  ({
    state: {
      page: { url: `http://127.0.0.1:${port}/stays.html`, title: 'Staylist', text },
      elements: [{ index: '1', label: 'Search', operations: ['CLICK'] }],
      supplied_values: { destination: 'Lisbon' },
      recent_actions: Array.from({ length: steps }, () => ({ operation: 'CLICK', element: 'Search' })),
      screenshot,
      screenshot_note: 'The image is the current viewport.',
    },
    questions: {
      operation: choice({ goal, rules: 'Pick one.' }, { CLICK: 'Click.', DONE: 'Done.', BLOCKED: 'Blocked.' }),
      done_check: noul({ completion_condition: 'Results are listed.', rules: 'Judge it.' }),
    },
  }) as unknown as SystemOneRequest;

const response = (choiceId: string, tokens = 120) => ({
  answers: { operation: { type: 'choice', choice: choiceId, confidence: 0.9, probabilities: { [choiceId]: 0.9 } } },
  usage: { input_tokens: tokens },
});

// Answers in turn, recording every request it was asked.
const scripted = (...answers: ReturnType<typeof response>[]) => {
  const asked: SystemOneRequest[] = [];
  const ask: Ask = async (request) => {
    asked.push(request);
    return answers[Math.min(asked.length - 1, answers.length - 1)];
  };
  return { ask, asked };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the replay key', () => {
  it('ignores key order, the fixture port and the screenshot', () => {
    const key = requestKey(JEV, decisionRequest());
    const reordered = decisionRequest() as any;
    const flipped = { questions: reordered.questions, state: Object.fromEntries(Object.entries(reordered.state).reverse()) };
    expect(requestKey(JEV, flipped)).toBe(key);
    expect(requestKey(JEV, decisionRequest({ port: 63088 }))).toBe(key);
    expect(requestKey(JEV, decisionRequest({ screenshot: Image.fromBase64(OTHER_PIXELS) }))).toBe(key);
  });

  it('ignores the pixels of an OpenRouter image part and a second fixture origin reached as localhost', () => {
    const withPart = (pixels: string, port: number) =>
      ({
        state: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${pixels}` } }, { page: { url: `http://localhost:${port}/form.html`, text: 'Sign up' } }],
        questions: {},
      }) as unknown as SystemOneRequest;
    expect(requestKey(JEV, withPart(PIXELS, 4100))).toBe(requestKey(JEV, withPart(OTHER_PIXELS, 4200)));
  });

  it('changes with what the page says, the step and the model', () => {
    const key = requestKey(JEV, decisionRequest());
    expect(requestKey(JEV, decisionRequest({ text: 'Search stays\nPorto' }))).not.toBe(key);
    expect(requestKey(JEV, decisionRequest({ steps: 1 }))).not.toBe(key);
    expect(requestKey('typesafe/jev-1.14', decisionRequest())).not.toBe(key);
  });
});

describe('recording and replaying', () => {
  it('replays the recorded answer for each request, from a fresh process reading the folder', async () => {
    const dir = freshDir();
    const live = scripted(response('CLICK', 100), response('DONE', 200));
    const record = recordingAsk(live.ask, DIRECT, dir);
    const first = await record(decisionRequest());
    const second = await record(decisionRequest({ steps: 1, text: 'Results\nCasa Flora' }));

    const replay = replayingAsk(JEV, dir);
    // Another port and another screenshot: the same run on a fresh fixture server.
    expect(await replay(decisionRequest({ port: 60001, screenshot: Image.fromBase64(OTHER_PIXELS) }))).toEqual(first);
    expect(await replay(decisionRequest({ steps: 1, text: 'Results\nCasa Flora' }))).toEqual(second);
    expect(live.asked).toHaveLength(2);
  });

  it('writes one JSONL file per recording: a header with the route, then the request, answer and model', async () => {
    const dir = freshDir();
    await recordingAsk(scripted(response('CLICK')).ask, { ...DIRECT, screenshots: 'always' }, dir)(decisionRequest());
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.jsonl$/);
    const [header, entry] = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(header).toEqual({ header: { profile: 'jev', model: JEV, route: 'direct', screenshots: 'always' } });
    expect(entry).toMatchObject({ key: requestKey(JEV, decisionRequest()), model: JEV, answer: response('CLICK') });
    expect(entry.request.state.page.url).toBe('http://127.0.0.1:<port>/stays.html');
    expect(entry.request.state.screenshot).toBe('<image>');
  });

  it('replays a request asked twice with its answers in order, then repeats the last', async () => {
    const dir = freshDir();
    const record = recordingAsk(scripted(response('CLICK'), response('DONE')).ask, DIRECT, dir);
    await record(decisionRequest());
    await record(decisionRequest());
    const replay = replayingAsk(JEV, dir);
    const chosen = async () => (await replay(decisionRequest())).answers.operation.choice;
    expect([await chosen(), await chosen(), await chosen()]).toEqual(['CLICK', 'DONE', 'DONE']);
  });

  it('refuses a folder with nothing recorded', () => {
    expect(() => replayingAsk(JEV, freshDir())).toThrow(/No recorded Jev answers/);
  });
});

describe('a request never recorded', () => {
  it('throws a miss naming the goal, the step and the kind, with what changed against the nearest recording', async () => {
    const dir = freshDir();
    const record = recordingAsk(scripted(response('CLICK')).ask, DIRECT, dir);
    await record(decisionRequest({ steps: 2, text: 'Results\nCasa Flora\nCasa Azul' }));
    await record(decisionRequest({ goal: 'Another goal entirely', steps: 2, text: 'Nothing alike\nat all' }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const miss = await replayingAsk(JEV, dir)(decisionRequest({ steps: 2, text: 'Results\nCasa Flora\nCasa Verde' })).catch((error) => error);
    expect(miss).toBeInstanceOf(ReplayMiss);
    expect(miss.message).toContain('Find stays in Lisbon');
    expect(miss.message).toContain('step 3');
    expect(miss.message).toContain('decision');
    expect(miss.message).toContain('state.page.text');
    // Page lines stay out of the message: the run retries a model error whose message reads like a timeout.
    const pageDiff = miss.pageDiff.join('\n');
    expect(pageDiff).toMatch(/only recorded:[\s\S]*Casa Azul/);
    expect(pageDiff).toMatch(/only now:[\s\S]*Casa Verde/);
    expect(miss.message).not.toContain('Casa Verde');
    expect(`${miss.message}${pageDiff}`).not.toContain('Nothing alike');
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^replay miss: .*Find stays in Lisbon.*step 3/));
  });

  it('says when nothing was recorded for that model', async () => {
    const dir = freshDir();
    await recordingAsk(scripted(response('CLICK')).ask, DIRECT, dir)(decisionRequest());
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(replayingAsk('cloudflare/clef', dir)(decisionRequest())).rejects.toThrow(/nothing was recorded for cloudflare\/clef/);
  });
});

describe('JEVWAY_REPLAY picks the Ask', () => {
  const recordThroughCreateAsk = async (dir: string) => {
    vi.stubEnv('JEVWAY_REPLAY', 'record');
    vi.stubEnv('JEVWAY_REPLAY_DIR', dir);
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const live = vi.spyOn(TypeSafeClient.prototype, 'systemOne').mockResolvedValue(response('CLICK') as any);
    const { profile } = resolveModel({ model: 'jev' });
    const answer = await createAsk(profile)(decisionRequest());
    expect(live).toHaveBeenCalledTimes(1);
    live.mockClear();
    return { answer, live };
  };

  it('unset: the live Ask, which needs its key', () => {
    vi.stubEnv('JEVWAY_REPLAY', '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => createAsk(resolveModel({ model: 'jev' }).profile)).toThrow(/Set OPENROUTER_API_KEY/);
  });

  it('record: calls the live Ask and writes what it answered', async () => {
    const dir = freshDir();
    const { answer } = await recordThroughCreateAsk(dir);
    expect(answer).toEqual(response('CLICK'));
    expect(readdirSync(dir).filter((file) => file.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('replay: answers from the folder with no key set, and never calls the live Ask', async () => {
    const dir = freshDir();
    const { answer, live } = await recordThroughCreateAsk(dir);
    vi.stubEnv('JEVWAY_REPLAY', 'replay');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    // The recorded route wins: Jev's direct route, as recorded, though no key is set.
    const { profile } = resolveModel();
    expect(profile).toMatchObject({ name: 'jev', model: JEV, imageTransport: 'assets', box: true });
    expect(await createAsk(profile)(decisionRequest({ port: 60002 }))).toEqual(answer);
    expect(live).not.toHaveBeenCalled();
  });

  it('any other value is an error', () => {
    vi.stubEnv('JEVWAY_REPLAY', 'playback');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    expect(() => createAsk(resolveModel({ model: 'jev' }).profile)).toThrow(/JEVWAY_REPLAY must be record or replay/);
  });

  it('needs JEVWAY_REPLAY_DIR, so a run never writes recordings into a folder it guessed', () => {
    vi.stubEnv('JEVWAY_REPLAY', 'record');
    vi.stubEnv('JEVWAY_REPLAY_DIR', '');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    expect(() => createAsk(resolveModel({ model: 'jev' }).profile)).toThrow(/JEVWAY_REPLAY needs JEVWAY_REPLAY_DIR/);
  });
});

describe('replay and the other callers', () => {
  it('a runner in replay mode needs no key', async () => {
    const dir = freshDir();
    await recordingAsk(scripted(response('CLICK')).ask, DIRECT, dir)(decisionRequest());
    vi.stubEnv('JEVWAY_REPLAY', 'replay');
    vi.stubEnv('JEVWAY_REPLAY_DIR', dir);
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => createRunner('launch-headless').requireKey()).not.toThrow();
  });

  it('the doctor stays live under JEVWAY_REPLAY=replay: its own route from its keys, and a real request', async () => {
    vi.stubEnv('JEVWAY_REPLAY', 'replay');
    vi.stubEnv('JEVWAY_REPLAY_DIR', freshDir());
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const live = vi.spyOn(TypeSafeClient.prototype, 'systemOne').mockResolvedValue(response('CLICK') as any);
    // An empty replay folder would make a replaying resolve throw; the live one never reads it.
    const { profile } = resolveModel({ model: 'jev', live: true });
    expect(profile.model).toBe(JEV);
    expect(await createLiveAsk(profile)(decisionRequest())).toEqual(response('CLICK'));
    expect(live).toHaveBeenCalledTimes(1);
  });
});
