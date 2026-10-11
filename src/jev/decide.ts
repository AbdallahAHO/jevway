import {
  choice,
  noul,
  type ChoiceResponse,
  type EntryType,
  type Question,
  type SystemOneRequest,
  type TypeSafeClient,
} from '@typesafe-ai/sdk';
import type { PageAction, PageState } from '../browser/tab.ts';
import { buildActionSpace, pick, type ActionSpace, type TargetOperation } from './action-space.ts';
import { COMMIT_RISK, DONE_CHECK, ELEMENT_COMMIT_RISK, NEXT_ACTION, TARGET, VALUE } from './instructions.ts';

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
  /** Replaces NEXT_ACTION in the operation head as one flat instruction (Clef-omni reads that better). */
  compactRules?: string;
  /**
   * Replaces the page-level commit-risk head with one risk question per named click candidate, in a
   * follow-up request: the chosen CLICK only, or the top ranked taps (journey autopilot acts on those).
   */
  elementRisk?: 'chosen' | 'ranked';
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
  /** With `elementRisk`: commit risk per click target index that was asked about. */
  elementRisks?: Record<string, number>;
  requests: number;
  inputTokens: number;
  latencyMs: number;
}

export type Ask = (
  request: SystemOneRequest,
) => Promise<{ answers: Record<string, any>; usage: { input_tokens: number } }>;

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
  let inputTokens = response.usage.input_tokens;

  const followUp = async (questions: Record<string, Question>) => {
    const answer = await ask({ state: request.state, questions });
    requests++;
    inputTokens += answer.usage.input_tokens;
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
  const riskTargets = elementRiskTargets(input, space, decision);
  if (riskTargets.length) {
    const questions = Object.fromEntries(riskTargets.map((index) => [`risk_${index}`, riskQuestion(input, space, index)]));
    followUps.push(
      followUp(questions).then((answers) => {
        decision.elementRisks = Object.fromEntries(riskTargets.map((index) => [index, readRisk(answers[`risk_${index}`])]));
        if (decision.operation === 'CLICK') {
          decision.commitRisk = decision.elementRisks[targetIndexOf(space, 'CLICK', decision.action!)];
        }
      }),
    );
  }
  await Promise.all(followUps);
  return {
    ...decision,
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
  if (input.checkCommitRisk && targets.CLICK && !input.elementRisk) questions.commit_risk = noul({ goal: input.goal, rules: COMMIT_RISK });
  if (input.doneWhen) questions.done_check = noul({ completion_condition: input.doneWhen, rules: DONE_CHECK });
  Object.assign(questions, input.extraQuestions);

  const state = {
    page: pick(input.page, ['url', 'title', 'text']),
    elements,
    supplied_values: input.values,
    recent_actions: input.history.slice(-10),
  };
  // Interfaces lack index signatures, so the plain JSON state needs one cast for the SDK's EntryType.
  return { state: state as unknown as EntryType, questions };
};

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

  const candidates = space.targets[operation as TargetOperation];
  if (candidates) {
    // Unused target heads can never cause an action; only the chosen operation's head is validated.
    const ids = Object.keys(candidates);
    const targetAnswer =
      ids.length === 1
        ? { type: 'choice' as const, choice: ids[0], confidence: 1, probabilities: { [ids[0]]: 1 } }
        : validChoice(answers[`${operation.toLowerCase()}_target`], ids);
    decision.action = candidates[targetAnswer.choice];
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

// The chosen click first, then (for the autopilot) the remaining taps by the target head's ranking.
const elementRiskTargets = (input: DecisionInput, space: ActionSpace, decision: Pick<Decision, 'operation' | 'action' | 'answers'>) => {
  const clicks = space.targets.CLICK;
  if (!input.elementRisk || !input.checkCommitRisk || !clicks) return [];
  const chosen = decision.operation === 'CLICK' ? [targetIndexOf(space, 'CLICK', decision.action!)] : [];
  if (input.elementRisk === 'chosen') return chosen;
  const probabilities: Record<string, number> = decision.answers.click_target?.probabilities ?? {};
  const ranked = Object.keys(clicks).sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0));
  return [...new Set([...chosen, ...ranked])].slice(0, MAX_RISK_TARGETS);
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
