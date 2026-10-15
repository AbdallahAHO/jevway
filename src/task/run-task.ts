import { StalePage, type PageState, type Tab } from '../browser/tab.ts';
import { buildActionSpace } from '../jev/action-space.ts';
import { decide, type Ask, type Candidate, type Decision, type StepRecord } from '../jev/decide.ts';
import type { ImageTransport, ScreenshotMode } from '../jev/model.ts';

export interface TaskOptions {
  goal: string;
  /** Named field values the agent already knows. Jev picks which one to type; nothing else is ever typed. */
  values?: Record<string, string>;
  /** Visible evidence that the task is finished; checked by a separate Jev judgment on DONE. */
  doneWhen?: string;
  /** Maximum executed browser actions per call. */
  maxSteps?: number;
  /** Operation or target confidence below this stops and hands the decision back. */
  minConfidence?: number;
  /**
   * `fallback` re-decides with a marked screenshot when a text-only decision would stop as uncertain or
   * blocked, has DONE rejected, or follows an action that changed nothing. `always` sends one every step.
   */
  screenshots?: ScreenshotMode;
  /** Flat operation rules from the model profile (see ModelProfile.compactRules). */
  compactRules?: string;
  /** Judge commit risk for the chosen click by name (see ModelProfile.elementRisk). */
  elementRisk?: boolean;
  imageTransport?: ImageTransport;
}

export type TaskStatus = 'done' | 'needs_input' | 'needs_confirmation' | 'uncertain' | 'blocked' | 'step_budget';

export interface TaskSummary {
  status: TaskStatus;
  reason: string;
  url: string;
  title: string;
  elapsed_ms: number;
  steps: (StepRecord & { confidence: number })[];
  jev: { requests: number; input_tokens: number; median_latency_ms: number; screenshots: number };
  done_probability?: number;
  /** Present whenever control returns before DONE: what Jev was deciding and what it saw. */
  stuck?: { operation: string; element?: string; candidates: Candidate[]; page_text: string };
}

export interface TraceEntry {
  decision: Omit<Decision, 'action'> & { action?: string };
  executed: boolean;
  elapsed_ms: number;
}

const DEFAULTS = {
  maxSteps: 40,
  minConfidence: 0.3,
  screenshots: 'off' as ScreenshotMode,
  compactRules: '',
  elementRisk: false,
  imageTransport: 'image_url' as ImageTransport,
};
// A DONE the completion check rejects usually means content is still loading: wait and re-decide this many times.
const MAX_REJECTED_DONE = 3;

/**
 * A goal-driven run on one tab. `run()` loops observe → one Jev decision → guarded action until the
 * goal is visibly done or a decision belongs to the calling agent. Call `run()` again after `update()`
 * to continue the same session (e.g. with a missing value or a confirmed irreversible click).
 *
 * @example
 * const task = new BrowserTask(tab, ask, { goal: 'Open the Gödel incompleteness article', doneWhen: 'The article is open' });
 * const summary = await task.run(); // { status: 'done', steps: [...], jev: { requests: 4, ... } }
 */
export class BrowserTask {
  readonly trace: TraceEntry[] = [];
  #options: Required<Omit<TaskOptions, 'doneWhen'>> & Pick<TaskOptions, 'doneWhen'>;
  #history: (StepRecord & { confidence: number })[] = [];
  #latencies: number[] = [];
  #inputTokens = 0;
  #screenshots = 0;
  #confirmedCommit = false;
  #tab: Tab;
  #ask: Ask;

  constructor(tab: Tab, ask: Ask, options: TaskOptions) {
    this.#tab = tab;
    this.#ask = ask;
    this.#options = { ...DEFAULTS, values: {}, ...definedOnly(options) };
  }

  get tab() {
    return this.#tab;
  }

  /** Merge new values, a new goal, or a one-time confirmation for the next irreversible click. */
  update(patch: Partial<TaskOptions> & { confirmIrreversible?: boolean }) {
    const { confirmIrreversible, values, ...options } = patch;
    this.#options = { ...this.#options, ...definedOnly(options), values: { ...this.#options.values, ...values } };
    if (confirmIrreversible) this.#confirmedCommit = true;
  }

  async run(): Promise<TaskSummary> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const { maxSteps, values, doneWhen } = this.#options;
    let page = await this.#tab.observe();
    let executed = 0;
    let decisions = 0;
    let rejectedDone = 0;
    const firstStep = this.#history.length;
    const firstRequest = this.#latencies.length;
    const tokensBefore = this.#inputTokens;
    const screenshotsBefore = this.#screenshots;

    const stop = (status: TaskStatus, reason: string, decision?: Decision): TaskSummary => ({
      status,
      reason,
      url: page.url,
      title: page.title,
      elapsed_ms: elapsed(),
      // Counts cover this call only; the session keeps full history for Jev's context.
      steps: this.#history.slice(firstStep),
      jev: {
        requests: this.#latencies.length - firstRequest,
        input_tokens: this.#inputTokens - tokensBefore,
        median_latency_ms: median(this.#latencies.slice(firstRequest)),
        screenshots: this.#screenshots - screenshotsBefore,
      },
      ...(decision?.doneProbability !== undefined && { done_probability: round(decision.doneProbability) }),
      ...(status !== 'done' && decision && { stuck: stuckOn(decision, page) }),
    });

    while (executed < maxSteps) {
      if (++decisions > maxSteps * 2) return stop('step_budget', `Made ${maxSteps * 2} decisions without finishing`);
      let decision: Decision;
      try {
        decision = await this.#decide(page);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        page = await this.#tab.observe();
        continue;
      }
      const record = (didExecute: boolean) =>
        this.trace.push({
          decision: { ...decision, action: decision.action?.label },
          executed: didExecute,
          elapsed_ms: elapsed(),
        });

      if (decision.operation === 'DONE' && doneWhen && (decision.doneProbability ?? 0) < 0.5) {
        record(false);
        if (++rejectedDone >= MAX_REJECTED_DONE) {
          return stop('uncertain', `Jev chose DONE ${rejectedDone}× but "${doneWhen}" is not visible`, decision);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        page = await this.#tab.observe();
        continue;
      }

      const handBack = this.#handBack(decision);
      if (handBack) {
        // A stop decided on a page that has since changed is stale: re-observe instead of reporting it.
        if (!(await this.#tab.fresh(page))) {
          record(false);
          page = await this.#tab.observe();
          continue;
        }
        record(false);
        return stop(handBack[0], handBack[1], decision);
      }

      const action = decision.action!;
      const text = decision.valueKey ? values[decision.valueKey] : undefined;
      try {
        await this.#tab.act(action, page, text);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        record(false);
        page = await this.#tab.observe();
        continue;
      }
      record(true);
      executed++;
      // A confirmation covers exactly one risky click.
      if (isRiskyClick(decision)) this.#confirmedCommit = false;

      const before = page.fingerprint;
      page = await this.#tab.observe();
      this.#history.push({
        operation: decision.operation,
        element: action.label,
        ...(decision.valueKey && { value_key: decision.valueKey }),
        page_changed: page.fingerprint !== before,
        confidence: round(Math.min(decision.confidence, decision.targetConfidence ?? 1)),
      });
      if (repeatingWithoutEffect(this.#history)) {
        return stop('blocked', 'The last 3 actions did not change the page', decision);
      }
    }
    return stop('step_budget', `Reached ${maxSteps} actions without finishing`);
  }

  // One decision per step; `fallback` takes a second, screenshot-backed look at a shaky or stalled one.
  async #decide(page: PageState): Promise<Decision> {
    const { goal, values, doneWhen, screenshots, compactRules, elementRisk, imageTransport } = this.#options;
    const decideOn = async (withScreenshot: boolean) => {
      const screenshot = withScreenshot
        ? await this.#tab.markedScreenshot(buildActionSpace(page.actions).marks, page)
        : undefined;
      const decision = await decide(this.#ask, {
        page,
        goal,
        values,
        history: this.#history.slice(-10),
        doneWhen,
        checkCommitRisk: true,
        screenshot,
        compactRules,
        imageTransport,
        ...(elementRisk && { elementRisk: 'chosen' as const }),
      });
      this.#latencies.push(decision.latencyMs);
      this.#inputTokens += decision.inputTokens;
      if (screenshot) this.#screenshots++;
      return decision;
    };
    const first = await decideOn(screenshots === 'always');
    return screenshots === 'fallback' && this.#needsSecondLook(first) ? decideOn(true) : first;
  }

  #needsSecondLook(decision: Decision) {
    const { doneWhen } = this.#options;
    const handBack = this.#handBack(decision)?.[0];
    const last = this.#history.at(-1);
    return (
      handBack === 'uncertain' ||
      handBack === 'blocked' ||
      (decision.operation === 'DONE' && !!doneWhen && (decision.doneProbability ?? 0) < 0.5) ||
      (last?.page_changed === false && last.operation !== 'WAIT')
    );
  }

  // Returns [status, reason] when this decision is the calling agent's to make.
  #handBack(decision: Decision): [TaskStatus, string] | undefined {
    const { minConfidence, doneWhen } = this.#options;
    if (decision.operation === 'DONE') {
      return [
        'done',
        doneWhen ? `Completion condition verified: ${doneWhen}` : 'Jev judged every requirement visibly satisfied',
      ];
    }
    if (decision.operation === 'BLOCKED') {
      if (decision.fieldsWithoutValue.length) {
        return [
          'needs_input',
          `Blocked: no supplied value for ${decision.fieldsWithoutValue.map((f) => `"${f}"`).join(', ')}`,
        ];
      }
      return ['blocked', 'No supported operation can make progress on this page'];
    }
    const confidence = Math.min(decision.confidence, decision.targetConfidence ?? 1);
    if (confidence < minConfidence) {
      return [
        'uncertain',
        `Next step "${decision.operation} ${decision.action?.label ?? ''}" had confidence ${round(confidence)}`,
      ];
    }
    if (decision.operation === 'TYPE_TEXT' && !decision.valueKey) {
      return ['needs_input', `No supplied value fits the field "${decision.action!.label}"`];
    }
    if (isRiskyClick(decision) && !this.#confirmedCommit) {
      return [
        'needs_confirmation',
        `Clicking "${decision.action!.label}" looks irreversible (risk ${round(decision.commitRisk!)})`,
      ];
    }
    return undefined;
  }
}

// Optional MCP/CLI arguments arrive as explicit undefined; they must not erase defaults or earlier values.
const definedOnly = <T extends object>(options: T) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;

const isRiskyClick = (decision: Decision) => decision.operation === 'CLICK' && (decision.commitRisk ?? 0) >= 0.5;

const stuckOn = (decision: Decision, page: PageState) => ({
  operation: decision.operation,
  ...(decision.action && { element: decision.action.label }),
  candidates: decision.candidates,
  page_text: page.text.slice(0, 800),
});

const repeatingWithoutEffect = (history: StepRecord[]) => {
  const last = history.slice(-3);
  return last.length === 3 && last.every((step) => step.page_changed === false && step.operation !== 'WAIT');
};

const median = (numbers: number[]) => {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const round = (value: number) => Math.round(value * 1000) / 1000;
