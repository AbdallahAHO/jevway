import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CdpConnection } from '../browser/cdp.ts';
import { DEVICES, type Device, type DeviceName } from '../browser/devices.ts';
import { StalePage, Tab, type PageAction, type PageState } from '../browser/tab.ts';
import { buildActionSpace, type ActionSpace } from '../jev/action-space.ts';
import { decide, type Ask, type Decision, type StepRecord } from '../jev/decide.ts';
import type { ScreenshotMode } from '../jev/model.ts';
import { watchDiagnostics, type DiagnosticsWatcher } from './diagnostics.ts';
import { buildFlows, hotspotOf, type JourneyDoc, type JourneyStep } from './journey-doc.ts';
import { pickNextMove } from './pick-next-move.ts';
import { renderViewer } from './render-viewer.ts';
import {
  qaFindings,
  readScreenJudgments,
  screenQuestions,
  type QaFinding,
  type ScreenJudgments,
  type VisitedScreen,
} from './screen-judgments.ts';

const EXPLORE_GOAL = `Explore this site the way a first-time mobile visitor would, one screen at a time.
Open the next screen that matters most for the site's core user journeys: discovering, searching, comparing,
and evaluating its main offering. Prefer primary navigation, search, results, and detail screens over legal,
footer, social, app-download, or external links. Dismiss blocking banners. Never log in, pay, or submit personal data.`;

export interface JourneyOptions {
  startUrl: string;
  device?: DeviceName;
  /** Focus exploration on one journey ("book a stay for 2 in Lisbon"). Without it, Jev explores core journeys. */
  intent?: string;
  /** Text Jev may type while on autopilot. */
  values?: Record<string, string>;
  outDir: string;
  newWindow?: boolean;
  /** Autopilot backs out of any page whose URL does not start with this (default: the start page's origin). */
  stayWithin?: string;
  /** Any mode but `off` sends every screen's marked screenshot with its judgments (screen type, patterns, QA). */
  screenshots?: ScreenshotMode;
  /** Score every ranked tap's commit risk by name (see ModelProfile.elementRisk). */
  elementRisk?: boolean;
  /** Flat operation rules from the model profile (see ModelProfile.compactRules). */
  compactRules?: string;
}

export interface StepInput {
  /** Element index (or `3:2` for a dropdown option), `back`, `restart`, `scroll_down`, `scroll_up`, or `screen:s04` to replay the path to a screen. */
  next: string | number;
  /** Text to type when `next` is a text field. */
  value?: string;
  /** Flow this step belongs to, e.g. "Homes/Searching homes". Sticks for following steps. */
  flow?: string;
  /** What the agent learned on the screen it is leaving. */
  insight?: string;
  /** Agent-written description of the screen it is leaving. */
  description?: string;
}

export type ScreenReport = ReturnType<JourneySession['report']>;

/**
 * A mobile user-journey mapping session: every screen is screenshotted, understood by Jev (type, patterns,
 * duplicates, QA states, ranked next steps) and written to `journey.json` + `index.html` after each move.
 * The agent steers with `step()` or lets Jev drive with `autopilot()`.
 *
 * @example
 * const journey = await JourneySession.start(cdp, ask, { startUrl: 'https://example.com', outDir: 'journeys/example' });
 * journey.report();                                   // screen s01 + Jev's suggested next tap
 * await journey.step({ next: 4, flow: 'Search', insight: 'Search is a full-screen sheet' });
 * await journey.autopilot({ screens: 5, flow: 'Search/Results' });
 * journey.finish();                                   // → journey.json, index.html, screens/*.png
 */
export class JourneySession {
  readonly doc: JourneyDoc;
  readonly outDir: string;
  #tab: Tab;
  #ask: Ask;
  #device: Device;
  #options: JourneyOptions;
  #diagnostics: DiagnosticsWatcher;
  #page!: PageState;
  #decision!: Decision;
  #judgments!: ScreenJudgments;
  #current = '';
  #lastIsNew = true;
  #lastFlow = 'Main';
  #recent: StepRecord[] = [];
  #paths = new Map<string, JourneyStep[]>();
  #contentKeys = new Map<string, string>();
  #excerpts = new Map<string, string>();
  #tried = new Map<string, Set<string>>();
  #skippedRisky: string[] = [];
  #moves: { move: string; element?: string; screen: string }[] = [];
  // History index of the start page: "back" never leaves the site for the blank tab it was opened from.
  #startHistoryIndex = 0;

  private constructor(tab: Tab, ask: Ask, diagnostics: DiagnosticsWatcher, options: JourneyOptions, device: Device) {
    this.#tab = tab;
    this.#ask = ask;
    this.#diagnostics = diagnostics;
    this.#options = options;
    this.#device = device;
    this.outDir = resolve(options.outDir);
    this.doc = {
      site: new URL(options.startUrl).host,
      startUrl: options.startUrl,
      device: device.name,
      ...(options.intent && { intent: options.intent }),
      createdAt: new Date().toISOString(),
      screens: [],
      steps: [],
      flows: [],
    };
    mkdirSync(join(this.outDir, 'screens'), { recursive: true });
  }

  static async start(cdp: CdpConnection, ask: Ask, options: JourneyOptions) {
    const device = DEVICES[options.device ?? 'iphone-15'];
    const tab = await Tab.open(cdp, 'about:blank', { device, newWindow: options.newWindow });
    const diagnostics = await watchDiagnostics(tab);
    const session = new JourneySession(tab, ask, diagnostics, options, device);
    await tab.navigate(options.startUrl);
    session.#startHistoryIndex = (await tab.send('Page.getNavigationHistory')).currentIndex;
    await session.#capture(null);
    return session;
  }

  get tab() {
    return this.#tab;
  }

  /** The agent's view of the current screen: identity, Jev's understanding and suggestion, QA, element table. */
  report() {
    const screen = this.#screen(this.#current);
    const space = buildActionSpace(this.#page.actions);
    const decision = this.#decision;
    return {
      screen: {
        id: screen.id,
        is_new: this.#lastIsNew,
        url: this.#page.url,
        title: this.#page.title,
        type: screen.type,
        type_confidence: round(screen.typeConfidence),
        patterns: screen.patterns,
      },
      screenshot: join(this.outDir, screen.screenshot),
      qa: screen.qa,
      jev: {
        suggests: {
          operation: decision.operation,
          ...(decision.action && { index: targetKeyOf(space, decision.action), element: decision.action.label }),
          ...(decision.valueKey && { value_key: decision.valueKey }),
          confidence: round(Math.min(decision.confidence, decision.targetConfidence ?? 1)),
        },
        ranked_taps: rankedTaps(decision, space),
        commit_risk: round(decision.commitRisk ?? 0),
        auth_wall: round(this.#judgments.authWall),
        latency_ms: decision.latencyMs,
      },
      elements: elementTable(space, this.#page),
      progress: {
        screens: this.doc.screens.length,
        steps: this.doc.steps.length,
        flows: [...new Set(this.doc.steps.map((step) => step.flow))],
        viewer: join(this.outDir, 'index.html'),
      },
    };
  }

  /** A downscaled JPEG of the viewport for multimodal agents (full-resolution PNGs are on disk). */
  preview() {
    return this.#tab.screenshot({ format: 'jpeg', quality: 55, scale: 0.5 });
  }

  async step(input: StepInput) {
    this.annotate(this.#current, input);
    const flow = input.flow ?? this.#lastFlow;
    this.#lastFlow = flow;
    const next = String(input.next);

    if (next === 'back') return this.#goBack();
    if (next === 'restart') {
      await this.#tab.navigate(this.#options.startUrl);
      await this.#capture(null);
      return this.report();
    }
    if (next.startsWith('screen:')) {
      await this.#replayTo(next.slice('screen:'.length));
      await this.#capture(null);
      return this.report();
    }

    const space = buildActionSpace(this.#page.actions);
    const control = space.controls[next.toUpperCase()];
    if (control) {
      await this.#tab.act(control, this.#page);
      await this.#capture(null);
      return this.report();
    }
    const target = resolveTarget(space, next, input.value);
    try {
      await this.#tab.act(target.action, this.#page, input.value);
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
      await this.#capture(null);
      return {
        ...this.report(),
        warning: 'The page changed before the tap, so nothing was tapped. This is the fresh screen.',
      };
    }
    return this.#arrive(target.action, target.operation, flow, 'agent', input.value, input.insight);
  }

  /**
   * Jev drives: follow its ranked next steps, skip tried taps and off-site links, back out of explored screens,
   * and stop at auth walls, irreversible actions, a reached intent, or after `screens` new screens.
   */
  async autopilot({ screens = 6, flow, intent }: { screens?: number; flow?: string; intent?: string }) {
    if (intent && intent !== this.#options.intent) {
      this.#options.intent = intent;
      // A new goal re-opens taps that were already tried while pursuing a different one.
      this.#tried.clear();
      await this.#capture(null);
    }
    const flowName = flow ?? this.#options.intent ?? 'Explore';
    const discovered: { id: string; type: string; title: string; via: string }[] = [];
    this.#skippedRisky = [];
    this.#moves = [];
    const hasIntent = Boolean(this.#options.intent);

    // No move cap: an intent run ends only when the intent is reached, a stop condition hits, or every
    // candidate is exhausted. Without an intent, `screens` new screens is the check-in point.
    while (hasIntent || discovered.length < screens) {
      const tried = this.#triedOn(this.#current);
      const move = pickNextMove({
        decision: this.#decision,
        judgments: this.#judgments,
        space: buildActionSpace(this.#page.actions),
        tried,
        hasIntent,
      });
      if ('stop' in move) return this.#autopilotResult(move.stop, discovered, move.detail);
      if (move.move === 'skip_risky') {
        tried.add(move.key);
        this.#skippedRisky.push(move.label);
        this.#logMove('skip_irreversible', move.label);
        continue;
      }
      if (move.move === 'back') {
        if (await this.#canGoBack()) {
          await this.#goBack();
          this.#logMove('back');
        } else if (this.#current !== this.doc.screens[0].id) {
          // Sheets and SPA views often add no history entry: reload the start page and keep exploring from there.
          await this.#tab.navigate(this.#options.startUrl);
          await this.#capture(null);
          this.#logMove('restart');
        } else {
          return this.#autopilotResult('exhausted', discovered);
        }
        continue;
      }

      tried.add(move.key);
      const text = move.valueKey ? this.#options.values?.[move.valueKey] : undefined;
      try {
        await this.#tab.act(move.action, this.#page, text);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        await this.#capture(null);
        this.#logMove('stale_retry', move.action.label);
        continue;
      }
      const scope = this.#options.stayWithin ?? new URL(this.#options.startUrl).origin;
      if (!(await this.#tab.observe()).url.startsWith(scope)) {
        await this.#goBack();
        this.#logMove('left_scope', move.action.label);
        continue;
      }
      const from = this.#current;
      await this.#arrive(move.action, move.operation, flowName, 'autopilot', text);
      this.#logMove(
        this.#lastIsNew ? 'new_screen' : from === this.#current ? 'no_change' : 'revisit',
        move.action.label,
      );
      if (this.#lastIsNew) {
        const screen = this.#screen(this.#current);
        discovered.push({ id: screen.id, type: screen.type, title: screen.title, via: move.action.label });
      }
    }
    return this.#autopilotResult('checkpoint', discovered);
  }

  /** Attach agent insight to any screen, or move a range of steps into a named flow. */
  annotate(
    screenId: string,
    { description, insight }: { description?: string; insight?: string },
    relabel?: { fromStep: number; toStep: number; flow: string },
  ) {
    const screen = this.#screen(screenId);
    if (description) screen.description = description;
    if (insight) screen.insight = insight;
    if (relabel) {
      for (const step of this.doc.steps.slice(relabel.fromStep, relabel.toStep + 1)) step.flow = relabel.flow;
    }
    this.#save();
  }

  async finish({ closeTab = true } = {}) {
    this.#save();
    this.#diagnostics.stop();
    if (closeTab) await this.#tab.close();
    const qa = this.doc.screens.flatMap((screen) => screen.qa.map((finding) => ({ screen: screen.id, ...finding })));
    return {
      viewer: join(this.outDir, 'index.html'),
      journey_json: join(this.outDir, 'journey.json'),
      screens: this.doc.screens.length,
      steps: this.doc.steps.length,
      flows: this.doc.flows.map((flow) => ({ name: flow.name, screens: flow.screens.length })),
      qa_by_severity: countBy(qa, (finding) => finding.severity),
      undescribed_screens: this.doc.screens.filter((screen) => !screen.description).map((screen) => screen.id),
    };
  }

  async #arrive(
    action: PageAction,
    operation: string,
    flow: string,
    by: JourneyStep['by'],
    value?: string,
    insight?: string,
  ) {
    const from = this.#current;
    const fromPage = this.#page;
    this.#recent.push({ operation, element: action.label, ...(value && { value_key: 'typed' }) });
    await this.#capture({
      from,
      flow,
      by,
      action: { operation, label: action.label, ...(value && { value }) },
      hotspot: hotspotOf(action, fromPage),
      ...(insight && { insight }),
    });
    return this.report();
  }

  // Observe → one Jev request (next step + screen understanding) → dedupe → screenshot → QA → save.
  async #capture(arrival: Omit<JourneyStep, 'to'> | null) {
    await this.#diagnostics.waitForIdle();
    const page = await this.#settledPage();
    const seesScreen = (this.#options.screenshots ?? 'off') !== 'off';
    const decision = await decide(this.#ask, {
      page,
      goal: this.#options.intent ?? EXPLORE_GOAL,
      values: this.#options.values ?? {},
      history: this.#recent.slice(-10),
      checkCommitRisk: true,
      extraQuestions: screenQuestions(this.doc.screens.map((screen) => visitedSummary(screen, this.#excerpts))),
      compactRules: this.#options.compactRules,
      ...(this.#options.elementRisk && { elementRisk: 'ranked' as const }),
      ...(seesScreen && { screenshot: await this.#tab.markedScreenshot(buildActionSpace(page.actions).marks, page.w) }),
    });
    const judgments = readScreenJudgments(decision.answers);
    // Mobile emulation widens the layout viewport to fit overflowing content, so compare against the device width.
    const overflow = Number(
      await this.#tab.evaluate(`document.documentElement.scrollWidth - ${this.#device.width}`).catch(() => 0),
    );
    const findings = qaFindings(page, this.#diagnostics.drain(), judgments, overflow, this.#device.mobile);

    const contentKey = `${normalizeUrl(page.url)}\n${page.title}\n${page.text.slice(0, 600)}`;
    const existing = this.#contentKeys.get(contentKey) ?? judgments.sameAs;
    const id = existing ?? `s${String(this.doc.screens.length + 1).padStart(2, '0')}`;
    if (existing) {
      mergeFindings(this.#screen(existing).qa, findings);
    } else {
      const screenshot = `screens/${id}.png`;
      writeFileSync(join(this.outDir, screenshot), Buffer.from(await this.#tab.screenshot(), 'base64'));
      this.doc.screens.push({
        id,
        url: page.url,
        title: page.title,
        screenshot,
        capturedAt: new Date().toISOString(),
        type: judgments.type,
        typeConfidence: judgments.typeConfidence,
        patterns: judgments.patterns,
        qa: findings,
      });
    }
    this.#contentKeys.set(contentKey, id);
    if (!existing) this.#excerpts.set(id, page.text.slice(0, 300));

    // Autopilot taps that leave the screen unchanged (current tab, no-op buttons) are not journey steps.
    if (arrival && !(arrival.by === 'autopilot' && id === arrival.from)) {
      const step = { ...arrival, to: id };
      this.doc.steps.push(step);
      if (!this.#paths.has(id)) this.#paths.set(id, [...(this.#paths.get(arrival.from) ?? []), step]);
    } else if (!this.#paths.has(id)) {
      this.#paths.set(id, []);
    }
    this.#page = page;
    this.#decision = decision;
    this.#judgments = judgments;
    this.#current = id;
    this.#lastIsNew = !existing;
    this.#save();
  }

  // Sheets and pages fade in: wait for finite animations, then for two identical snapshots, so the element
  // table and the screenshot show the arrived screen rather than a transition frame.
  async #settledPage() {
    await this.#tab
      .evaluate(
        `Promise.race([
          Promise.all(document.getAnimations()
            .filter(a => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity)
            .map(a => a.finished.catch(() => {}))),
          new Promise(r => setTimeout(r, 1500)),
        ]).then(() => true)`,
      )
      .catch(() => undefined);
    let page = await this.#tab.observe();
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const next = await this.#tab.observe();
      if (next.fingerprint === page.fingerprint) return next;
      page = next;
    }
    return page;
  }

  async #goBack() {
    await this.#tab.evaluate('history.back()').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.#capture(null);
    return this.report();
  }

  async #canGoBack() {
    const { currentIndex } = await this.#tab.send('Page.getNavigationHistory');
    return currentIndex > this.#startHistoryIndex;
  }

  // SPAs rarely encode state in the URL: reload the start page and repeat the recorded taps by label.
  async #replayTo(screenId: string) {
    const path = this.#paths.get(screenId);
    if (!path) throw new Error(`No recorded path to screen ${screenId}`);
    await this.#tab.navigate(this.#options.startUrl);
    for (const step of path) {
      await this.#diagnostics.waitForIdle();
      const page = await this.#tab.observe();
      const kind = { CLICK: 'click', TYPE_TEXT: 'fill', SELECT: 'select' }[step.action.operation];
      const action = page.actions.find((candidate) => candidate.kind === kind && candidate.label === step.action.label);
      if (!action) throw new Error(`Replay to ${screenId} failed: "${step.action.label}" is no longer on the page`);
      await this.#tab.act(action, page, step.action.value);
    }
    this.#diagnostics.drain();
  }

  #logMove(move: string, element?: string) {
    this.#moves.push({ move, ...(element && { element: element.slice(0, 80) }), screen: this.#current });
  }

  #autopilotResult(stopped: string, discovered: unknown[], detail?: string) {
    return {
      stopped,
      ...(detail && { detail }),
      moves: this.#moves.length,
      move_log: this.#moves,
      discovered,
      ...(this.#skippedRisky.length && { skipped_irreversible: this.#skippedRisky }),
      ...this.report(),
    };
  }

  #triedOn(screenId: string) {
    let tried = this.#tried.get(screenId);
    if (!tried) this.#tried.set(screenId, (tried = new Set()));
    return tried;
  }

  #screen(id: string) {
    const screen = this.doc.screens.find((candidate) => candidate.id === id);
    if (!screen) throw new Error(`Unknown screen "${id}"`);
    return screen;
  }

  #save() {
    this.doc.flows = buildFlows(this.doc.steps);
    writeFileSync(join(this.outDir, 'journey.json'), JSON.stringify(this.doc, null, 2));
    writeFileSync(join(this.outDir, 'index.html'), renderViewer(this.doc));
  }
}

// "https://site/#/" and "https://site/" are the same route.
const normalizeUrl = (url: string) => url.replace(/#\/?$/, '').replace(/\/$/, '');

const visitedSummary = (screen: JourneyDoc['screens'][number], excerpts: Map<string, string>): VisitedScreen => ({
  id: screen.id,
  type: screen.type,
  title: screen.title,
  url: screen.url,
  excerpt: screen.description ?? excerpts.get(screen.id) ?? '',
});

const resolveTarget = (space: ActionSpace, next: string, value?: string) => {
  const byOperation = (operation: 'CLICK' | 'TYPE_TEXT' | 'SELECT') => {
    const action = space.targets[operation]?.[next];
    return action && { action, operation };
  };
  const target = next.includes(':')
    ? byOperation('SELECT')
    : value !== undefined
      ? byOperation('TYPE_TEXT')
      : (byOperation('CLICK') ?? byOperation('TYPE_TEXT'));
  if (!target) throw new Error(`No element [${next}] supports that step. Check "elements" in the last report.`);
  if (target.operation === 'TYPE_TEXT' && value === undefined) {
    throw new Error(`Element [${next}] is a text field: pass "value" with the text to type.`);
  }
  return target;
};

const targetKeyOf = (space: ActionSpace, action: PageAction) => {
  for (const candidates of Object.values(space.targets)) {
    const match = Object.entries(candidates).find(([, candidate]) => candidate === action);
    if (match) return match[0];
  }
  return action.id.toLowerCase();
};

const rankedTaps = (decision: Decision, space: ActionSpace) =>
  Object.entries((decision.answers.click_target?.probabilities ?? {}) as Record<string, number>)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([index, probability]) => ({
      index,
      element: space.targets.CLICK![index].label,
      probability: round(probability),
    }));

const elementTable = (space: ActionSpace, page: PageState) => {
  const rows = space.elements.slice(0, 150).map((element) => {
    const value = element.value ? ` = "${String(element.value).slice(0, 40)}"` : '';
    const options = element.options
      ? ` options: ${element.options.map((o) => `${o.index} ${o.label.split(' → ')[1]}`).join(', ')}`
      : '';
    return `[${element.index}] ${element.role ?? ''} "${element.label.slice(0, 80)}"${value} (${element.operations.join('/')})${options}`;
  });
  const hidden = space.elements.length - rows.length + page.omitted_actions;
  return hidden > 0 ? [...rows, `… ${hidden} more off-table; scroll_down reveals more`] : rows;
};

// Layout checks describe the screen as a whole: a revisit replaces them. Runtime errors accumulate.
const SCREEN_WIDE_CHECKS = new Set<QaFinding['kind']>(['small_tap_target', 'unlabeled_control', 'horizontal_overflow']);

const mergeFindings = (target: QaFinding[], findings: QaFinding[]) => {
  for (const finding of findings) {
    if (SCREEN_WIDE_CHECKS.has(finding.kind)) {
      target.splice(0, target.length, ...target.filter((existing) => existing.kind !== finding.kind));
    }
    if (!target.some((existing) => existing.kind === finding.kind && existing.detail === finding.detail))
      target.push(finding);
  }
};

const countBy = <T>(items: T[], key: (item: T) => string) =>
  items.reduce<Record<string, number>>(
    (counts, item) => ({ ...counts, [key(item)]: (counts[key(item)] ?? 0) + 1 }),
    {},
  );

const round = (value: number) => Math.round(value * 1000) / 1000;
