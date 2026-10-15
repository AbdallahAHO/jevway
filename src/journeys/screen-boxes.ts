import { noul, type Question } from '@typesafe-ai/sdk';
import type { PageState } from '../browser/tab.ts';
import { matchTarget, overlap, readBox, toViewportRect } from '../jev/box.ts';
import type { Hotspot } from './journey-doc.ts';
import type { QaFinding } from './screen-judgments.ts';

// A tappable thing the screenshot shows counts as missing from the DOM only when the model is this sure of it.
const UNLISTED_SURE = 0.6;
const BOX_SURE = 0.5;

export type PrimaryAction = Hotspot & { confidence: number; element?: string };

/** Box questions over a screen's marked screenshot (Jev 1.14 on the TypeSafe API); ride along with the decision. */
export const screenBoxQuestions = (): Record<string, Question> => ({
  primary_action_box: { type: 'box', instructions: 'the primary action on this screen in `screenshot`' },
  unlisted_control: noul(
    'In `screenshot`, is there a tappable control (button, link, icon, tab) that has NO numbered outline? ' +
      'Ignore plain text, images that are not controls, and the outlines themselves.',
  ),
  unlisted_control_box: {
    type: 'box',
    instructions: 'the most prominent tappable control in `screenshot` that has no numbered outline',
  },
});

/**
 * The screen's primary action as a viewer hotspot, and a QA finding when the screenshot shows a control the
 * DOM reader never reported (canvas, iframe, image without a role): automation and assistive tech miss it too.
 *
 * @example
 * const { primaryAction, finding } = readScreenBoxes(decision.answers, page);
 */
export const readScreenBoxes = (answers: Record<string, any>, page: PageState) => {
  const primary = readBox(answers.primary_action_box);
  const targets = Object.fromEntries(page.actions.filter((action) => action.rect).map((action) => [action.id, action]));
  const primaryAction: PrimaryAction | undefined = primary && {
    x: primary.edges.left,
    y: primary.edges.top,
    width: primary.edges.right - primary.edges.left,
    height: primary.edges.bottom - primary.edges.top,
    confidence: primary.confidence,
    ...labelOf(matchTarget(toViewportRect(primary.edges, page), targets).index, targets),
  };

  const unlisted = readBox(answers.unlisted_control_box);
  const sure = (answers.unlisted_control?.noul ?? 0) >= UNLISTED_SURE && (unlisted?.confidence ?? 0) >= BOX_SURE;
  const rect = unlisted && toViewportRect(unlisted.edges, page);
  // Any overlap with a reported control means the DOM does know about it.
  const known = rect && Object.values(targets).some((action) => overlap(rect, action.rect!) > 0.1);
  const finding: QaFinding | undefined =
    sure && rect && !known
      ? {
          kind: 'control_not_in_dom',
          severity: 'medium',
          detail: `A tappable control at ${percent(unlisted.edges.left)} × ${percent(unlisted.edges.top)} has no DOM control (canvas, iframe, or image without a role)`,
        }
      : undefined;
  return { primaryAction, finding };
};

const labelOf = (id: string | undefined, targets: Record<string, PageState['actions'][number]>) =>
  id ? { element: targets[id].label } : {};

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
