import { StalePage, TargetUnreachable, type PageAction, type PageState, type Tab } from '../browser/tab.ts';
import { buildActionSpace } from '../jev/action-space.ts';
import { centerOf, contains } from '../jev/box.ts';
import { decide, type Ask, type Candidate, type Decision, type StepRecord } from '../jev/decide.ts';
import type { ImageTransport, ScreenshotMode } from '../jev/model.ts';
import { Recording } from './recording.ts';

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
  /** With `elementRisk`, also ask the page-level question and take the higher risk (see ModelProfile.pageRisk). */
  pageRisk?: boolean;
  imageTransport?: ImageTransport;
  /** Box checks on screenshot decisions (see ModelProfile.box). */
  box?: boolean;
  /**
   * Opt-in: when Jev is BLOCKED and the screenshot shows a control the DOM reader never reported (canvas,
   * iframe), click the centre of its box after a hit-test. Off by default: it is the one path where model
   * output becomes a coordinate. Still gated by commit risk.
   */
  allowCoordinateClicks?: boolean;
  /** After an action that changed nothing yet, or a WAIT, keep observing up to this long for the page to change before deciding again. */
  changeWaitMs?: number;
  /** Save a sharp screenshot before every action, plus the final page and an index.html viewer, here. */
  recordDir?: string;
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
  pageRisk: false,
  imageTransport: 'image_url' as ImageTransport,
  box: false,
  allowCoordinateClicks: false,
  changeWaitMs: 1500,
};
// How often a page that has not reacted yet is looked at again while waiting for it to change.
const CHANGE_POLL_MS = 150;
/**
 * Loop guards, measured on Jev 1.14 against the Langfuse demo suite (2026-10-15, 3 runs per job). Provisional:
 * revisit with the 10-run variance data before changing; other models must not inherit retuned values blindly.
 */
const GUARDS = {
  // ...or this sure on doneSustained consecutive decisions: steady evidence, where a single spike isn't (see DONE_EVIDENT).
  doneSteady: 0.75,
  doneSustained: 3,
  // A target the page keeps covering (an open popover, a sticky bar): told to Jev on the 2nd miss, handed back on this one.
  maxUnreachable: 3,
  // This many executed actions in a row below wanderConfidence means Jev is exploring, not progressing: hand back.
  wanderSteps: 6,
  wanderConfidence: 0.5,
  // The same element acted on this many times within the last repeatWindow actions is a loop, whatever the page does.
  repeatLimit: 6,
  repeatWindow: 7,
  // The same action this many times, with the page flipping between two states each time, is a toggle loop.
  toggleLoop: 4,
} as const;
// A DONE the completion check rejects usually means content is still loading: wait and re-decide this many times.
const MAX_REJECTED_DONE = 3;
// Box answers count only when the model is at least this sure a control is there and where it is.
const BOX_SURE = 0.5;
// The chosen target counts as covered on screen below this visibility (dense grids of outlines score 0.15–0.3).
const COVERED_BELOW = 0.1;
// ...and only when its box also barely overlaps where the DOM puts it.
const COVERED_OVERLAP_BELOW = 0.1;
// A `done_when` judgment this sure ends the task, whatever the next-step head prefers (it may wander on).
const DONE_EVIDENT = 0.9;
// Enter is offered only after typing into a field like these; elsewhere it could submit a form.
const SEARCH_LIKE = /search|query|find/i;
// A covered target is fed back as history so Jev can clear it (dismiss a popover); this many times per run.
const MAX_COVERED_RETRIES = 2;
const ESCAPE: PageAction = { id: 'press_escape', kind: 'escape', label: 'Press Escape to close the open menu, popover or suggestion list' };
// Boxes on small targets land a row off (13 px checkboxes); pad before asking whether one covers the chosen control.
const BOX_PADDING = 16;
// A model call that fails like this (5xx, rate limit, network, timeout) is retried once; any other error is final.
const TRANSIENT_MODEL_ERROR = /^(5\d\d|429)\b|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i;
// Pause before that one retry, so a rate limit or a restarting upstream has a moment to clear.
const MODEL_RETRY_MS = 800;
// Stands in for the page in a summary when the very first observe fails.
const BLANK_PAGE: PageState = {
  url: '',
  title: '',
  text: '',
  w: 0,
  h: 0,
  actions: [],
  marker: null,
  page_key: null,
  guards: {},
  omitted_actions: 0,
  fingerprint: '',
};

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
  #options: Required<Omit<TaskOptions, 'doneWhen' | 'recordDir'>> & Pick<TaskOptions, 'doneWhen'>;
  #history: (StepRecord & { confidence: number })[] = [];
  #latencies: number[] = [];
  #inputTokens = 0;
  #screenshots = 0;
  #confirmedCommit = false;
  /** The search-like field typed into by the last executed action, if any: PRESS_ENTER may submit it. */
  #lastTyped: PageAction | undefined;
  /** Consecutive misses on the same target node because it couldn't be reached on an unchanged page. */
  #unreachable = { node: undefined as number | undefined, count: 0 };
  /** Each executed action and the page fingerprint right after it, to spot one that toggles in place. */
  #outcomes: { action: string; print: string }[] = [];
  #tab: Tab;
  #ask: Ask;
  #recording: Recording | undefined;

  constructor(tab: Tab, ask: Ask, { recordDir, ...options }: TaskOptions) {
    this.#tab = tab;
    this.#ask = ask;
    this.#options = { ...DEFAULTS, values: {}, ...definedOnly(options) };
    if (recordDir) this.#recording = new Recording(recordDir);
  }

  get tab() {
    return this.#tab;
  }

  /** Merge new values, a new goal, or a one-time confirmation for the next irreversible click. */
  update(patch: Partial<TaskOptions> & { confirmIrreversible?: boolean }) {
    const { confirmIrreversible, values, recordDir: _recordDir, ...options } = patch;
    this.#options = { ...this.#options, ...definedOnly(options), values: { ...this.#options.values, ...values } };
    if (confirmIrreversible) this.#confirmedCommit = true;
  }

  async run(): Promise<TaskSummary> {
    await this.#recording?.start(this.#tab);
    const summary = await this.#loop();
    await this.#recording?.finish(this.#tab, summary);
    return summary;
  }

  async #loop(): Promise<TaskSummary> {
    this.#tab.want(Object.values(this.#options.values));
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const { maxSteps, values, doneWhen } = this.#options;
    // `stop` reads the page, so it needs a stand-in until the first observe succeeds.
    let page: PageState = BLANK_PAGE;
    let executed = 0;
    let decisions = 0;
    let rejectedDone = 0;
    let coveredRetries = 0;
    let doneStreak = 0;
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

    // Browser and model errors end the run as `blocked`: the calling agent keeps the session and decides what next.
    try {
      page = await this.#tab.observe();
      while (executed < maxSteps) {
        if (++decisions > maxSteps * 2) return stop('step_budget', `Made ${maxSteps * 2} decisions without finishing`);
        let decision: Decision;
        try {
          decision = await this.#decideWithRetry(page);
        } catch (error) {
          if (!(error instanceof StalePage)) throw error;
          page = await this.#tab.observe();
          continue;
        }
        const doneProbability = decision.doneProbability ?? 0;
        doneStreak = doneProbability >= GUARDS.doneSteady ? doneStreak + 1 : 0;
        if (doneWhen && (doneProbability >= DONE_EVIDENT || doneStreak >= GUARDS.doneSustained)) {
          this.trace.push({ decision: { ...decision, action: decision.action?.label }, executed: false, elapsed_ms: elapsed() });
          return stop('done', `Completion condition verified: ${doneWhen}`, decision);
        }
        const record = (didExecute: boolean) =>
          this.trace.push({
            decision: { ...decision, action: decision.action?.label },
            executed: didExecute,
            elapsed_ms: elapsed(),
          });

        decision = this.#boxRescue(decision, page);
        if (decision.operation === 'DONE' && doneWhen && (decision.doneProbability ?? 0) < 0.5) {
          record(false);
          if (++rejectedDone >= MAX_REJECTED_DONE) {
            return stop('uncertain', `Jev chose DONE ${rejectedDone}× but "${doneWhen}" is not visible`, decision);
          }
          // Jev learns its DONE was premature, instead of proposing the same DONE on the same evidence.
          this.#history.push({
            operation: 'DONE',
            element: '',
            not_executed: `rejected: "${doneWhen}" is not visible yet; keep working toward it`,
            confidence: round(decision.confidence),
          });
          await new Promise((resolve) => setTimeout(resolve, 300));
          page = await this.#tab.observe();
          continue;
        }

        if (this.#looksCovered(decision) && coveredRetries++ < MAX_COVERED_RETRIES) {
          record(false);
          this.#history.push({
            operation: decision.operation,
            element: decision.action!.label,
            not_executed: 'covered on screen by another layer; clear it first',
            confidence: round(decision.confidence),
          });
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
        let element: string;
        try {
          await this.#recording?.step(
            this.#tab,
            page,
            {
              operation: decision.operation,
              element: action.label,
              valueKey: decision.valueKey ?? undefined,
              option: action.kind === 'select' ? String(action.value) : undefined,
              confidence: round(Math.min(decision.confidence, decision.targetConfidence ?? 1)),
            },
            decision.operation === 'CLICK_AT' ? decision.nextClick!.rect : action.rect,
          );
          if (decision.operation === 'CLICK_AT') {
            const point = centerOf(decision.nextClick!.rect);
            element = `${await this.#tab.clickAt(point, page)} @ ${Math.round(point.x)},${Math.round(point.y)}`;
          } else {
            await this.#tab.act(action, page, text);
            element = action.label;
          }
        } catch (error) {
          if (!(error instanceof StalePage)) throw error;
          record(false);
          if (!(error instanceof TargetUnreachable)) {
            this.#recording?.discardLast();
            page = await this.#tab.observe();
            continue;
          }
          // Unreachable on an unchanged page: retrying blind repeats the same miss, so Jev has to hear about it.
          this.#recording?.markUnreachable();
          // An open popup over the target (search suggestions, a menu) is closed with the fixed Escape key, once per
          // target, as a person would; no model output is involved. Then Jev re-decides on the cleared page.
          const popupOpen = error.byPopup || page.actions.some((a) => a.expanded === 'true');
          if (this.#unreachable.node !== action.node && popupOpen) {
            this.#unreachable = { node: action.node, count: 1 };
            await this.#recording?.step(this.#tab, page, { operation: 'PRESS_ESCAPE' });
            await this.#tab.dismissPopup();
            this.#history.push({
              operation: 'PRESS_ESCAPE',
              element: `closed the open popup covering "${action.label.slice(0, 80)}"`,
              page_changed: true,
              confidence: 1,
            });
            page = await this.#tab.observe();
            continue;
          }
          const misses = this.#unreachable.node === action.node ? this.#unreachable.count + 1 : 1;
          this.#unreachable = { node: action.node, count: misses };
          if (misses >= GUARDS.maxUnreachable) {
            return stop('blocked', `"${action.label}" could not be reached ${misses} times: something on the page covers it`, decision);
          }
          if (misses === 2) {
            this.#history.push({
              operation: decision.operation,
              element: action.label,
              not_executed: 'could not be reached: another layer covers it; close that layer first',
              confidence: round(decision.confidence),
            });
          }
          page = await this.#tab.observe();
          continue;
        }
        record(true);
        executed++;
        this.#unreachable = { node: undefined, count: 0 };
        this.#lastTyped = decision.operation === 'TYPE_TEXT' && isSearchLike(action) ? action : undefined;
        // A confirmation covers exactly one risky click.
        if (isRiskyClick(decision)) this.#confirmedCommit = false;

        const before = page.fingerprint;
        page = await this.#tab.observe();
        // A slow click handler or a loading page hasn't reacted yet: a person waits a moment before trying again.
        if (page.fingerprint === before) page = await this.#awaitChange(before, page);
        const field = decision.operation === 'TYPE_TEXT' && page.actions.find((a) => a.kind === 'fill' && a.node === action.node);
        this.#history.push({
          operation: decision.operation,
          element,
          ...(decision.valueKey && { value_key: decision.valueKey }),
          // A field that is gone (navigated, submitted) can't say; one still on the page must show what was typed.
          ...(field && { value_kept: field.value === text }),
          page_changed: page.fingerprint !== before,
          confidence: round(Math.min(decision.confidence, decision.targetConfidence ?? 1)),
        });
        if (repeatingWithoutEffect(this.#history)) {
          return stop('blocked', 'The last 3 actions did not change the page', decision);
        }
        if (wandering(this.#history.slice(firstStep))) {
          return stop('uncertain', `Jev was unsure for ${GUARDS.wanderSteps} actions in a row (confidence under ${GUARDS.wanderConfidence})`, decision);
        }
        // Waiting is bounded by maxSteps and the wander guard; a shimmering skeleton must not look like a toggle loop.
        if (decision.operation !== 'WAIT') this.#outcomes.push({ action: `${decision.operation} ${element}`, print: page.fingerprint });
        if (togglingInPlace(this.#outcomes)) {
          return stop('blocked', `"${element}" only toggles the page back and forth (${GUARDS.toggleLoop}× in a row)`, decision);
        }
        if (repeating(this.#outcomes)) {
          return stop('blocked', `"${element}" was used ${GUARDS.repeatLimit} times in ${GUARDS.repeatWindow} actions without finishing`, decision);
        }
      }
      return stop('step_budget', `Reached ${maxSteps} actions without finishing`);
    } catch (error) {
      return stop('blocked', describeError(error));
    }
  }

  // Keeps observing a page that still looks like `before`; stops at the first change or after changeWaitMs.
  async #awaitChange(before: string, page: PageState): Promise<PageState> {
    const deadline = performance.now() + this.#options.changeWaitMs;
    while (page.fingerprint === before && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CHANGE_POLL_MS));
      page = await this.#tab.observe();
    }
    return page;
  }

  // A transient model error (5xx, 429, network, timeout) gets one more try; any other error ends the run.
  async #decideWithRetry(page: PageState): Promise<Decision> {
    try {
      return await this.#decide(page);
    } catch (error) {
      if (!(error instanceof ModelCallError) || !TRANSIENT_MODEL_ERROR.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, MODEL_RETRY_MS));
      return this.#decide(page);
    }
  }

  // One decision per step; `fallback` takes a second, screenshot-backed look at a shaky or stalled one.
  async #decide(page: PageState): Promise<Decision> {
    const { goal, values, doneWhen, screenshots, compactRules, elementRisk, pageRisk, imageTransport, box } = this.#options;
    const decideOn = async (withScreenshot: boolean) => {
      const screenshot = withScreenshot
        ? await this.#tab.markedScreenshot(buildActionSpace(page.actions).marks, page)
        : undefined;
      const decision = await decide(this.#ask, {
        page: this.#withKeys(page),
        goal,
        values,
        history: this.#history.slice(-10),
        doneWhen,
        checkCommitRisk: true,
        screenshot,
        compactRules,
        imageTransport,
        box,
        ...(elementRisk && { elementRisk: 'chosen' as const, pageRisk }),
      }).catch((error) => {
        // Only the model call is tagged: a failed screenshot above is a browser error and keeps its own type.
        throw new ModelCallError(messageOf(error));
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

  // Fixed keys: right after typing into a search-like field that is still there, Enter can submit it (GitHub, npm,
  // Booking); while something is expanded, Escape can close it.
  #withKeys(page: PageState): PageState {
    const field = this.#lastTyped;
    const keys: PageAction[] = [];
    if (field && page.actions.some((action) => action.kind === 'fill' && action.node === field.node)) {
      keys.push({ id: 'press_enter', kind: 'enter', node: field.node, label: `Press Enter in "${field.label}" to submit what was typed` });
    }
    // Only while something is expanded (a menu, popover, suggestion list) can Escape close it.
    if (page.actions.some((action) => action.expanded === 'true')) keys.push(ESCAPE);
    return keys.length ? { ...page, actions: [...page.actions, ...keys] } : page;
  }

  // Stuck (BLOCKED, or DONE that the completion check rejects) or unsure, but the screenshot confidently shows a
  // control worth clicking: click the observed element the box points at, or (opt-in, stuck only) the box itself
  // when the DOM reader never reported that control.
  #boxRescue(decision: Decision, page: PageState): Decision {
    const next = decision.nextClick;
    if (!next || next.present < BOX_SURE || next.confidence < BOX_SURE) return decision;
    const rejectedDone =
      decision.operation === 'DONE' && !!this.#options.doneWhen && (decision.doneProbability ?? 0) < 0.5;
    const blocked = rejectedDone || (decision.operation === 'BLOCKED' && !decision.fieldsWithoutValue.length);
    const unsure = !blocked && this.#lowConfidence(decision);
    if (!blocked && !unsure) return decision;
    if (unsure && !next.match) return decision;
    const rescued = {
      ...decision,
      via: 'box' as const,
      confidence: Math.min(next.present, next.confidence),
      targetConfidence: undefined,
      commitRisk: next.commitRisk,
    };
    if (next.match) {
      const action = buildActionSpace(page.actions).targets.CLICK![next.match];
      return { ...rescued, operation: 'CLICK', action, target: next.match };
    }
    return this.#options.allowCoordinateClicks ? { ...rescued, operation: 'CLICK_AT' } : decision;
  }

  // The screenshot disagrees with the chosen click, or shows it covered: the agent should look.
  #boxStop(decision: Decision): [TaskStatus, string] | undefined {
    if (decision.operation !== 'CLICK' || decision.via) return undefined;
    const label = decision.action!.label;
    const next = decision.nextClick;
    // A box that also covers the chosen element's centre is loose, not a disagreement.
    const padded = next && {
      x: next.rect.x - BOX_PADDING,
      y: next.rect.y - BOX_PADDING,
      w: next.rect.w + 2 * BOX_PADDING,
      h: next.rect.h + 2 * BOX_PADDING,
    };
    const coversChosen = padded && decision.action!.rect && contains(padded, centerOf(decision.action!.rect));
    const sure = next && next.present >= BOX_SURE && next.confidence >= BOX_SURE;
    if (next?.match && next.match !== decision.target && sure && !coversChosen) {
      return ['uncertain', `Jev chose "${label}", but the screenshot points at "${next.matchLabel}"`];
    }
    if (this.#looksCovered(decision)) {
      return ['uncertain', `"${label}" looks covered on screen (visible ${round(decision.targetCheck!.visible)})`];
    }
    return undefined;
  }

  #lowConfidence(decision: Decision) {
    if (['DONE', 'BLOCKED'].includes(decision.operation)) return false;
    return Math.min(decision.confidence, decision.targetConfidence ?? 1) < this.#options.minConfidence;
  }

  // Both signals must agree: judged hidden, and boxed somewhere other than where the DOM puts it.
  #looksCovered(decision: Decision) {
    const check = decision.targetCheck;
    return decision.operation === 'CLICK' && !!check && check.visible < COVERED_BELOW && check.overlap < COVERED_OVERLAP_BELOW;
  }

  // Returns [status, reason] when this decision is the calling agent's to make.
  #handBack(decision: Decision): [TaskStatus, string] | undefined {
    const { doneWhen } = this.#options;
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
    const boxStop = this.#boxStop(decision);
    if (boxStop) return boxStop;
    // Waiting can't hurt: an unsure WAIT just waits (the wander guard and step budget still bound it).
    if (this.#lowConfidence(decision) && decision.operation !== 'WAIT') {
      const confidence = Math.min(decision.confidence, decision.targetConfidence ?? 1);
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
        `Clicking "${decision.action?.label ?? 'the control boxed on the screenshot'}" looks irreversible (risk ${round(decision.commitRisk!)})`,
      ];
    }
    return undefined;
  }
}

// Optional MCP/CLI arguments arrive as explicit undefined; they must not erase defaults or earlier values.
const definedOnly = <T extends object>(options: T) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;

const isSearchLike = (field: PageAction) =>
  ['searchbox', 'combobox'].includes(field.role ?? '') || SEARCH_LIKE.test(field.label);

const isRiskyClick = (decision: Decision) =>
  ['CLICK', 'CLICK_AT'].includes(decision.operation) && (decision.commitRisk ?? 0) >= 0.5;

const stuckOn = (decision: Decision, page: PageState) => ({
  operation: decision.operation,
  ...(decision.action && { element: decision.action.label }),
  candidates: decision.candidates,
  page_text: page.text.slice(0, 800),
});

const wandering = (history: { confidence: number; not_executed?: string }[]) => {
  const executed = history.filter((step) => !step.not_executed).slice(-GUARDS.wanderSteps);
  return executed.length === GUARDS.wanderSteps && executed.every((step) => step.confidence < GUARDS.wanderConfidence);
};
const repeating = (outcomes: { action: string }[]) => {
  const last = outcomes.slice(-GUARDS.repeatWindow);
  const latest = last.at(-1)?.action;
  return last.filter((o) => o.action === latest).length >= GUARDS.repeatLimit;
};
// The same action over and over while the page flips A, B, A, B: a menu opened and closed, a toggle flipped.
const togglingInPlace = (outcomes: { action: string; print: string }[]) => {
  const last = outcomes.slice(-GUARDS.toggleLoop);
  return (
    last.length === GUARDS.toggleLoop &&
    last.every((o) => o.action === last[0].action) &&
    last.every((o, i) => i < 2 || o.print === last[i - 2].print)
  );
};
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

/** An error raised by the model call, as opposed to the browser. */
class ModelCallError extends Error {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Anything that is not a model error came from the tab (CDP, page never settling, an unconfirmed action).
const describeError = (error: unknown) =>
  `${error instanceof ModelCallError ? 'Model' : 'Browser'} error: ${messageOf(error).slice(0, 200)}`;
