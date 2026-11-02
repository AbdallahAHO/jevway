import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskResult } from '../session/session-service.ts';
import { presentSummary, type Detail, type RunFiles } from '../task/present.ts';
import type { TaskStatus } from '../task/run-task.ts';

/** When a task result carries its end page inline: `JEVWAY_IMAGE_RESPONSES`. */
export type ImageResponses = 'auto' | 'always' | 'never';

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string; description: string };

// The statuses where the agent decides what happens next, so it sees the page it decides on.
const HAND_BACKS = new Set<TaskStatus>(['needs_input', 'needs_confirmation', 'uncertain', 'blocked']);

/**
 * Whether a result attaches its end page: `always` on every status, `never` on none (not even with `screenshot`),
 * `auto` on a hand-back or when the call asked with `screenshot: true`.
 */
export const attachesEndPage = (mode: ImageResponses, status: TaskStatus, asked: boolean) =>
  mode === 'always' || (mode === 'auto' && (asked || HAND_BACKS.has(status)));

/** A local file as a `resource_link`: a `file://` URI of its absolute path, named by its file name. */
export const linkTo = (path: string, mimeType: string, description: string): Content => ({
  type: 'resource_link',
  uri: pathToFileURL(path).href,
  name: path.split(/[\\/]/).pop()!,
  mimeType,
  description,
});

/** A run folder's files as `file://` links: the end page, the recording when kept, the summary and the manifest. */
export const runLinks = (files: RunFiles): Content[] => [
  ...(files.screenshot ? [linkTo(files.screenshot, 'image/jpeg', 'The page as this call ended.')] : []),
  ...(files.page ? [linkTo(files.page, 'text/html', 'The recording page: video, step shots and timeline.')] : []),
  ...(files.video ? [linkTo(files.video, 'video/mp4', 'A screencast of the run.')] : []),
  linkTo(join(files.run_dir, 'summary.json'), 'application/json', "Every call's summary in this session."),
  linkTo(files.manifest, 'application/json', 'Every file in the run folder, with what it is.'),
];

/** A result object as one JSON text block plus the same object as `structuredContent`. */
export const jsonResult = <T extends object>(out: T, extra: Content[] = []) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(out) }, ...extra],
  structuredContent: out as T & Record<string, unknown>,
});

/**
 * A task call's result as an agent reads it: the presented summary leading with status, reason, story, next and
 * session (`page_text`, the bulk, last), the end page inline per the image rule, then links to the run folder.
 *
 * @example
 * taskResult(await service.task(request), { detail: 'concise', screenshot: false, images: 'auto' })
 * // { content: [{ type: 'text', text: '{"status":"needs_input",…}' }, { type: 'image', … }, { type: 'resource_link', name: 'final.jpg', … }, …], structuredContent }
 */
export const taskResult = (
  result: TaskResult,
  { detail, screenshot, images }: { detail: Detail; screenshot: boolean; images: ImageResponses },
) => {
  const { status, reason, story, next, session, page_text, ...rest } = presentSummary(result, { detail });
  const out = { status, reason, story, next, session, ...rest, page_text };
  const image: Content[] =
    result.screenshot && attachesEndPage(images, status, screenshot)
      ? [{ type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' }]
      : [];
  return jsonResult(out, [...image, ...(result.files ? runLinks(result.files) : [])]);
};

/** A failed call as an `isError` result: what went wrong and, in the message, what to do. */
export const errorResult = (tool: string, error: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `${tool} failed: ${(error as Error).message}` }],
});
