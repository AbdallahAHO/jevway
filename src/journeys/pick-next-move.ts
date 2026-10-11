import type { PageAction } from '../browser/tab.ts';
import type { ActionSpace } from '../jev/action-space.ts';
import type { Decision } from '../jev/decide.ts';
import type { ScreenJudgments } from './screen-judgments.ts';

// Beyond this rank a tap is rarely part of a core journey; backing out explores more usefully.
const MAX_RANKED_TAPS = 12;
// With an intent, taps Jev considers nearly irrelevant are noise (logos, org switchers), not exploration.
const INTENT_MIN_PROBABILITY = 0.03;

export type Move =
  | { stop: 'auth_wall' | 'intent_reached' | 'irreversible_action'; detail?: string }
  | { move: 'act'; key: string; operation: string; action: PageAction; valueKey?: string }
  | { move: 'skip_risky'; key: string; label: string }
  | { move: 'back' };

/**
 * Autopilot policy for one screen, from the Jev answers already in hand (no extra request):
 * Jev's chosen step first, then remaining taps by Jev's probability, then one scroll, then back.
 * Irreversible taps stop an intent run and are skipped while exploring.
 *
 * @example
 * pickNextMove({ decision, judgments, space, tried: new Set(['CLICK:Search']), hasIntent: false })
 * // { move: 'act', key: 'CLICK:Filters', operation: 'CLICK', action }
 */
export const pickNextMove = ({
  decision,
  judgments,
  space,
  tried,
  hasIntent,
}: {
  decision: Decision;
  judgments: ScreenJudgments;
  space: ActionSpace;
  tried: Set<string>;
  hasIntent: boolean;
}): Move => {
  if (judgments.type === 'auth' || judgments.authWall >= 0.6) return { stop: 'auth_wall' };
  if (hasIntent && decision.operation === 'DONE') return { stop: 'intent_reached' };

  const ranked = Object.entries((decision.answers.click_target?.probabilities ?? {}) as Record<string, number>)
    .sort(([, a], [, b]) => b - a)
    .filter(([, probability]) => !hasIntent || probability >= INTENT_MIN_PROBABILITY)
    .slice(0, MAX_RANKED_TAPS)
    .map(([index]) => ({
      operation: 'CLICK',
      action: space.targets.CLICK![index],
      valueKey: undefined as string | undefined,
    }));
  const chosen =
    decision.action && ['CLICK', 'SELECT'].includes(decision.operation)
      ? [{ operation: decision.operation, action: decision.action, valueKey: undefined }]
      : decision.action && decision.operation === 'TYPE_TEXT' && decision.valueKey
        ? [{ operation: 'TYPE_TEXT', action: decision.action, valueKey: decision.valueKey }]
        : [];
  const topTap = ranked[0]?.action;
  // Per-element risk scores every tap by name; an unscored tap counts as risky. Without them, the
  // page-level commit_risk describes only the top tap.
  const clickIndexOf = (action: PageAction) =>
    Object.entries(space.targets.CLICK ?? {}).find(([, candidate]) => candidate === action)?.[0];
  const riskOf = (operation: string, action: PageAction) => {
    if (operation !== 'CLICK') return 0;
    if (decision.elementRisks) return decision.elementRisks[clickIndexOf(action) ?? ''] ?? 1;
    return action === topTap ? (decision.commitRisk ?? 0) : 0;
  };

  for (const candidate of [...chosen, ...ranked]) {
    const key = `${candidate.operation}:${candidate.action.label}`;
    if (tried.has(key)) continue;
    const risky = riskOf(candidate.operation, candidate.action) >= 0.5;
    if (risky && hasIntent) return { stop: 'irreversible_action', detail: candidate.action.label };
    if (risky) return { move: 'skip_risky', key, label: candidate.action.label };
    return { move: 'act', key, ...candidate };
  }
  if (space.controls.SCROLL_DOWN && !tried.has('SCROLL_DOWN')) {
    return { move: 'act', key: 'SCROLL_DOWN', operation: 'SCROLL_DOWN', action: space.controls.SCROLL_DOWN };
  }
  return { move: 'back' };
};
