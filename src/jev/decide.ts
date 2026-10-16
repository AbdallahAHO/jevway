import {
  choice,
  Image,
  noul,
  type ChoiceResponse,
  type EntryType,
  type Question,
  type SystemOneRequest,
  type TypeSafeClient,
} from '@typesafe-ai/sdk';
import type { PageAction, PageState } from '../browser/tab.ts';
import { buildActionSpace, pick, type ActionSpace, type TargetOperation } from './action-space.ts';
import { matchTarget, overlap, readBox, toViewportRect, type Rect } from './box.ts';
import {
  COMMIT_RISK,
  DONE_CHECK,
  ELEMENT_COMMIT_RISK,
  NEXT_ACTION,
  NEXT_CLICK_BOX,
  NEXT_CLICK_COMMIT_RISK,
  NEXT_CLICK_PRESENT,
  TARGET,
  TARGET_BOX,
  TARGET_VISIBLE,
  VALUE,
} from './instructions.ts';
import type { ImageTransport } from './model.ts';

export const NO_SUPPLIED_VALUE = 'NO_SUPPLIED_VALUE';
// Speculative value heads ride along with the operation request; beyond this, TYPE_TEXT costs one follow-up.
const MAX_SPECULATIVE_VALUE_FIELDS = 8;
// Matches the autopilot's tap ranking depth, so every tap it may take has its own risk score.
const MAX_RISK_TARGETS = 12;

export interface StepRecord {
  operation: string;
  element: string;
  value_key?: string;
  page_changed?: boolean;
  /** For TYPE_TEXT: false when the field no longer holds the typed text (a popup swallowed it, a reset). */
  value_kept?: boolean;
  /** Set when the step was not executed because the screenshot showed its target covered. */
  not_executed?: string;
}

export interface DecisionInput {
  page: PageState;
  goal: string;
  values: Record<string, string>;
  history: StepRecord[];
  doneWhen?: string;
  checkCommitRisk: boolean;
  /** Extra judgments over the same page state that ride along in the same request (e.g. screen type, QA). */
  extraQuestions?: Record<string, Question>;
  /** Base64 JPEG of the viewport with element indexes drawn on it; only for models that read images. */
  screenshot?: string;
  /** How the screenshot is sent (default `image_url`). */
  imageTransport?: ImageTransport;
  /** Ask Box questions over the screenshot (needs `assets` transport on Jev 1.14). */
  box?: boolean;
  /** Replaces NEXT_ACTION in the operation head as one flat instruction (Clef-omni reads that better). */
  compactRules?: string;
  /**
   * Replaces the page-level commit-risk head with one risk question per named click candidate, in a
   * follow-up request: the chosen CLICK only, or the top ranked taps (journey autopilot acts on those).
   */
  elementRisk?: 'chosen' | 'ranked';
  /** With `elementRisk`: keep the page-level commit-risk head too; a chosen click takes the higher of the two. */
  pageRisk?: boolean;
}

export interface NextClick {
  /** Viewport CSS pixels. */
  rect: Rect;
  confidence: number;
  /** Probability that a control worth clicking next is visible at all (Box always answers with some box). */
  present: number;
  commitRisk: number;
  /** The observed click target the box points at, when it overlaps one enough to count. */
  match?: string;
  matchLabel?: string;
  matchOverlap: number;
}

export interface Candidate {
  element: string;
  probability: number;
}

export interface Decision {
  operation: string;
  /** The observed action to execute; absent for DONE and BLOCKED. */
  action?: PageAction;
  confidence: number;
  targetConfidence?: number;
  /** For TYPE_TEXT: the chosen `values` key, or null when no supplied value fits the field. */
  valueKey?: string | null;
  valueConfidence?: number;
  commitRisk?: number;
  doneProbability?: number;
  /** Empty text fields that none of the supplied values fits: what to ask for when Jev is BLOCKED. */
  fieldsWithoutValue: string[];
  candidates: Candidate[];
  /** Every raw answer, including the target distributions of operations that were not chosen. */
  answers: Record<string, any>;
  /** The request carried a marked screenshot. */
  sawScreenshot?: boolean;
  /** With `elementRisk`: commit risk per click target index that was asked about. */
  elementRisks?: Record<string, number>;
  /** The chosen target's index (CLICK, TYPE_TEXT or SELECT). */
  target?: string;
  /** With `box`: where the screenshot says the next click belongs, and the observed click target it overlaps. */
  nextClick?: NextClick;
  /** With `box`, for a chosen CLICK: is the target visibly unobstructed, and does its boxed position match the DOM. */
  targetCheck?: { visible: number; overlap: number };
  /** Set when a BLOCKED decision was turned into a click: from the screenshot's `nextClick` (`box`), or onto the collapsed control the click head favoured (`disclosure`). */
  via?: 'box' | 'disclosure';
  requests: number;
  inputTokens: number;
  latencyMs: number;
}

export type Ask = (
  request: SystemOneRequest,
) => Promise<{ answers: Record<string, any>; usage: { input_tokens: number | null } }>;

export const askWith =
  (client: TypeSafeClient): Ask =>
  (request) =>
    client.systemOne(request);

/**
 * One Jev round trip per step: the operation head plus speculative target, value, commit-risk and
 * done-check heads over the same page state. Code keeps only the heads the chosen operation needs.
 *
 * @example
 * const decision = await decide(askWith(new TypeSafeClient()), { page, goal, values: { city: 'Lisbon' }, history: [], checkCommitRisk: true });
 * if (decision.operation === 'TYPE_TEXT') tab.act(decision.action!, page, values[decision.valueKey!]);
 */
export const decide = async (ask: Ask, input: DecisionInput): Promise<Decision> => {
  const started = performance.now();
  const space = buildActionSpace(input.page.actions);
  const request = buildRequest(input, space);
  const response = await ask(request);
  const decision = readDecision(input, space, response.answers);
  let requests = 1;
  let inputTokens = response.usage.input_tokens ?? 0;

  const followUp = async (questions: Record<string, Question>) => {
    const answer = await ask({ state: request.state, questions });
    requests++;
    inputTokens += answer.usage.input_tokens ?? 0;
    return answer.answers;
  };
  const followUps: Promise<void>[] = [];

  // The chosen field had no speculative value head: ask once more with the field known.
  if (decision.operation === 'TYPE_TEXT' && decision.valueKey === undefined && Object.keys(input.values).length) {
    const target = targetIndexOf(space, 'TYPE_TEXT', decision.action!);
    followUps.push(
      followUp({ value: valueQuestion(input, space, target) }).then((answers) => {
        Object.assign(decision, readValue(answers.value, input.values));
      }),
    );
  }
  // Is the chosen click target visibly unobstructed, and does the model see it where the DOM says it is?
  if (input.box && input.screenshot && decision.operation === 'CLICK') {
    const index = decision.target!;
    const label = decision.action!.label;
    followUps.push(
      followUp({
        target_visible: noul(TARGET_VISIBLE(label, index)),
        target_box: { type: 'box', instructions: TARGET_BOX(label, index) },
      }).then((answers) => {
        const box = readBox(answers.target_box);
        const rect = decision.action!.rect;
        decision.targetCheck = {
          visible: typeof answers.target_visible?.noul === 'number' ? answers.target_visible.noul : 0,
          overlap: box && rect ? overlap(toViewportRect(box.edges, input.page), rect) : 0,
        };
      }),
    );
  }
  const riskTargets = elementRiskTargets(input, space, decision);
  if (riskTargets.length) {
    const questions = Object.fromEntries(riskTargets.map((index) => [`risk_${index}`, riskQuestion(input, space, index)]));
    followUps.push(
      followUp(questions).then((answers) => {
        decision.elementRisks = Object.fromEntries(riskTargets.map((index) => [index, readRisk(answers[`risk_${index}`])]));
        if (decision.operation === 'CLICK') {
          const elementRisk = decision.elementRisks[targetIndexOf(space, 'CLICK', decision.action!)];
          decision.commitRisk = input.pageRisk ? Math.max(decision.commitRisk ?? 0, elementRisk) : elementRisk;
        }
      }),
    );
  }
  await Promise.all(followUps);
  return {
    ...decision,
    ...(input.screenshot && { sawScreenshot: true }),
    requests,
    inputTokens,
    latencyMs: Math.round(performance.now() - started),
  };
};

export const buildRequest = (input: DecisionInput, space: ActionSpace): SystemOneRequest => {
  const { targets, controls, elements } = space;
  const operations: Record<string, string> = {
    ...(targets.CLICK && {
      CLICK: 'Click an element, button, link, menu option, autocomplete suggestion, or calendar day.',
    }),
    ...(targets.TYPE_TEXT && {
      TYPE_TEXT: 'Enter or replace text in an editable field, using one of the supplied values.',
    }),
    ...(targets.SELECT && { SELECT: 'Select an observed dropdown value.' }),
    ...Object.fromEntries(Object.entries(controls).map(([id, action]) => [id, action.label])),
    DONE: 'Every requirement is visibly satisfied.',
    BLOCKED: 'No supported operation can progress.',
  };
  const questions: Record<string, Question> = {
    operation: input.compactRules
      ? choice(`Goal: ${input.goal}\n${input.compactRules}`, operations)
      : choice({ goal: input.goal, rules: NEXT_ACTION }, operations),
  };

  for (const [operation, candidates] of Object.entries(targets)) {
    // A lone candidate needs no head (Clef rejects one-option choices); readDecision picks it outright.
    if (Object.keys(candidates).length < 2) continue;
    questions[`${operation.toLowerCase()}_target`] = choice(
      { goal: input.goal, operation, rules: [NEXT_ACTION, TARGET] },
      Object.fromEntries(Object.entries(candidates).map(([index, action]) => [index, describeTarget(index, action)])),
    );
  }
  if (Object.keys(input.values).length) {
    for (const index of Object.keys(targets.TYPE_TEXT ?? {}).slice(0, MAX_SPECULATIVE_VALUE_FIELDS)) {
      questions[`value_for_${index}`] = valueQuestion(input, space, index);
    }
  }
  if (input.checkCommitRisk && targets.CLICK && (!input.elementRisk || input.pageRisk)) questions.commit_risk = noul({ goal: input.goal, rules: COMMIT_RISK });
  if (input.doneWhen) questions.done_check = noul({ completion_condition: input.doneWhen, rules: DONE_CHECK });
  if (input.box && input.screenshot) {
    questions.next_click_box = { type: 'box', instructions: NEXT_CLICK_BOX(input.goal) };
    questions.next_click_present = noul(NEXT_CLICK_PRESENT(input.goal));
    questions.next_click_commit_risk = noul({ goal: input.goal, rules: NEXT_CLICK_COMMIT_RISK });
  }
  Object.assign(questions, input.extraQuestions);

  const state = {
    page: pick(input.page, ['url', 'title', 'text']),
    elements,
    supplied_values: input.values,
    recent_actions: input.history.slice(-10),
    ...(input.screenshot && { screenshot: SCREENSHOT_NOTE }),
  };
  // TypeSafe takes the image as an asset in place under `screenshot`; OpenRouter vision models read image parts
  // only from a top-level state array, ahead of the JSON state.
  // Interfaces lack index signatures, so the plain JSON state needs one cast for the SDK's EntryType.
  const withImage = !input.screenshot
    ? state
    : input.imageTransport === 'assets'
      ? { ...state, screenshot: Image.fromBase64(input.screenshot), screenshot_note: SCREENSHOT_NOTE }
      : [imagePart(input.screenshot), state];
  return { state: withImage as unknown as NonNullable<EntryType>, questions };
};

const SCREENSHOT_NOTE =
  'The image is the current viewport. Each numbered box marks the element with that index in "elements".';

const imagePart = (jpegBase64: string) => ({
  type: 'image_url',
  image_url: { url: `data:image/jpeg;base64,${jpegBase64}` },
});

const describeTarget = (index: string, action: PageAction) => ({
  element: `[${index}] ${action.label}`,
  current_value: action.current_value ?? action.value ?? '',
  ...pick(action, ['role', 'checked', 'selected', 'expanded']),
});

const valueQuestion = (input: DecisionInput, space: ActionSpace, index: string) => {
  const field = space.targets.TYPE_TEXT![index];
  return choice(
    { goal: input.goal, field: describeTarget(index, field), rules: VALUE },
    {
      ...Object.fromEntries(Object.entries(input.values).map(([key, value]) => [key, `${key}: ${value}`])),
      [NO_SUPPLIED_VALUE]: 'None of the supplied values belongs in this field.',
    },
  );
};

export const readDecision = (
  input: DecisionInput,
  space: ActionSpace,
  answers: Record<string, any>,
): Omit<Decision, 'requests' | 'inputTokens' | 'latencyMs'> => {
  const operationIds = [...Object.keys(space.targets), ...Object.keys(space.controls), 'DONE', 'BLOCKED'];
  const operationAnswer = validChoice(answers.operation, operationIds);
  const operation = operationAnswer.choice;
  const decision: Omit<Decision, 'requests' | 'inputTokens' | 'latencyMs'> = {
    operation,
    confidence: operationAnswer.confidence,
    candidates: [],
    answers,
    fieldsWithoutValue: fieldsWithoutValue(input, space, answers),
    ...(answers.commit_risk && { commitRisk: answers.commit_risk.noul }),
    ...(answers.done_check && { doneProbability: answers.done_check.noul }),
  };

  const nextClickBox = readBox(answers.next_click_box);
  if (nextClickBox) {
    const rect = toViewportRect(nextClickBox.edges, input.page);
    const { index, overlap: matchOverlap } = matchTarget(rect, space.targets.CLICK ?? {});
    decision.nextClick = {
      rect,
      confidence: nextClickBox.confidence,
      present: answers.next_click_present?.noul ?? 0,
      // Unknown risk counts as certain: it can only stop a click.
      commitRisk: answers.next_click_commit_risk?.noul ?? 1,
      ...(index && { match: index, matchLabel: space.targets.CLICK![index].label }),
      matchOverlap,
    };
  }
  const candidates = space.targets[operation as TargetOperation];
  if (candidates) {
    // Unused target heads can never cause an action; only the chosen operation's head is validated.
    const ids = Object.keys(candidates);
    const targetAnswer =
      ids.length === 1
        ? { type: 'choice' as const, choice: ids[0], confidence: 1, probabilities: { [ids[0]]: 1 } }
        : validChoice(answers[`${operation.toLowerCase()}_target`], ids);
    decision.action = candidates[targetAnswer.choice];
    decision.target = targetAnswer.choice;
    decision.targetConfidence = targetAnswer.confidence;
    decision.candidates = Object.entries(targetAnswer.probabilities)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([index, probability]) => ({
        element: `[${index}] ${candidates[index].label}`,
        probability: round(probability),
      }));
    if (operation === 'TYPE_TEXT') {
      const valueAnswer = answers[`value_for_${targetAnswer.choice}`];
      if (valueAnswer) Object.assign(decision, readValue(valueAnswer, input.values));
      else if (!Object.keys(input.values).length) decision.valueKey = null;
    }
  } else if (space.controls[operation]) {
    decision.action = space.controls[operation];
  }
  return decision;
};

const fieldsWithoutValue = (input: DecisionInput, space: ActionSpace, answers: Record<string, any>) =>
  Object.entries(space.targets.TYPE_TEXT ?? {})
    .filter(([, field]) => !field.value)
    .filter(([index]) => {
      if (!Object.keys(input.values).length) return true;
      const answer = answers[`value_for_${index}`];
      return answer?.choice === NO_SUPPLIED_VALUE;
    })
    .map(([, field]) => field.label);

const readValue = (answer: unknown, values: Record<string, string>) => {
  const valueAnswer = validChoice(answer, [...Object.keys(values), NO_SUPPLIED_VALUE]);
  return {
    valueKey: valueAnswer.choice === NO_SUPPLIED_VALUE ? null : valueAnswer.choice,
    valueConfidence: valueAnswer.confidence,
  };
};

const targetIndexOf = (space: ActionSpace, operation: TargetOperation, action: PageAction) =>
  Object.entries(space.targets[operation]!).find(([, candidate]) => candidate === action)![0];

/**
 * While the model says BLOCKED: the click head's top candidate when it is collapsed (`aria-expanded="false"`), the
 * control a person would open before giving up. The head was not the chosen one, so its answer is checked here.
 */
export const foldedFavourite = (answers: Record<string, any>, clicks: Record<string, PageAction>) => {
  const ids = Object.keys(clicks);
  if (ids.length < 2) return undefined;
  try {
    const { probabilities } = validChoice(answers.click_target, ids);
    const [id, probability] = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0];
    return clicks[id].expanded === 'false' ? { id, probability, action: clicks[id] } : undefined;
  } catch {
    return undefined;
  }
};

// The chosen click and the element under the screenshot box first (a box rescue clicks it, so it is judged by name too),
// then a collapsed control a BLOCKED step favours (opening it is a click too), then (for the autopilot) the remaining
// taps by the target head's ranking.
const elementRiskTargets = (input: DecisionInput, space: ActionSpace, decision: Pick<Decision, 'operation' | 'action' | 'answers' | 'nextClick'>) => {
  const clicks = space.targets.CLICK;
  if (!input.elementRisk || !input.checkCommitRisk || !clicks) return [];
  const chosen = decision.operation === 'CLICK' ? [targetIndexOf(space, 'CLICK', decision.action!)] : [];
  const boxed = decision.nextClick?.match ? [decision.nextClick.match] : [];
  const folded = decision.operation === 'BLOCKED' ? foldedFavourite(decision.answers, clicks) : undefined;
  const judged = [...new Set([...chosen, ...boxed, ...(folded ? [folded.id] : [])])];
  if (input.elementRisk === 'chosen') return judged;
  const probabilities: Record<string, number> = decision.answers.click_target?.probabilities ?? {};
  const ranked = Object.keys(clicks).sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0));
  return [...new Set([...judged, ...ranked])].slice(0, MAX_RISK_TARGETS);
};

const riskQuestion = (input: DecisionInput, space: ActionSpace, index: string) =>
  noul({ goal: input.goal, element: describeTarget(index, space.targets.CLICK![index]), rules: ELEMENT_COMMIT_RISK });

/** A malformed risk answer counts as certain risk: it can only stop a click, never allow one. */
const readRisk = (answer: any) => {
  const risk = answer?.noul;
  return typeof risk === 'number' && Number.isFinite(risk) && risk >= 0 && risk <= 1 ? risk : 1;
};

/** A malformed answer must never execute anything. */
export const validChoice = (answer: any, ids: string[]): ChoiceResponse => {
  const probabilities: Record<string, number> = answer?.probabilities ?? {};
  const numbers = [...Object.values(probabilities), answer?.confidence];
  const valid =
    ids.includes(answer?.choice) &&
    Object.keys(probabilities).length === ids.length &&
    ids.every((id) => id in probabilities) &&
    numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) &&
    Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) < 0.02;
  if (!valid) throw new Error('Invalid TypeSafe answer; no action executed.');
  return answer;
};

const round = (value: number) => Math.round(value * 1000) / 1000;
