import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Image } from '@typesafe-ai/sdk';
import type { Ask } from './decide.ts';

export type ReplayMode = 'record' | 'replay';

/** The model route a recording was made on, so a replay asks the same questions of the same model id without a key. */
export interface RecordedRoute {
  /** The profile name (`jev`, `clef-omni`, …). */
  profile: string;
  /** The model id requests were sent with. */
  model: string;
  /** `direct`: the TypeSafe API (Jev with `assets` images and Box); `openrouter`: everything else. */
  route: 'direct' | 'openrouter';
  /** `JEVWAY_SCREENSHOTS` at recording time, when it was set. */
  screenshots?: string;
}

type Answer = Awaited<ReturnType<Ask>>;
type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };
interface Entry {
  key: string;
  model: string;
  request: Canonical;
  answer: Answer;
}

/**
 * A request the recording never saw: the run can't be answered offline. The message names the request and the changed
 * paths; the page-text lines are in `pageDiff` only, because the run retries a model error whose message reads like a
 * timeout, and a page can say "timed out".
 */
export class ReplayMiss extends Error {
  override name = 'ReplayMiss';
  readonly pageDiff: string[];
  constructor(message: string, pageDiff: string[] = []) {
    super(message);
    this.pageDiff = pageDiff;
  }
}

const IMAGE = '<image>';
const LOCAL_ORIGIN = /\b(127\.0\.0\.1|localhost):\d+/g;

/**
 * `JEVWAY_REPLAY`: `record` saves every Jev answer next to its request, `replay` answers only from those recordings;
 * unset means live. Any other value is a configuration error, never a silent live run.
 *
 * @example
 * replayMode(); // 'replay' under JEVWAY_REPLAY=replay
 */
export const replayMode = (): ReplayMode | undefined => {
  const mode = process.env.JEVWAY_REPLAY?.trim();
  if (!mode) return undefined;
  if (mode !== 'record' && mode !== 'replay') throw new Error(`JEVWAY_REPLAY must be record or replay, got "${mode}".`);
  return mode;
};

/** The recording folder, `JEVWAY_REPLAY_DIR`: required whenever `JEVWAY_REPLAY` is set, so no run writes into a guessed folder. */
export const replayDir = () => {
  const dir = process.env.JEVWAY_REPLAY_DIR?.trim();
  if (!dir) throw new Error('JEVWAY_REPLAY needs JEVWAY_REPLAY_DIR: the folder that holds the recordings.');
  return resolve(dir);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The request as it is matched: keys sorted at every depth, every image (an SDK `Image`, an `image_url` part, a
 * `data:image/…` URL) replaced by `<image>`, and every local fixture origin's port by `<port>`. Two runs of the same
 * step on fresh fixture servers then read the same: their only differences are the random port and the screenshot's
 * reference and pixels, and the screenshot is drawn from the same elements the text state lists.
 *
 * @example
 * canonicalRequest({ state: { page: { url: 'http://127.0.0.1:63068/stays.html' } } });
 * // { state: { page: { url: 'http://127.0.0.1:<port>/stays.html' } } }
 */
export const canonicalRequest = (value: unknown): Canonical => {
  if (value instanceof Image || value instanceof Blob) return IMAGE;
  if (typeof value === 'string') return value.startsWith('data:image/') ? IMAGE : value.replace(LOCAL_ORIGIN, '$1:<port>');
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalRequest(item)));
  if (isPlainObject(value)) {
    if (value.type === 'image_url') return IMAGE;
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return Object.fromEntries(keys.map((key) => [key, canonicalRequest(value[key])]));
  }
  const json = (value as { toJSON?: () => unknown } | undefined)?.toJSON?.();
  return json === undefined ? null : canonicalRequest(json);
};

const keyOf = (model: string, canonical: Canonical) =>
  createHash('sha256').update(JSON.stringify({ model, request: canonical })).digest('hex');

/**
 * The replay key: the sha256 of the model id and the canonical request. The same page asked of another model never
 * matches.
 *
 * @example
 * requestKey('jev-1.14.0', request) === requestKey('jev-1.14.0', sameStepOnAnotherPort); // true
 */
export const requestKey = (model: string, request: unknown) => keyOf(model, canonicalRequest(request));

let recordings = 0;

/**
 * Wraps the live Ask: each answer is appended to this process's own JSONL file in `dir` (a header line with the route
 * first, then one `{ key, model, request, answer }` line per request), in the order the answers came. A failed request
 * is not recorded. The request is stored as sent, already scrubbed of secret values, with its images left out.
 *
 * @example
 * const ask = recordingAsk(liveAsk, { profile: 'jev', model: 'jev-1.14.0', route: 'direct' }, 'verify/out/replay/mine/gotchas');
 */
export const recordingAsk = (ask: Ask, route: RecordedRoute, dir = replayDir()): Ask => {
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${++recordings}.jsonl`);
  let started = false;
  const write = (line: unknown) => appendFileSync(file, `${JSON.stringify(line)}\n`);
  return async (request, options) => {
    const answer = await ask(request, options);
    if (!started) {
      mkdirSync(dir, { recursive: true });
      write({ header: route });
      started = true;
    }
    const canonical = canonicalRequest(request);
    write({ key: keyOf(route.model, canonical), model: route.model, request: canonical, answer } satisfies Entry);
    return answer;
  };
};

const recordingFiles = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith('.jsonl'))
        .sort()
        .map((file) => join(dir, file))
    : [];

const linesOf = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry | { header: RecordedRoute });

const nothingRecorded = (dir: string) => new Error(`No recorded Jev answers in ${dir}; record them first with JEVWAY_REPLAY=record.`);

/**
 * The route the recordings in `dir` were made on (the first file's header), so a replay resolves the same profile.
 *
 * @example
 * recordedRoute('verify/out/replay/mine/gotchas'); // { profile: 'jev', model: 'jev-1.14.0', route: 'direct' }
 */
export const recordedRoute = (dir = replayDir()): RecordedRoute => {
  for (const file of recordingFiles(dir)) {
    const header = linesOf(file).find((line): line is { header: RecordedRoute } => 'header' in line);
    if (header) return header.header;
  }
  throw nothingRecorded(dir);
};

/**
 * An Ask that answers only from the recordings in `dir` and never reaches the network: answers come back at once.
 * A request recorded more than once gets its answers in the order they were recorded, then the last one again. A
 * request never recorded throws `ReplayMiss`, naming its goal, step and kind with a diff against the nearest recorded
 * request, and writes one `replay miss:` line to stderr, because a run may end a failed request as a hand-back.
 *
 * @example
 * const ask = replayingAsk('jev-1.14.0', 'verify/out/replay/mine/gotchas');
 */
export const replayingAsk = (model: string, dir = replayDir()): Ask => {
  const entries = recordingFiles(dir)
    .flatMap(linesOf)
    .filter((line): line is Entry => 'key' in line);
  if (!entries.length) throw nothingRecorded(dir);
  const answers = new Map<string, Answer[]>();
  for (const entry of entries) answers.set(entry.key, [...(answers.get(entry.key) ?? []), entry.answer]);
  const served = new Map<string, number>();
  const ofModel = entries.filter((entry) => entry.model === model);

  return async (request) => {
    const canonical = canonicalRequest(request);
    const key = keyOf(model, canonical);
    const recorded = answers.get(key);
    if (recorded) {
      const turn = served.get(key) ?? 0;
      served.set(key, turn + 1);
      return structuredClone(recorded[Math.min(turn, recorded.length - 1)]);
    }
    const { headline, brief, paths, pageDiff } = describeMiss(canonical, model, ofModel);
    process.stderr.write(`replay miss: ${headline} · ${brief}\n${[...paths, ...pageDiff].map((line) => `    ${line}\n`).join('')}`);
    throw new ReplayMiss(`Replay miss: ${headline}\n${paths.join('\n')}`, pageDiff);
  };
};

// What a request is about, for a person reading a miss: its goal, the step it was asked at, and its kind.
const describeRequest = (canonical: Canonical) => {
  const request = canonical as { state?: Canonical; questions?: Record<string, any> };
  const questions = request.questions ?? {};
  const state = (Array.isArray(request.state) ? request.state.find((part) => isPlainObject(part) && 'page' in part) : request.state) as
    | { recent_actions?: unknown[]; page?: { text?: string } }
    | undefined;
  const instructions = Object.values(questions).map((question) => question?.instructions);
  const goal =
    instructions.find((text) => isPlainObject(text) && typeof text.goal === 'string')?.goal ??
    instructions.find((text) => typeof text === 'string' && text.startsWith('Goal: '))?.split('\n')[0].slice('Goal: '.length) ??
    instructions.find((text) => isPlainObject(text) && typeof text.completion_condition === 'string')?.completion_condition;
  const ids = Object.keys(questions);
  const kind = 'operation' in questions ? 'decision' : 'evidence' in questions ? 'evidence' : `follow-up (${ids.slice(0, 4).join(', ')})`;
  const step = Array.isArray(state?.recent_actions) ? state.recent_actions.length + 1 : undefined;
  return { goal: goal as string | undefined, kind, step, pageText: typeof state?.page?.text === 'string' ? state.page.text : undefined };
};

// Every leaf of a canonical request by its dotted path.
const leaves = (value: Canonical, path = '', into = new Map<string, string>()) => {
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) leaves(inner, path ? `${path}.${key}` : key, into);
  } else into.set(path, JSON.stringify(value));
  return into;
};

const changedPaths = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path));

const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

const MAX_PATHS = 8;
const MAX_LINES = 6;

// The nearest recorded request with the same goal (any, when none shares it), and what differs from it.
const describeMiss = (canonical: Canonical, model: string, recorded: Entry[]) => {
  const asked = describeRequest(canonical);
  const headline = [`"${cut(asked.goal ?? 'no goal', 80)}"`, ...(asked.step ? [`step ${asked.step}`] : []), asked.kind].join(' · ');
  if (!recorded.length) return { headline, brief: `nothing was recorded for ${model}`, paths: [`nothing was recorded for ${model}`], pageDiff: [] };
  const sameGoal = recorded.filter((entry) => describeRequest(entry.request).goal === asked.goal);
  const askedLeaves = leaves(canonical);
  const [nearest] = (sameGoal.length ? sameGoal : recorded)
    .map((entry) => ({ entry, changed: changedPaths(leaves(entry.request), askedLeaves) }))
    .sort((a, b) => a.changed.length - b.changed.length);
  const paths = [
    `nearest recorded request${sameGoal.length ? ' with the same goal' : ''} differs at ${nearest.changed.length} paths:`,
    ...nearest.changed.slice(0, MAX_PATHS).map((path) => `  ${path}`),
  ];
  const pageDiff: string[] = [];
  const before = describeRequest(nearest.entry.request).pageText;
  if (before !== undefined && asked.pageText !== undefined && before !== asked.pageText) {
    const [was, now] = [before.split('\n'), asked.pageText.split('\n')];
    const onlyIn = (lines: string[], other: string[]) => lines.filter((line) => !other.includes(line)).slice(0, MAX_LINES).map((line) => `  ${cut(line, 120)}`);
    pageDiff.push('page text only recorded:', ...onlyIn(was, now), 'page text only now:', ...onlyIn(now, was));
  }
  return { headline, brief: `differs at ${nearest.changed.slice(0, 3).join(', ')}`, paths, pageDiff };
};
