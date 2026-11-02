import type { StepRecord } from '../jev/decide.ts';
import type { RunFiles } from '../output/run-folder.ts';
import { describeStep } from '../recording/recording.ts';
import type { TaskSummary } from './run-task.ts';

export type { RunFiles };

export type Detail = 'concise' | 'full';

// What the run appends to a step's element, in parentheses: a tab switch, a dialog, a scroll that moved nothing.
const NOTE = / \((?=new tab opened: |the tab closed; |nothing moved: |the page then )/;

const splitNotes = (element: string) => {
  const [label, ...notes] = element.split(NOTE);
  return { label, notes: notes.map((note) => note.replace(/\)$/, '')) };
};

const outcomeOf = (note: string) => {
  if (note.startsWith('new tab opened: ')) return `a ${note}`;
  if (note.startsWith('nothing moved: ')) return 'nothing moved';
  return note;
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * One step of a summary as a plain past-tense sentence, in the recording page's words, plus what happened when that
 * was not the plain outcome. Steps are scrubbed before a summary leaves the run, so a secret shows only as its marker.
 *
 * @example
 * storyLine({ operation: 'TYPE_TEXT', element: 'Destination', value_key: 'destination' })
 * // 'Typed the "destination" value into "Destination".'
 */
export const storyLine = (step: StepRecord) => {
  const { label, notes } = splitNotes(step.element);
  const [element, option] = step.operation === 'SELECT' && label.includes(' → ') ? label.split(/ → (?=[^→]*$)/) : [label];
  const intent = { operation: step.operation, element, valueKey: step.value_key, fileKey: step.file_key, option };
  if (step.not_executed) {
    return step.operation === 'DONE'
      ? `Did not finish yet: ${step.not_executed}.`
      : `Did not ${lowerFirst(describeStep(intent))}: ${step.not_executed}.`;
  }
  // The run's own Escapes say what they closed.
  if (step.operation === 'PRESS_ESCAPE' && element.startsWith('closed ')) return `Pressed Escape and ${element}.`;
  const outcomes = [...notes.map(outcomeOf), ...(step.value_kept === false ? ['the field did not keep the text'] : [])];
  return `${describeStep(intent, 'done')}${outcomes.length ? `; ${outcomes.join('; ')}` : ''}.`;
};

/** A call's steps as one sentence each. */
export const storyOf = (steps: StepRecord[]) => steps.map(storyLine);

/**
 * The one thing the caller does next after this status, in the tools' parameter names.
 *
 * @example
 * nextFor({ status: 'needs_input', … }) // 'Add the missing values to `values` and call again with this session.'
 */
export const nextFor = ({ status, wall }: Pick<TaskSummary, 'status' | 'wall'>) => {
  switch (status) {
    case 'done':
      return 'Read the result in `page_text` (and `evidence`); end the session when you no longer need its tab.';
    case 'needs_input':
      return 'Add the missing values to `values` and call again with this session.';
    case 'needs_confirmation':
      return "Ask the user, unless their own request names this action and its target; then call again with this session, `confirm_irreversible: true` and `confirm_target` (the user's words naming the target).";
    case 'uncertain':
      return 'Look at the screenshot and `page_text`, then call again with this session and a clearer `goal`, or finish the step yourself.';
    case 'step_budget':
      return 'Call again with this session and a narrower `goal`, or a larger `max_steps` / `max_seconds`.';
    case 'blocked':
      if (wall?.kind === 'bot_check') return 'Never try to get past it: ask the user to pass it in that tab, then call again with this session.';
      if (wall?.kind === 'sign_in') return `Sign in at ${wall.origin} (or pass the values the form wants), then call again with this session.`;
      return 'Read the reason: tell the user, or change `goal` or `values` and call again with this session.';
  }
};

/** What a caller reads by default: how the call ended, its story, the final page, the files and what to do next. */
export interface ConciseSummary
  extends Pick<TaskSummary, 'status' | 'reason' | 'url' | 'title' | 'page_text' | 'missing' | 'wall' | 'checks' | 'evidence' | 'confirm_ignored'> {
  session: string;
  next: string;
  story: string[];
  files?: RunFiles;
}

/** The concise form plus the raw steps with confidences, Jev's stats and the stuck candidates. */
export type FullSummary = ConciseSummary & Pick<TaskSummary, 'steps' | 'jev' | 'stuck' | 'elapsed_ms' | 'done_probability'>;

const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as T;

/**
 * A call's result as the caller reads it. `concise` (the default) carries the story, the final page, the files and
 * what to do next; `full` adds the raw steps with confidences, Jev's stats and the stuck candidates. A dropped
 * confirmation (`confirm_ignored`) shows in both: consent the caller gave and jevway did not use.
 *
 * @example
 * presentSummary({ session, summary, files }) // { session, status, reason, next, story, url, title, page_text, files }
 */
export function presentSummary(result: { session: string; summary: TaskSummary; files?: RunFiles }, options?: { detail?: 'concise' }): ConciseSummary;
export function presentSummary(result: { session: string; summary: TaskSummary; files?: RunFiles }, options: { detail: Detail }): ConciseSummary | FullSummary;
export function presentSummary(
  { session, summary, files }: { session: string; summary: TaskSummary; files?: RunFiles },
  { detail = 'concise' }: { detail?: Detail } = {},
): ConciseSummary | FullSummary {
  const concise: ConciseSummary = {
    session,
    status: summary.status,
    reason: summary.reason,
    next: nextFor(summary),
    story: storyOf(summary.steps),
    url: summary.url,
    title: summary.title,
    page_text: summary.page_text,
    missing: summary.missing,
    wall: summary.wall,
    checks: summary.checks,
    evidence: summary.evidence,
    confirm_ignored: summary.confirm_ignored,
    files,
  };
  if (detail === 'concise') return defined(concise);
  const { steps, jev, stuck, elapsed_ms, done_probability } = summary;
  return defined({ ...concise, steps, jev, stuck, elapsed_ms, done_probability });
}
