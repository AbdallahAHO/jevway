import { findBotWall, type BotWall } from '../browser/bot-wall.ts';
import { PAGE_LEVEL_KINDS, StalePage, TargetUnreachable, type PageAction, type PageState, type Tab } from '../browser/tab.ts';
import { showsTarget } from '../browser/words.ts';
import { buildActionSpace } from '../jev/action-space.ts';
import { centerOf, contains } from '../jev/box.ts';
import { decide, evidenceRequest, foldedFavourite, overflowFolds, readEvidence, type Ask, type Candidate, type Decision, type StepRecord } from '../jev/decide.ts';
import { estimateCostUsd, type ImageTransport, type ScreenshotMode } from '../jev/model.ts';
import { ANY_HOST, narrowHosts, outsideHosts, type HostRules } from './hosts.ts';
import { scrubberFor } from '../jev/secrets.ts';
import { describeFailure, runChecks, type Check, type CheckResult } from './checks.ts';
import { deepLink, quoteSpans } from './evidence.ts';
import { writeCall, type RunFiles } from '../output/run-folder.ts';
import { Recording } from '../recording/recording.ts';
import { RunStopped, startRunLimit, type RunLimit } from './run-limit.ts';
import { checkUploadFiles, fileNames } from './upload-files.ts';
import { checkTotpSecrets, totpMasks, typingCode, type TotpSecret } from './totp.ts';
import { isTransientModelError } from '../jev/retry.ts';
import type { Notify } from '../notify/desktop.ts';
import { notificationText, passedText, waitingText, type PersonWall } from '../notify/person-messages.ts';
import { ssoProviderOf, stillSigningIn, waitForPersonLoop, type WaitOutcome } from './person-wait.ts';

export interface TaskOptions {
  goal: string;
  /** Named field values the agent already knows. Jev picks which one to type; nothing else is ever typed. */
  values?: Record<string, string>;
  /**
   * Keys of `values` that are secrets (an API token, a one-time code): Jev sees `[secret:<key>]` in place of the value, and the
   * value is replaced by that marker in every summary, trace and recording, wherever the page echoes it. Typed as given.
   */
  secretKeys?: string[];
  /**
   * Files the caller declares for upload, by key: absolute paths (checked before the run). Kept apart from `values`:
   * Jev picks a key for a file field and sees the file's name, never its path; nothing else is ever uploaded.
   */
  files?: Record<string, string>;
  /**
   * Authenticator secrets for the person's own accounts, by key: base32 or an `otpauth://totp/` URI (checked before the
   * run). Kept apart from `values`: Jev sees `[secret:<key>]` and may pick the key for a field, and code types the code
   * current at that moment. The secret and every code are masked like a secret value.
   */
  totp?: Record<string, string>;
  /** Visible evidence that the task is finished; checked by a separate Jev judgment on DONE. */
  doneWhen?: string;
  /** Maximum executed browser actions per call. */
  maxSteps?: number;
  /** Time budget per call, in seconds: past it the run ends `step_budget` at its next check (never mid-input). */
  maxSeconds?: number;
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
  /** The model id requests are sent with (see ModelProfile.model): reported in the summary and priced by `estimateCostUsd`. */
  model?: string;
  /**
   * Opt-in: when Jev is BLOCKED and the screenshot shows a control the DOM reader never reported (canvas,
   * iframe), click the centre of its box after a hit-test. Off by default: it is the one path where model
   * output becomes a coordinate. Still gated by commit risk.
   */
  allowCoordinateClicks?: boolean;
  /** After an action that changed nothing yet, or a WAIT, keep observing up to this long for the page to change before deciding again. */
  changeWaitMs?: number;
  /**
   * The session's run folder: every call leaves its end page (`final.jpg`, `calls/NN-<status>.jpg`), `summary.json` and
   * `manifest.json` there. `record` adds the recording for people: a sharp shot before every action, `run.mp4` and an
   * `index.html` viewer. Without it the task writes nothing.
   */
  output?: { dir: string; record?: boolean };
  /** The same as `output: { dir: recordDir, record: true }`. */
  recordDir?: string;
  /** Hosts the run may be on (see hosts.ts): checked before every decision and after every step; leaving ends it `blocked`. */
  hosts?: HostRules;
  /** How long a bot check (a Cloudflare challenge, a captcha page) gets to clear itself before the run hands back `blocked`. */
  wallWaitMs?: number;
  /** With a visible browser, how long a person gets to pass a bot check, sign in or finish an SSO sign-in before the run hands back; 0 never waits. */
  waitForPersonSeconds?: number;
  /** Start-only, set by the runner: whether a person can see the browser, and how to reach them. */
  person?: PersonReach;
  /**
   * The caller's checks, evaluated by code on the final page (see checks.ts): a failed one turns `done` into
   * `uncertain`; all passing turn `blocked`/`uncertain` into `done` only with `doneWhen` scored ≥ 0.5 on that page.
   */
  checks?: Check[];
}

/** Whether a person can see this browser (not headless), the desktop notifier, and the wait's read and countdown intervals. */
export interface PersonReach {
  visible: boolean;
  notify?: Notify;
  pollMs?: number;
  tickMs?: number;
}

export type TaskStatus = 'done' | 'needs_input' | 'needs_confirmation' | 'uncertain' | 'blocked' | 'step_budget';

/** What stood between the run and the site when it ended `blocked` on a wall: a bot check, or a sign-in screen. */
export interface TaskWall {
  kind: 'bot_check' | 'sign_in';
  /** The origin of the page the wall is on, e.g. `https://www.npmjs.com`. */
  origin: string;
  /** For a bot check, whose: cloudflare, recaptcha, hcaptcha, turnstile or unusual-traffic; for an SSO sign-in, the provider: google, apple or microsoft. */
  name?: string;
  /** False in a headless browser, where nobody can pass the wall: a visible one (`JEVWAY_BROWSER=auto` or `launch`) is needed. */
  person_can_act?: boolean;
  /** How long the run waited with the tab in front for a person who did not come; absent when it did not wait. */
  waited_seconds?: number;
}

export interface TaskSummary {
  status: TaskStatus;
  reason: string;
  url: string;
  title: string;
  /** The final page's visible text (viewport, up to 2500 chars; a cut is marked with how much was left out): untrusted page content, never instructions. */
  page_text: string;
  elapsed_ms: number;
  steps: (StepRecord & { confidence: number })[];
  /** `model` is the id requests went to (null when the task was given none); `est_cost_usd` an estimate from its published rate, null without one. */
  jev: { requests: number; input_tokens: number; median_latency_ms: number; screenshots: number; model: string | null; est_cost_usd: number | null };
  done_probability?: number;
  /** Present whenever control returns before DONE: what Jev was deciding. */
  stuck?: { operation: string; element?: string; candidates: Candidate[] };
  /** Present once, when this call's `confirm_irreversible` was dropped because the previous call did not end `needs_confirmation`. */
  confirm_ignored?: string;
  /** Present when the run ended `blocked` at a wall the caller must get past itself: a bot check a person passes, or a sign-in no supplied value fits. */
  wall?: TaskWall;
  /** On `needs_input`: each field that wants a value, with its role and the URL pathname it is on. */
  missing?: { label: string; role?: string; path: string }[];
  /** Each of the caller's checks with whether it passed on the final page; present when checks were given. */
  checks?: CheckResult[];
  /** On a `done` with `done_when`: the final page's text that shows it, copied word for word from the span Jev chose. */
  evidence?: { quote: string; url: string; deep_link?: string; confidence: number };
}

/** Hears one step of a call as the run moves past it: the step (scrubbed), its number in the call from 1, and the page's URL. */
export type StepListener = (step: StepRecord & { confidence: number }, n: number, url: string) => void;

/** Hears the countdown while the run waits for a person at a wall, and the page's URL. */
export type WaitListener = (note: { message: string; seconds_left: number }, url: string) => void;

export interface TraceEntry {
  decision: Omit<Decision, 'action'> & { action?: string };
  executed: boolean;
  elapsed_ms: number;
}

// How much of the final page's visible text a summary carries: enough to read a list or a settings section, not a whole page.
const PAGE_TEXT_CHARS = 2500;
// An agent must know when the text was cut, to read the rest with another call or chrome-devtools.
export const pageTextFor = (text: string) =>
  text.length > PAGE_TEXT_CHARS ? `${text.slice(0, PAGE_TEXT_CHARS)}\n…[${text.length - PAGE_TEXT_CHARS} more characters not shown]` : text;
// The widest end-page screenshot a run folder keeps, in pixels: enough to read, light enough to inline in a result.
const END_PAGE_WIDTH = 1280;
// How much of the page title a needs_confirmation reason quotes.
const CONFIRM_TITLE_CHARS = 80;
// How much of a page dialog's text a step or a repeat reason quotes.
const DIALOG_MESSAGE_CHARS = 200;
// How much of what a page said after a submit a blocked reason quotes, and how many submits a task remembers.
const SUBMIT_ANSWER_CHARS = 300;
const SUBMITS_KEPT = 10;
// Lines kept per page path in #seenLines: a page that streams new text forever must not grow the set without end.
const SEEN_LINES_PER_PATH = 4000;

const DEFAULTS = {
  maxSteps: 40,
  // 5× the longest call measured over every verify run to 2026-10-18 (59.6 s of 26 164): a backstop, never a pace (plan 088).
  maxSeconds: 300,
  minConfidence: 0.3,
  screenshots: 'off' as ScreenshotMode,
  compactRules: '',
  elementRisk: false,
  pageRisk: false,
  imageTransport: 'image_url' as ImageTransport,
  box: false,
  allowCoordinateClicks: false,
  changeWaitMs: 1500,
  hosts: ANY_HOST,
  // Prior art (jkudish/jev-browser) waits 8 s; npm's headless challenge never cleared in 50 s, so this bounds patience.
  wallWaitMs: 8000,
  // A task built without the runner never waits for a person; the runner sets the call's wait (default 120 s when visible).
  waitForPersonSeconds: 0,
  checks: [] as Check[],
};
// While waiting for a person: how often the page is read (a full observe, so not every 250 ms) and how often the countdown is told.
const PERSON_POLL_MS = 1000;
const PERSON_TICK_MS = 10_000;
// How often a bot check is looked at again while it gets the chance to clear itself.
const WALL_POLL_MS = 250;
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
  // Clicks refused because the page changed since the decision, per allowed step: past that many the page won't hold still (tab.act's StalePage).
  staleRefusalsPerStep: 2,
} as const;
// A DONE the completion check rejects usually means content is still loading: wait and re-decide this many times.
const MAX_REJECTED_DONE = 3;
// A click this risky but under the 0.5 gate gets a screenshot look before it runs; text alone under-reads checkout pages.
const GRAY_ZONE_RISK = 0.25;
// Box answers count only when the model is at least this sure a control is there and where it is.
const BOX_SURE = 0.5;
// The chosen target counts as covered on screen below this visibility (dense grids of outlines score 0.15–0.3).
const COVERED_BELOW = 0.1;
// ...and only when its box also barely overlaps where the DOM puts it.
const COVERED_OVERLAP_BELOW = 0.1;
// A `done_when` judgment this sure ends the task, unless the next step confidently contradicts it (see HEAD_DISAGREES).
const DONE_EVIDENT = 0.9;
// The last look before a loop guard hands back accepts the goal as met at this done check: the same bar a DONE needs.
const LAST_LOOK_DONE = 0.5;
// Jev's page-error and sign-in-wall answers end the run from these scores, set from recorded runs (plans/103): real
// rejections scored 0.98–1.00 and no other page above 0.75; sign-in walls 0.70–0.98 and no other page above 0.21.
const PAGE_ERROR_STOP = 0.8;
const SIGN_IN_WALL_STOP = 0.7;
// A next-step head this sure of another action contradicts a single done spike (measured on Jev: 2 of 16 such spikes were false DONEs).
const HEAD_DISAGREES = 0.6;
// The screenshot look confirms the spike at the same bar a DONE needs.
const SPIKE_CONFIRMED = LAST_LOOK_DONE;
// An evidence span Jev chose less surely than this is no quote. Measured (plan 100): right spans scored 0.67–0.96 in runs,
// Wikipedia's "Edit" 0.57, and unsure picks ("| comments", "10 results returned.") 0.30–0.44.
const EVIDENCE_SURE = 0.6;
// Enter is offered only after typing into a search or filter field (a filtered list often updates only on Enter); elsewhere it could submit a form.
const SEARCH_LIKE = /search|query|find|filter/i;
const UNSAVED_EDIT_NOTE =
  'not accepted: the last step changed a field and nothing was saved or submitted since; save or submit it, then say DONE';
// The rows of a menu or picker the run opened: a supplied value listed in one is picked before the form is sent.
const MENU_OPTION_ROLES = ['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox'];
// A covered target is fed back as history so Jev can clear it (dismiss a popover); this many times per run.
const MAX_COVERED_RETRIES = 2;
const ESCAPE: PageAction = { id: 'press_escape', kind: 'escape', label: 'Press Escape to close the open menu, popover or suggestion list' };
// Boxes on small targets land a row off (13 px checkboxes); pad before asking whether one covers the chosen control.
const BOX_PADDING = 16;
// A model call that fails like this (5xx, 499 "unexpected error", rate limit, network, timeout) is retried once; any other error is final.
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
  #options: Required<Omit<TaskOptions, 'doneWhen' | 'recordDir' | 'output' | 'model' | 'totp' | 'person'>> & Pick<TaskOptions, 'doneWhen' | 'model'>;
  /** Whether a person can see the browser and how to tell them; fixed when the session starts. */
  #person: PersonReach;
  #history: (StepRecord & { confidence: number })[] = [];
  #latencies: number[] = [];
  #inputTokens = 0;
  #screenshots = 0;
  #confirmedCommit = false;
  /** The user's words the caller gave with the confirmation, for the page to show before the click runs. */
  #confirmTarget: string | undefined;
  /** The control the last needs_confirmation asked about, and the one a confirmation answering it allows (none on a first call). */
  #flagged: Control | undefined;
  #confirmedControl: Control | undefined;
  /** How the previous call ended (none before the first), and the status a dropped confirmation is reported against. */
  #lastStatus: TaskStatus | undefined;
  #confirmIgnored: TaskStatus | undefined;
  // Dialogs the page opened that no step carries yet, and how often each one has come back.
  #dialogNotes: string[] = [];
  #dialogsSeen = new Map<string, number>();
  /** The search-like field typed into by the last executed action, if any: PRESS_ENTER may submit it. */
  #lastTyped: PageAction | undefined;
  /** Set while the last executed step changed a field (typed, ticked) and nothing was saved since; `noted` once a DONE was sent back for it. */
  #unsavedEdit: { noted: boolean; label: string } | undefined;
  /** Clicks (by node) that already got a "save first" after the page asked before leaving: the second time ends the run. */
  #leaveNoted = new Set<string>();
  /** Every field this task typed into, with the path it was on: what a submit sent, for telling a form that came back from a new page. */
  #typedFields: { label: string; path: string; value?: string }[] = [];
  /** Risky clicks that executed, with what the page said right after (see #rejectedSubmit). */
  #submits: Submit[] = [];
  /** Every line of text a decision was made on, per page path: what a submit's answer is measured against, so a reloaded page's chrome never counts as what the page said. */
  #seenLines = new Map<string, Set<string>>();
  /** What the page said after the last submit, shown to Jev on top of the page text while the run stays on that path. */
  #said: { label: string; path: string; lines: string[]; text: string } | undefined;
  /** Consecutive misses on the same target node because it couldn't be reached on an unchanged page. */
  #unreachable = { node: undefined as number | undefined, count: 0 };
  /** Consecutive refusals of wait, Escape, scroll or Enter because the page changed since the decision; any executed action resets it. */
  #pageLevelStale = 0;
  /** Each executed action and the page fingerprint right after it, to spot one that toggles in place. */
  #outcomes: { action: string; print: string }[] = [];
  /** Nodes of collapsed controls already opened instead of handing back blocked: each is tried once. */
  #opened = new Set<number>();
  /** Nodes of controls this run's own click flipped from collapsed to expanded. */
  #openedByRun = new Set<number>();
  /** Nodes closed with Escape before a done: each is closed once, so a goal whose evidence is the open menu still finishes. */
  #closedBeforeDone = new Set<number>();
  /** Keys of the supplied values this task typed, selected or clicked. */
  #usedValues = new Set<string>();
  /** Menu options already sent back for an unpicked value, as `node:key`: each is sent back once. */
  #pickNoted = new Set<string>();
  /** What this run's own clicks left each checkbox or switch showing, by path and label, whether a repeat click was already told about it, and the first click on that path since. */
  #toggled = new Map<string, { label: string; checked: string; noted: boolean; clickedAfter?: string }>();
  /** Nodes of fields the model chose with no supplied value to type: each is refused once before the caller is asked. */
  #refusedForValue = new Set<number>();
  /** The caller's authenticator secrets by key: only `decide` (as a marker) and the typing see them. */
  #totp = new Map<string, TotpSecret>();
  /** Secrets that are not supplied values, by key: each authenticator secret as given and as base32, every code typed. Kept for the session. */
  #moreSecrets: [key: string, value: string][] = [];
  /** Trace entries before this index are already scrubbed of secret values. */
  #traceScrubbed = 0;
  /** The page each decision was made on: a `done_when` score counts for the caller's checks only on the page it judged. */
  #decidedOn = new WeakMap<Decision, PageState>();
  /**
   * How the last call stopped: the page its summary reports, the decision it stopped on, its first request, and whether
   * the stop was a judgment of progress the caller's checks may overturn (see #settle). Every other stop is final.
   */
  #ending: { page: PageState; decision?: Decision; firstRequest: number; overridable: boolean } | undefined;
  /** The lines the last executed action brought to the page: what a page error is quoted from when no page message is shown. */
  #lastNewText: string | undefined;
  #tab: Tab;
  /** Every tab this session drove, the first one first: the ones after it were opened by the session's own clicks. */
  #tabs: Tab[];
  #ask: Ask;
  #recording: Recording | undefined;
  /** The run folder each call writes to, every call's summary so far, and what the last call left there. */
  #output: TaskOptions['output'];
  #summaries: TaskSummary[] = [];
  #lastCall: { files: RunFiles; screenshot?: Buffer } | undefined;
  /** This call's step listener, and how many of the call's steps it was told. */
  #onStep: StepListener | undefined;
  #stepsTold = 0;
  #onWait: WaitListener | undefined;
  /** This call's stop signal (caller cancel or time budget); set while a call runs. */
  #limit: RunLimit | undefined;

  constructor(tab: Tab, ask: Ask, { recordDir, output, totp, person, ...options }: TaskOptions) {
    this.#tab = tab;
    this.#person = person ?? { visible: true };
    this.#tabs = [tab];
    this.#ask = ask;
    const authenticators = checkTotpSecrets(totp, options.values);
    this.#options = { ...DEFAULTS, values: {}, secretKeys: [], ...definedOnly(options), files: checkUploadFiles(options.files) };
    this.#takeTotp(authenticators);
    this.#output = output ?? (recordDir ? { dir: recordDir, record: true } : undefined);
    if (this.#output?.record) this.#recording = new Recording(this.#output.dir, (text) => this.#scrub(text));
  }

  /** What the last call left in the run folder, and its end page as JPEG bytes (absent when the capture failed); none without `output`. */
  get lastCall() {
    return this.#lastCall;
  }

  /** The model a call's requests went to, and what its input tokens cost at that model's published rate. */
  #costOf(inputTokens: number) {
    const model = this.#options.model ?? null;
    return { model, est_cost_usd: estimateCostUsd(model, inputTokens) };
  }

  /** Replaces every value the caller marked secret with its marker, in a string or a plain object's strings. */
  #scrub<T>(value: T): T {
    return scrubberFor(this.#options.values, this.#options.secretKeys, this.#moreSecrets)(value);
  }

  // jevway: a page is scrubbed of secrets as soon as the run reads it, so every label, value, history line, page
  // message and reason is built from scrubbed text before anything cuts it short (a cut secret no longer matches the
  // later whole-request scrub). What input needs stays as read: the freshness marker, guards, keys and fingerprint,
  // a select option's value; the tab still types the real value.
  async #observe(): Promise<PageState> {
    const page = await this.#tab.observe();
    if (!this.#options.secretKeys.length) return page;
    const scrub = scrubberFor(this.#options.values, this.#options.secretKeys, this.#moreSecrets);
    return {
      ...page,
      url: scrub(page.url),
      title: scrub(page.title),
      text: scrub(page.text),
      ...(page.passwordFields && { passwordFields: page.passwordFields.map((field) => ({ ...field, name: scrub(field.name) })) }),
      actions: page.actions.map((action) => ({
        ...action,
        label: scrub(action.label),
        ...(action.value !== undefined && action.kind !== 'select' && { value: scrub(action.value) }),
        ...(action.current_value !== undefined && { current_value: scrub(action.current_value) }),
      })),
    };
  }

  /** Reads the session's tab with no model call and no input, its secret values already masked: what `jevway_look` shows. */
  look(): Promise<PageState> {
    return this.#observe();
  }

  /** The tab the session is on now: a tab its clicks opened, once followed, or the one it started on. */
  get tab() {
    return this.#tab;
  }

  /** Every tab the session drove, the first one first. */
  get tabs(): readonly Tab[] {
    return this.#tabs;
  }

  /**
   * Closes the tabs this session followed (its own clicks opened them), and the first one unless `keepFirst` (a tab the
   * caller pointed it at, or one it should leave open).
   *
   * @example
   * await task.closeTabs({ keepFirst: !ownsTab }); // jevway_end without keep_tab
   */
  async closeTabs({ keepFirst }: { keepFirst: boolean }) {
    for (const [index, tab] of this.#tabs.entries()) if (index > 0 || !keepFirst) await tab.close();
  }

  // jevway: a tab the session's tab opened becomes the session's tab (the newest, if several); when the tab in use
  // closes, the run goes back to the newest one it drove that is still open. Says which happened, for the history note.
  async #switchTabs(): Promise<'opened' | 'closed' | undefined> {
    const opened = this.#tab.takeOpened().at(-1);
    if (opened) {
      // The arm for the click that opened it moves with the step; the tab left behind keeps none.
      const opener = this.#tab;
      this.#tab = await opener.follow(opened);
      opener.disarmConfirm();
      this.#tabs.push(this.#tab);
      return 'opened';
    }
    if (!this.#tab.closed) return undefined;
    const back = this.#tabs.findLast((tab) => !tab.closed);
    if (!back) return undefined;
    this.#tab = back;
    return 'closed';
  }

  // Puts a tab switch on the last step of this call, with the page now in use (read here unless the caller just did).
  async #afterSwitch(switched: 'opened' | 'closed', firstStep: number, read?: PageState): Promise<PageState> {
    const page = read ?? (await this.#observe());
    const note = switched === 'opened' ? `new tab opened: ${page.url}` : `the tab closed; back on ${page.url}`;
    const last = this.#history.length - 1;
    if (last >= firstStep) this.#history[last] = { ...this.#history[last], element: `${this.#history[last].element} (${note})`, page_changed: true };
    return page;
  }

  /** Merge new values, a new goal, narrower hosts (a widening list throws), or a one-time confirmation for the next irreversible click. */
  update(
    patch: Partial<Omit<TaskOptions, 'hosts'>> & { confirmIrreversible?: boolean; confirmTarget?: string; allowedHosts?: string[]; blockedHosts?: string[] },
  ) {
    const { confirmIrreversible, confirmTarget, values, secretKeys, files, totp, recordDir: _recordDir, output: _output, person: _person, allowedHosts, blockedHosts, ...options } = patch;
    // First, so a list that would widen the hosts, or a bad authenticator secret, throws before anything else changes.
    const hosts = narrowHosts(this.#options.hosts, { allowed: allowedHosts, blocked: blockedHosts });
    const authenticators = checkTotpSecrets(totp, values);
    const newGoal = options.goal !== undefined && options.goal !== this.#options.goal;
    // A new goal may be to flip back what the old one flipped.
    if (newGoal) this.#toggled.clear();
    this.#options = {
      ...this.#options,
      // The old goal's done_when may already hold, and would end the new goal before it starts.
      ...(newGoal && options.doneWhen === undefined && { doneWhen: undefined }),
      ...definedOnly(options),
      hosts,
      values: { ...this.#options.values, ...values },
      // Once secret, always secret in this session.
      secretKeys: [...new Set([...this.#options.secretKeys, ...(secretKeys ?? [])])],
      files: { ...this.#options.files, ...checkUploadFiles(files) },
    };
    this.#takeTotp(authenticators, values);
    if (!confirmIrreversible) return;
    // A confirmation answers the question jevway asked, so a flag carried onto a later call allows nothing (an unused earlier one stands).
    if (this.#lastStatus === undefined || this.#lastStatus === 'needs_confirmation') {
      this.#confirmedCommit = true;
      this.#confirmTarget = confirmTarget;
      this.#confirmedControl = this.#lastStatus === 'needs_confirmation' ? this.#flagged : undefined;
    } else if (!this.#confirmedCommit) this.#confirmIgnored = this.#lastStatus;
  }

  // The newest plain value or authenticator secret for a key replaces the older one; either stays secret for the session.
  #takeTotp(authenticators: Map<string, TotpSecret>, values: Record<string, string> = {}) {
    for (const key of Object.keys(values)) this.#totp.delete(key);
    for (const [key, secret] of authenticators) this.#totp.set(key, secret);
    this.#moreSecrets.push(...totpMasks(authenticators));
    if (!authenticators.size) return;
    this.#options.values = Object.fromEntries(Object.entries(this.#options.values).filter(([key]) => !authenticators.has(key)));
    this.#options.secretKeys = [...new Set([...this.#options.secretKeys, ...authenticators.keys()])];
  }

  // An authenticator key types the code current now (the next one when its period is about to end), masked before it is typed.
  async #textFor(key: string, values: Record<string, string>) {
    const secret = this.#totp.get(key);
    if (!secret) return values[key];
    const code = await typingCode(secret, { now: Date.now, pause: (ms) => this.#limit?.pause(ms) ?? Promise.resolve() });
    this.#moreSecrets.push([key, code]);
    return code;
  }

  /**
   * Runs until done or a hand-back. `signal` is the caller's cancel (the MCP request's): the run stops at its next
   * check, `blocked` "Cancelled by the caller"; an input already under way finishes first. `onStep` hears each step of
   * this call (numbered from 1) once the run moves past it, with the page's URL then; `onWait` the countdown while it
   * waits for a person at a wall. A listener that throws is ignored.
   */
  async run({ signal, onStep, onWait }: { signal?: AbortSignal; onStep?: StepListener; onWait?: WaitListener } = {}): Promise<TaskSummary> {
    this.#onStep = onStep;
    this.#onWait = onWait;
    this.#stepsTold = 0;
    // The recording is for people: a browser failure while recording must not change or hang the run's outcome.
    await this.#recording?.start(this.#tab).catch(() => undefined);
    let settled: TaskSummary;
    try {
      settled = await this.#withEvidence(this.#settle(await this.#loop(signal)));
    } finally {
      // The stop signal lasts until the evidence request is answered: it is the call's last wait.
      this.#limit?.dispose();
      this.#limit = undefined;
      for (const tab of this.#tabs) tab.stopSignal = undefined;
    }
    // A secret never leaves in a summary or a trace, wherever the page echoed it: the checks and the evidence included.
    for (; this.#traceScrubbed < this.trace.length; this.#traceScrubbed++) this.trace[this.#traceScrubbed] = this.#scrub(this.trace[this.#traceScrubbed]);
    const summary = this.#scrub(settled);
    this.#onStep = undefined;
    this.#onWait = undefined;
    await this.#recording?.finish(this.#tab, summary, { goal: this.#options.goal, doneWhen: this.#options.doneWhen }).catch(() => undefined);
    if (this.#output) await this.#writeCall(this.#output.dir, summary);
    return summary;
  }

  // What a call leaves in the run folder; like the recording, it never changes or hangs the run's outcome.
  async #writeCall(dir: string, summary: TaskSummary) {
    this.#summaries.push(summary);
    const screenshot = await this.#endPage().catch(() => undefined);
    try {
      const files = writeCall({ dir, call: this.#summaries.length, status: summary.status, shot: screenshot, summaries: this.#summaries, recorded: Boolean(this.#recording) });
      this.#lastCall = { files, ...(screenshot && { screenshot }) };
    } catch {
      this.#lastCall = undefined;
    }
  }

  /** The tab's viewport as a light JPEG for agents: quality 70, at most 1280 pixels wide. Pixels: a secret typed into a visible field shows. */
  async #endPage() {
    const ratio = Number(await this.#tab.evaluate('devicePixelRatio')) || 1;
    const width = this.#ending?.page.w || END_PAGE_WIDTH;
    const scale = Math.min(1, END_PAGE_WIDTH / (width * ratio));
    return Buffer.from(await this.#tab.screenshot({ format: 'jpeg', quality: 70, scale }), 'base64');
  }

  /** Tells the wait listener the countdown; like a step listener, it only hears. */
  #tellWait(message: string, secondsLeft: number, url: string) {
    try {
      this.#onWait?.({ message: this.#scrub(message), seconds_left: secondsLeft }, this.#scrub(url));
    } catch {
      // The caller's progress line never decides how the run goes.
    }
  }

  // jevway: with the browser in view, a person can get past a wall the run never touches. The tab comes forward, one
  // notification says what to do, and the page is read (no model, no input) until the wall is gone or the time is up.
  async #waitForPerson(
    wall: PersonWall,
    page: PageState,
    { isWall, clearReads, limit }: { isWall: (page: PageState) => Promise<boolean> | boolean; clearReads: number; limit: RunLimit },
  ): Promise<{ outcome: WaitOutcome | 'off'; page: PageState }> {
    const waitMs = this.#person.visible ? this.#options.waitForPersonSeconds * 1000 : 0;
    if (waitMs <= 0 || limit.stopped()) return { outcome: 'off', page };
    const tab = this.#tab;
    for (const [method, params] of [['Page.bringToFront', {}], ['Target.activateTarget', { targetId: tab.targetId }]] as const) {
      try {
        await tab.send(method, params);
      } catch {
        // Best effort: an old Chrome or a closed window still gets the notification.
      }
    }
    try {
      this.#person.notify?.(notificationText(wall));
    } catch {
      // A notifier only hears.
    }
    const { outcome, page: read } = await waitForPersonLoop({
      waitMs,
      pollMs: this.#person.pollMs ?? PERSON_POLL_MS,
      tickMs: this.#person.tickMs ?? PERSON_TICK_MS,
      clearReads,
      read: async () => {
        // A tab the page opens meanwhile is the person's (a "Sign in with Google" popup): never followed.
        tab.takeOpened();
        if (tab.closed) return undefined;
        return this.#observe().catch((error) => {
          if (error instanceof StalePage) return page;
          throw error;
        });
      },
      isWall,
      pause: limit.pause,
      stopped: () => Boolean(limit.stopped()),
      tell: (secondsLeft) => this.#tellWait(waitingText(wall, secondsLeft), secondsLeft, page.url),
    });
    if (outcome === 'passed') this.#history.push({ operation: 'WAIT_FOR_PERSON', element: passedText(wall), page_changed: true, confidence: 1 });
    return { outcome, page: read ?? page };
  }

  /** Tells the step listener about this call's steps it has not heard yet; the page's URL is the one the run is on now. */
  #tellSteps(firstStep: number, url: string) {
    if (!this.#onStep) return;
    for (; firstStep + this.#stepsTold < this.#history.length; this.#stepsTold++) {
      try {
        this.#onStep(this.#scrub(this.#history[firstStep + this.#stepsTold]), this.#stepsTold + 1, url);
      } catch {
        // A listener is the caller's (progress, a log line): it never decides how the run goes.
      }
    }
  }

  async #loop(signal?: AbortSignal): Promise<TaskSummary> {
    // The page's own scripts can read what it is told to look for, so a secret reaches the page only when typed into its field.
    this.#tab.want(
      Object.entries(this.#options.values).filter(([key]) => !this.#options.secretKeys.includes(key)).map(([, value]) => value),
      { files: Object.keys(this.#options.files).length > 0 },
    );
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const { maxSteps, maxSeconds, values, doneWhen, screenshots, hosts } = this.#options;
    // `stop` reads the page, so it needs a stand-in until the first observe succeeds.
    let page: PageState = BLANK_PAGE;
    let executed = 0;
    // Caller cancel or time budget: checked before every decision and every input, never during one.
    const limit = (this.#limit = startRunLimit({ signal, maxSeconds, actions: () => executed }));
    // The tabs' own waits (a followed tab's load, a scroll's poll, frame reads) end on it too; a followed tab inherits it.
    for (const tab of this.#tabs) tab.stopSignal = limit.signal;
    let decisions = 0;
    let staleRefusals = 0;
    let rejectedDone = 0;
    let coveredRetries = 0;
    let doneStreak = 0;
    const firstStep = this.#history.length;
    const firstRequest = this.#latencies.length;
    const tokensBefore = this.#inputTokens;
    const screenshotsBefore = this.#screenshots;

    // `overridable` marks the stops that judge progress (Jev's BLOCKED or unsure, the progress guards); every other stop is final.
    const stop = (status: TaskStatus, reason: string, decision?: Decision, { overridable = false } = {}): TaskSummary => {
      // A dialog that opened late still belongs on the step that caused it.
      this.#reportDialogs(firstStep);
      this.#tellSteps(firstStep, page.url);
      // A hand-back asks a new question, so a confirmation still pending (a refused one) is spent.
      if (status === 'needs_confirmation') this.#spendConfirmation();
      // The agent answers a question about one control; the pin says which (see #handBack).
      this.#flagged = status === 'needs_confirmation' && decision ? controlOf(decision, page) : undefined;
      const confirmIgnored = this.#confirmIgnored;
      this.#confirmIgnored = undefined;
      this.#lastStatus = status;
      this.#ending = { page, decision, firstRequest, overridable };
      return {
        status,
        reason,
        url: page.url,
        title: page.title,
        page_text: pageTextFor(page.text),
        elapsed_ms: elapsed(),
        // Counts cover this call only; the session keeps full history for Jev's context.
        steps: this.#history.slice(firstStep),
        jev: {
          requests: this.#latencies.length - firstRequest,
          input_tokens: this.#inputTokens - tokensBefore,
          median_latency_ms: median(this.#latencies.slice(firstRequest)),
          screenshots: this.#screenshots - screenshotsBefore,
          ...this.#costOf(this.#inputTokens - tokensBefore),
        },
        ...(decision?.doneProbability !== undefined && { done_probability: round(decision.doneProbability) }),
        ...(status !== 'done' && decision && { stuck: stuckOn(decision) }),
        ...(confirmIgnored && { confirm_ignored: `the previous call ended ${confirmIgnored}, not needs_confirmation` }),
        ...(status === 'needs_input' && decision && { missing: missingFields(decision, page) }),
      };
    };

    // Many pickers apply a choice only when they close, and a person closes the menu they opened before calling it done:
    // the fixed Escape closes it once, then the page is read again so done is judged on the closed page.
    const closeMenuBeforeDone = async (): Promise<boolean> => {
      const node = [...this.#openedByRun].find(
        (n) => !this.#closedBeforeDone.has(n) && page.actions.some((a) => a.node === n && a.expanded === 'true'),
      );
      if (node === undefined || limit.stopped()) return false;
      this.#closedBeforeDone.add(node);
      await this.#recording?.step(this.#tab, page, { operation: 'PRESS_ESCAPE' });
      await this.#tab.dismissPopup();
      this.#history.push({
        operation: 'PRESS_ESCAPE',
        element: 'closed the menu this run opened before finishing',
        page_changed: true,
        confidence: 1,
      });
      page = await this.#observe();
      return true;
    };
    // Every way of ending `done` goes through here: undefined means a menu was closed first, so the loop decides again.
    const stopDone = async (reason: string, decision?: Decision): Promise<TaskSummary | undefined> => {
      if (await closeMenuBeforeDone()) return undefined;
      // The page may have turned into a bot check while Jev decided: done is never returned on one.
      if (!(await this.#tab.fresh(page))) {
        // A page that can't be read now keeps the done Jev decided on.
        const now = await this.#observe().catch(() => undefined);
        if (now && (await findBotWall(this.#tab, now))) {
          page = now;
          const { wall, waited } = await wallAfterWait();
          return wall ? stopAtWall(wall, decision, waited) : undefined;
        }
      }
      return stop('done', reason, decision);
    };

    // A loop guard fires on a page the actions may already have brought to the goal: take one last look before handing back.
    // Only progress guards stop here, so their stops are judgments the caller's checks may overturn.
    const stopAfterLastLook = async (status: TaskStatus, reason: string, decision: Decision): Promise<TaskSummary | undefined> => {
      const look = await this.#lastLook(page);
      if (look && (look.doneProbability ?? 0) >= LAST_LOOK_DONE) {
        this.trace.push({ decision: { ...look, action: look.action?.label }, executed: false, elapsed_ms: elapsed() });
        return stopDone(`Completion condition verified: ${doneWhen}`, look);
      }
      return stop(status, reason, decision, { overridable: true });
    };

    // jevway: a bot check offers nothing to act on, and the run never tries to get past one. It gets wallWaitMs to clear
    // itself (the page read again meanwhile), then, in a visible browser, a person gets waitForPersonSeconds to pass it;
    // once per call: one that comes back after clearing ends the run at once.
    let wallWaited = false;
    // Each kind of wall waits for a person once per call.
    const personWaited = new Set<PersonWall['kind']>();
    const waitForPerson = async (wall: PersonWall, isWall: (page: PageState) => Promise<boolean> | boolean, clearReads: number) => {
      if (personWaited.has(wall.kind)) return 'off';
      personWaited.add(wall.kind);
      const waited = await this.#waitForPerson(wall, page, { isWall, clearReads, limit });
      page = waited.page;
      return waited.outcome;
    };
    const wallAfterWait = async (): Promise<{ wall?: BotWall; cleared: boolean; waited?: number; byPerson?: boolean }> => {
      let wall = await findBotWall(this.#tab, page);
      if (!wall) return { cleared: false };
      if (wallWaited) return { wall, cleared: false };
      wallWaited = true;
      const deadline = performance.now() + this.#options.wallWaitMs;
      while (wall && performance.now() < deadline) {
        await limit.pause(WALL_POLL_MS);
        if (limit.stopped()) break;
        // A challenge that clears navigates: a page still loading is looked at again on the next poll.
        page = await this.#observe().catch((error) => {
          if (error instanceof StalePage) return page;
          throw error;
        });
        wall = await findBotWall(this.#tab, page);
      }
      if (!wall || limit.stopped()) return { wall, cleared: !wall };
      const outcome = await waitForPerson({ kind: 'bot_check', check: wall.name }, async (now) => Boolean(await findBotWall(this.#tab, now)), 1);
      // A tab that went away is the loop's to handle, as after any step.
      if (outcome === 'passed' || outcome === 'gone') return { cleared: true, byPerson: true };
      return { wall, cleared: false, ...(outcome === 'ran_out' && { waited: this.#options.waitForPersonSeconds }) };
    };

    const stopAtWall = (wall: BotWall, decision?: Decision, waited?: number): TaskSummary => {
      // A cancel or the time budget that cut the wait short is the reason the run ended.
      const halt = limit.stopped();
      if (halt) return stop(halt.status, halt.reason, decision);
      const { visible } = this.#person;
      return {
        ...stop('blocked', wallReason(wall, { visible, waited }), decision),
        wall: { kind: 'bot_check', origin: originOf(page.url), name: wall.provider, person_can_act: visible, ...(waited !== undefined && { waited_seconds: waited }) },
      };
    };

    // Browser and model errors end the run as `blocked`: the calling agent keeps the session and decides what next.
    try {
      // A dialog from before this call is told to Jev on the first step; one the page keeps raising ends the run.
      const repeatedAtStart = this.#reportDialogs(firstStep);
      if (repeatedAtStart) return stop('blocked', repeatedAtStart);
      page = await this.#observe();
      while (executed < maxSteps) {
        const halt = limit.stopped();
        if (halt) return stop(halt.status, halt.reason);
        // A tab opened (or closed) since the last look, by a late script: the checks below judge the tab in use.
        const switchedLate = await this.#switchTabs();
        if (switchedLate) page = await this.#afterSwitch(switchedLate, firstStep);
        this.#tellSteps(firstStep, page.url);
        // Never a decision on a page outside the hosts: a start page, a redirect or a late navigation that left them ends the run.
        const outside = outsideHosts(page.url, hosts);
        if (outside) return stop('blocked', `The page is outside this run's hosts: ${outside}; the run stopped without going back`);
        // The arm belongs to one step: a click that never reached the page leaves none for the next decision, on any tab.
        for (const tab of this.#tabs) tab.disarmConfirm();
        // Checked before a decision is spent: a challenge page has nothing for Jev to pick.
        const { wall, waited, byPerson } = await wallAfterWait();
        if (wall) return stopAtWall(wall, undefined, waited);
        // A person passed it (or its tab went away): the checks above run again on the page now.
        if (byPerson) continue;
        // An identity provider's sign-in for another site is the person's: with a visible browser it waits for them.
        const provider = ssoProviderOf(page.url);
        if (provider) {
          const origin = originOf(page.url);
          const outcome = await waitForPerson({ kind: 'sso', provider }, (now) => Boolean(ssoProviderOf(now.url)), 2);
          if (outcome === 'passed' || outcome === 'gone') continue;
          if (outcome === 'stopped') {
            const halt = limit.stopped()!;
            return stop(halt.status, halt.reason);
          }
          if (outcome === 'ran_out') {
            const waited = this.#options.waitForPersonSeconds;
            return {
              ...stop('blocked', ssoReason(provider, origin, waited)),
              wall: { kind: 'sign_in', origin, name: provider.toLowerCase(), person_can_act: true, waited_seconds: waited },
            };
          }
        }
        if (++decisions > maxSteps * 2) return stop('step_budget', `Made ${maxSteps * 2} decisions without finishing`);
        let decision: Decision;
        try {
          decision = await this.#decideWithRetry(page);
        } catch (error) {
          if (!(error instanceof StalePage)) throw error;
          page = await this.#observe();
          continue;
        }
        const doneProbability = decision.doneProbability ?? 0;
        doneStreak = doneProbability >= GUARDS.doneSteady ? doneStreak + 1 : 0;
        const steadyDone = doneStreak >= GUARDS.doneSustained;
        if (doneWhen && (doneProbability >= DONE_EVIDENT || steadyDone)) {
          // A single done spike that the next step confidently contradicts gets one screenshot look; `always` already saw a screenshot and `off` has nothing new to show.
          const lookFirst = !steadyDone && contradictsDoneSpike(decision, screenshots);
          const look = lookFirst ? await this.#lastLook(page) : undefined;
          // The spike that triggered the look stays in the trace ahead of it, confirmed or not.
          if (look) this.trace.push({ decision: { ...decision, action: decision.action?.label }, executed: false, elapsed_ms: elapsed() });
          if (!lookFirst || (look?.doneProbability ?? 0) >= SPIKE_CONFIRMED) {
            const verdict = look ?? decision;
            this.trace.push({ decision: { ...verdict, action: verdict.action?.label }, executed: false, elapsed_ms: elapsed() });
            const ended = await stopDone(`Completion condition verified: ${doneWhen}`, verdict);
            if (ended) return ended;
            continue;
          }
          if (look) this.trace.push({ decision: { ...look, action: look.action?.label }, executed: false, elapsed_ms: elapsed() });
        }
        const record = (didExecute: boolean) =>
          this.trace.push({
            decision: { ...decision, action: decision.action?.label },
            executed: didExecute,
            elapsed_ms: elapsed(),
          });

        // Blocked on a page that already meets the completion condition means there is nothing left to do.
        const blockedOnMetGoal =
          decision.operation === 'BLOCKED' && !decision.fieldsWithoutValue.length && doneProbability >= LAST_LOOK_DONE;
        if (doneWhen && blockedOnMetGoal) {
          record(false);
          if (this.#sendBackUnsavedEdit(decision, doneProbability)) {
            page = await this.#observe();
            continue;
          }
          const ended = await stopDone(`Completion condition verified: ${doneWhen}`, decision);
          if (ended) return ended;
          continue;
        }

        // jevway: an error the page shows after this call acted, or a sign-in wall no supplied value passes, is the caller's to handle.
        const signIn = this.#signInWall(decision, page);
        const error = executed > 0 ? this.#pageError(decision, page) : undefined;
        if (signIn || error) {
          record(false);
          if (!(await this.#tab.fresh(page))) {
            page = await this.#observe();
            continue;
          }
          if (signIn) {
            const wallPage = page;
            const outcome = await waitForPerson({ kind: 'sign_in', host: hostOf(page.url) }, (now) => stillSigningIn(now, wallPage), 2);
            if (outcome === 'passed' || outcome === 'gone') continue;
            const halt = limit.stopped();
            if (halt) return stop(halt.status, halt.reason, decision);
            const { visible } = this.#person;
            const waited = outcome === 'ran_out' ? this.#options.waitForPersonSeconds : undefined;
            return {
              ...stop('blocked', signInReason(signIn.origin, { visible, waited }), decision),
              wall: { ...signIn, person_can_act: visible, ...(waited !== undefined && { waited_seconds: waited }) },
            };
          }
          return stop('blocked', error!, decision);
        }

        decision = this.#openDisclosure(this.#boxRescue(decision, page), page);
        if (decision.operation === 'DONE' && doneWhen && (decision.doneProbability ?? 0) < 0.5) {
          record(false);
          if (++rejectedDone >= MAX_REJECTED_DONE) {
            return stop('uncertain', `Jev chose DONE ${rejectedDone}× but "${doneWhen}" is not visible`, decision, { overridable: true });
          }
          // Jev learns its DONE was premature, instead of proposing the same DONE on the same evidence.
          const unsaved = this.#unsavedToggle(page);
          const advice = unsaved ? `"${unsaved.label}" was changed and nothing on this page was clicked after it to save it` : 'keep working toward it';
          this.#history.push({
            operation: 'DONE',
            element: '',
            not_executed: `rejected: "${doneWhen}" is not visible yet; ${advice}`,
            confidence: round(decision.confidence),
          });
          await limit.pause(300);
          page = await this.#observe();
          continue;
        }

        if (decision.operation === 'DONE' && doneWhen && this.#sendBackUnsavedEdit(decision, decision.doneProbability ?? 0)) {
          record(false);
          page = await this.#observe();
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
          page = await this.#observe();
          continue;
        }
        const unpicked = this.#unpickedMenuValue(decision, page);
        if (unpicked) {
          this.#pickNoted.add(`${unpicked.option.node}:${unpicked.key}`);
          record(false);
          this.#history.push({
            operation: decision.operation,
            element: '',
            not_executed: `not accepted: the menu you opened lists "${unpicked.option.label}" (${unpicked.key}) and it isn't picked yet; pick it first, or answer BLOCKED`,
            confidence: round(decision.confidence),
          });
          page = await this.#observe();
          continue;
        }
        const undo = this.#undoesOwnToggle(decision, page);
        if (undo) {
          record(false);
          const state = undo.checked === 'true' ? 'checked' : 'unchecked';
          if (undo.noted) {
            return stop('blocked', `Jev chose "${undo.label}" again, which would undo this run's own change (it is now ${state}); say which state it should end in.`, decision);
          }
          undo.noted = true;
          // Jev can't see whether a change was saved; the run knows whether anything was clicked after it, so the note says which, instead of asking it to guess.
          const afterIt = undo.clickedAfter
            ? `"${undo.clickedAfter}" was clicked after it; clicking it again undoes it. Answer DONE if the goal is met, or BLOCKED`
            : 'nothing on this page was clicked after it to save it; clicking it again undoes it. Save it (a Save or Update button), or answer BLOCKED';
          this.#history.push({
            operation: decision.operation,
            element: '',
            not_executed: `not accepted: "${undo.label}" is now ${state} because this run clicked it, and ${afterIt}`,
            confidence: round(decision.confidence),
          });
          page = await this.#observe();
          continue;
        }
        const handBack = this.#handBack(decision, page);
        // A field the model has no value (or file) for is first a wrong turn, and only the second time a question for the caller.
        if (handBack?.[0] === 'needs_input' && ['TYPE_TEXT', 'UPLOAD'].includes(decision.operation) && !this.#refusedForValue.has(decision.action!.node!)) {
          this.#refusedForValue.add(decision.action!.node!);
          record(false);
          this.#history.push({
            operation: decision.operation,
            element: decision.action!.label,
            not_executed:
              decision.operation === 'UPLOAD'
                ? 'no supplied file fits this field; upload nothing here — choose another step, or BLOCKED if the goal needs a file you were not given'
                : 'no supplied value fits this field; type nothing here — choose another step, or BLOCKED if the goal needs a value you were not given',
            confidence: round(decision.confidence),
          });
          page = await this.#observe();
          continue;
        }
        if (handBack) {
          // A page still loading (skeleton rows have no text) gets up to changeWaitMs before the agent is asked for input or told the run is stuck.
          if (handBack[0] === 'needs_input' || handBack[0] === 'blocked') {
            const settled = await this.#awaitChange(page.fingerprint, page);
            if (settled.fingerprint !== page.fingerprint) {
              record(false);
              page = settled;
              continue;
            }
          }
          // A stop decided on a page that has since changed is stale: re-observe instead of reporting it.
          if (!(await this.#tab.fresh(page))) {
            record(false);
            page = await this.#observe();
            continue;
          }
          record(false);
          // An unsure step on a page the screenshot-backed completion check accepts has nothing left to do (6 of 6 uncertain endings at done check ≥ 0.75 were on the right page).
          const unsureOnMetGoal =
            handBack[0] === 'uncertain' && this.#lowConfidence(decision) && !this.#boxStop(decision) && decision.sawScreenshot;
          const [status, reason] =
            doneWhen && unsureOnMetGoal && doneProbability >= GUARDS.doneSteady
              ? (['done', `Completion condition verified: ${doneWhen}`] as const)
              : handBack;
          // Jev's own BLOCKED or unsure step is a judgment of progress; a submit the page already answered is not.
          const judged = decision.operation === 'BLOCKED' || status === 'uncertain';
          const ended = status === 'done' ? await stopDone(reason, decision) : stop(status, reason, decision, { overridable: judged });
          if (ended) return ended;
          continue;
        }

        const action = decision.action!;
        const text = decision.valueKey ? await this.#textFor(decision.valueKey, values) : undefined;
        let element: string;
        // jevway: the dialog a confirmed click opens is the same action asking again; any other dialog still gets the answer that changes nothing.
        if (isRiskyClick(decision) && this.#confirmedCommit) this.#tab.armConfirm([this.#confirmTarget ?? '', bareLabel(decision.action?.label ?? '')]);
        try {
          await this.#recording?.step(
            this.#tab,
            page,
            {
              operation: decision.operation,
              element: action.label,
              valueKey: decision.valueKey ?? undefined,
              fileKey: decision.fileKey ?? undefined,
              option: action.kind === 'select' ? String(action.value) : undefined,
              confidence: round(Math.min(decision.confidence, decision.targetConfidence ?? 1)),
            },
            decision.operation === 'CLICK_AT' ? decision.nextClick!.rect : action.rect,
          );
          // The last check before an input: a stop that came during the decision ends the run here, with nothing clicked.
          const halt = limit.stopped();
          if (halt) {
            this.#recording?.discardLast();
            record(false);
            return stop(halt.status, halt.reason, decision);
          }
          if (decision.operation === 'CLICK_AT') {
            const point = centerOf(decision.nextClick!.rect);
            element = `${await this.#tab.clickAt(point, page)} @ ${Math.round(point.x)},${Math.round(point.y)}`;
          } else {
            // A page whose text never stops changing (a ticking clock) would refuse a page-level key forever, while one refusal is
            // enough to wait out an animation: the third try runs even though the page changed.
            const forced = PAGE_LEVEL_KINDS.includes(action.kind) && this.#pageLevelStale >= 2;
            // A file comes only from the caller's declared files, by the key Jev chose; never from values.
            const outcome =
              action.kind === 'upload'
                ? await this.#tab.upload(action, page, this.#options.files[decision.fileKey!])
                : await this.#tab.act(action, page, text, forced ? { evenIfChanged: true } : undefined);
            // A scroll that moved nothing says so, or Jev keeps asking for it.
            element = outcome?.scrolled === 0 ? `${action.label} (nothing moved: there is no more to scroll this way)` : action.label;
          }
        } catch (error) {
          if (!(error instanceof StalePage)) throw error;
          record(false);
          if (!(error instanceof TargetUnreachable)) {
            // A page that re-renders faster than a decision takes would otherwise spend the steps' budget on clicks it never let run.
            decisions--;
            if (++staleRefusals > maxSteps * GUARDS.staleRefusalsPerStep) {
              return stop('blocked', `The page kept changing under the click: "${action.label}" was refused ${staleRefusals} times as stale`, decision);
            }
            if (PAGE_LEVEL_KINDS.includes(action.kind)) this.#pageLevelStale++;
            this.#recording?.discardLast();
            page = await this.#observe();
            continue;
          }
          // Unreachable on an unchanged page: retrying blind repeats the same miss, so Jev has to hear about it.
          this.#recording?.markUnreachable();
          // An open popup over the target (search suggestions, a menu) is closed with the fixed Escape key, once per
          // target, as a person would; no model output is involved. Then Jev re-decides on the cleared page.
          const popupOpen = error.byPopup || page.actions.some((a) => a.expanded === 'true');
          if (this.#unreachable.node !== action.node && popupOpen) {
            const halt = limit.stopped();
            if (halt) return stop(halt.status, halt.reason, decision);
            this.#unreachable = { node: action.node, count: 1 };
            await this.#recording?.step(this.#tab, page, { operation: 'PRESS_ESCAPE' });
            await this.#tab.dismissPopup();
            this.#history.push({
              operation: 'PRESS_ESCAPE',
              element: `closed the open popup covering "${action.label.slice(0, 80)}"`,
              page_changed: true,
              confidence: 1,
            });
            page = await this.#observe();
            continue;
          }
          const misses = this.#unreachable.node === action.node ? this.#unreachable.count + 1 : 1;
          this.#unreachable = { node: action.node, count: misses };
          // The run knows what covers the target; naming that layer's controls (already in Jev's list) lets Jev close it
          // instead of retrying the covered target.
          const covering = coveringLabels(error.coverNodes, page);
          const layer = covering.map((label) => `"${label}"`).join(', ');
          if (misses >= GUARDS.maxUnreachable) {
            const cause = layer ? `it is covered by a layer listing ${layer}` : 'something on the page covers it';
            return stop('blocked', `"${action.label}" could not be reached ${misses} times: ${cause}`, decision, { overridable: true });
          }
          if (misses === 2) {
            this.#history.push({
              operation: decision.operation,
              element: action.label,
              not_executed: layer
                ? `could not be reached: it is covered by a layer listing ${layer}; close that layer first (one of those), then try again`
                : 'could not be reached: another layer covers it; close that layer first',
              confidence: round(decision.confidence),
            });
          }
          page = await this.#observe();
          continue;
        }
        record(true);
        executed++;
        if (decision.via === 'disclosure') this.#opened.add(action.node!);
        this.#unreachable = { node: undefined, count: 0 };
        this.#pageLevelStale = 0;
        this.#lastTyped = decision.operation === 'TYPE_TEXT' && isSearchLike(action) ? action : undefined;
        if (decision.operation === 'TYPE_TEXT') this.#typedFields.push({ label: action.label, path: pathOf(page.url), ...(text && { value: text }) });
        // A value counts as used once it was typed, or a click or selection named it.
        const named = ['CLICK', 'SELECT'].includes(decision.operation) ? valueKeysIn(action.label, values) : [];
        for (const key of [...named, ...(decision.valueKey ? [decision.valueKey] : [])]) this.#usedValues.add(key);
        // A confirmation covers exactly one risky click.
        if (isRiskyClick(decision)) this.#spendConfirmation();
        // What a rejected submit is told from later: where the click was, what had been typed, and the page's text before it.
        const textBefore = page.text;
        const submitted =
          isRiskyClick(decision) && decision.action
            ? { label: bareLabel(decision.action.label), path: pathOf(page.url), fields: this.#typedOn(pathOf(page.url)), textBefore }
            : undefined;
        // A click while an edit is still unsaved is the save, whatever its risk.
        const clickedWithEditPending = decision.operation === 'CLICK' && this.#unsavedEdit !== undefined;

        const before = page.fingerprint;
        const pathBefore = pathOf(page.url);
        const unsavedBefore = this.#unsavedEdit;
        const ran = {
          operation: decision.operation,
          element,
          ...(decision.valueKey && { value_key: decision.valueKey }),
          ...(decision.fileKey && { file_key: decision.fileKey }),
        };
        const confidence = round(Math.min(decision.confidence, decision.targetConfidence ?? 1));
        let switched: 'opened' | 'closed' | undefined;
        try {
          // A tab the action opened is followed before the page is read; a tab it closed is left for the one before it.
          switched = await this.#switchTabs();
          page = await this.#observe().catch(async (error) => {
            if (!(error instanceof StalePage) || !this.#tab.closed) throw error;
            switched = await this.#switchTabs();
            return this.#observe();
          });
          // A slow click handler or a loading page hasn't reacted yet: a person waits a moment before trying again.
          if (!switched && page.fingerprint === before) {
            page = await this.#awaitChange(before, page);
            switched = await this.#switchTabs();
            if (switched) page = await this.#observe();
          }
        } catch (error) {
          // An action that ran is reported even when the page can't be read afterwards, so the caller never repeats it blindly.
          this.#history.push({ ...ran, confidence });
          throw error;
        }
        const field = decision.operation === 'TYPE_TEXT' && page.actions.find((a) => a.kind === 'fill' && a.node === action.node);
        this.#history.push({
          ...ran,
          // A field that is gone (navigated, submitted) can't say; one still on the page must show what was typed.
          ...(field && { value_kept: field.value === this.#scrub(text) }),
          page_changed: page.fingerprint !== before,
          confidence,
        });
        if (switched) page = await this.#afterSwitch(switched, firstStep, page);
        // A click can leave the site as surely as a navigation: nothing else runs on a page outside the hosts (no guard, look or Escape).
        const left = outsideHosts(page.url, hosts);
        if (left) return stop('blocked', `After "${element}" the page is outside this run's hosts: ${left}; the run stopped without going back`, decision);
        this.#unsavedEdit = isUnsavedEdit(decision.operation, action, page) ? { noted: false, label: action.label } : undefined;
        if (decision.operation === 'CLICK') this.#recordToggle(action, pathBefore, page);
        // ...and what the page said right after it.
        if (submitted) {
          this.#submits = [...this.#submits, { ...submitted, answer: newTextOf(page.text, submitted.textBefore) }].slice(-SUBMITS_KEPT);
        }
        this.#lastNewText = newTextOf(page.text, textBefore) || undefined;
        if (submitted || (clickedWithEditPending && !this.#unsavedEdit)) this.#said = this.#saidAfter(bareLabel(action.label), page, textBefore);
        // A click that flipped a collapsed control open leaves the run's own menu: it is closed before the run says done.
        // A fold the disclosure rescue opened is for reading what is inside it, so it stays open.
        if (decision.operation === 'CLICK' && decision.via !== 'disclosure' && action.expanded === 'false' && page.actions.some((a) => a.node === action.node && a.expanded === 'true')) {
          this.#openedByRun.add(action.node!);
        }
        const repeatedDialog = this.#reportDialogs(
          firstStep,
          decision.operation === 'CLICK' ? { action, path: pathBefore, unsaved: unsavedBefore } : undefined,
        );
        this.#tab.disarmConfirm();
        if (repeatedDialog) return stop('blocked', repeatedDialog, decision);
        if (repeatingWithoutEffect(this.#history)) {
          const ended = await stopAfterLastLook('blocked', 'The last 3 actions did not change the page', decision);
          if (ended) return ended;
          continue;
        }
        if (wandering(this.#history.slice(firstStep))) {
          const ended = await stopAfterLastLook('uncertain', `Jev was unsure for ${GUARDS.wanderSteps} actions in a row (confidence under ${GUARDS.wanderConfidence})`, decision);
          if (ended) return ended;
          continue;
        }
        // Waiting is bounded by maxSteps and the wander guard; a shimmering skeleton must not look like a toggle loop.
        if (decision.operation !== 'WAIT') this.#outcomes.push({ action: `${decision.operation} ${element}`, print: page.fingerprint });
        if (togglingInPlace(this.#outcomes)) {
          const ended = await stopAfterLastLook('blocked', `"${element}" only toggles the page back and forth (${GUARDS.toggleLoop}× in a row)`, decision);
          if (ended) return ended;
          continue;
        }
        if (repeating(this.#outcomes)) {
          const ended = await stopAfterLastLook('blocked', `"${element}" was used ${GUARDS.repeatLimit} times in ${GUARDS.repeatWindow} actions without finishing`, decision);
          if (ended) return ended;
          continue;
        }
      }
      return stop('step_budget', `Reached ${maxSteps} actions without finishing`);
    } catch (error) {
      if (error instanceof RunStopped) return stop(error.status, error.reason);
      return stop('blocked', describeError(error));
    } finally {
      for (const tab of this.#tabs) tab.disarmConfirm();
    }
  }

  // jevway: the caller's checks are facts about the final page, so they settle the status the loop chose. A failed
  // check overturns `done`; passing checks finish a hand-back only together with a done_when score made on that same
  // page, because the checked text may have been there before the run. Questions for the caller are never changed.
  #settle(summary: TaskSummary): TaskSummary {
    const { checks, doneWhen } = this.#options;
    if (!checks.length || !this.#ending) return summary;
    const { page, decision, overridable } = this.#ending;
    // The page was scrubbed when read, so a check naming a secret is read the same way.
    const results = runChecks(this.#scrub(checks), page);
    const failed = results.filter((result) => !result.pass);
    if (summary.status === 'done' && failed.length) {
      this.#lastStatus = 'uncertain';
      const listed = failed.map(describeFailure).join('; ');
      return { ...summary, status: 'uncertain', reason: `Jev reported done, but ${failed.length} of ${results.length} checks failed on the final page: ${listed}`, checks: results };
    }
    const score = decision && this.#decidedOn.get(decision) === page ? decision.doneProbability : undefined;
    // The same bars a DONE needs, and the higher one right after an edit that nothing saved yet.
    const bar = this.#unsavedEdit ? GUARDS.doneSteady : LAST_LOOK_DONE;
    if (overridable && ['blocked', 'uncertain'].includes(summary.status) && !failed.length && doneWhen && score !== undefined && score >= bar) {
      this.#lastStatus = 'done';
      const { stuck: _stuck, ...rest } = summary;
      const reason = `All ${results.length} checks passed on the final page and "${doneWhen}" scored ${round(score)} there (the run had ended ${summary.status}: ${summary.reason})`;
      return { ...rest, status: 'done', reason, checks: results };
    }
    return { ...summary, checks: results };
  }

  // jevway: a done carries the span of the final page that shows done_when, chosen by Jev and copied by code, so the caller
  // can check it at a glance. A failed request, `absent` or an unsure answer leaves it out; the status never changes.
  async #withEvidence(summary: TaskSummary): Promise<TaskSummary> {
    const { doneWhen } = this.#options;
    if (summary.status !== 'done' || !doneWhen || !this.#ending) return summary;
    const { page, firstRequest } = this.#ending;
    const spans = quoteSpans(page.text);
    if (!spans.length) return summary;
    const started = performance.now();
    // A call already stopped asks nothing more; the request is scrubbed like every other and stops with the run.
    const limit = this.#limit;
    if (limit?.stopped()) return summary;
    const request = this.#scrub(evidenceRequest(page, doneWhen, spans.map((span) => span.text)));
    let response: Awaited<ReturnType<Ask>>;
    try {
      response = await (limit ? limit.within(this.#ask(request, { signal: limit.signal })) : this.#ask(request));
    } catch {
      return summary;
    }
    const latencyMs = Math.round(performance.now() - started);
    const inputTokens = response.usage.input_tokens ?? 0;
    this.#latencies.push(latencyMs);
    this.#inputTokens += inputTokens;
    const counted: TaskSummary = {
      ...summary,
      elapsed_ms: summary.elapsed_ms + latencyMs,
      jev: {
        ...summary.jev,
        requests: summary.jev.requests + 1,
        input_tokens: summary.jev.input_tokens + inputTokens,
        median_latency_ms: median(this.#latencies.slice(firstRequest)),
        ...this.#costOf(summary.jev.input_tokens + inputTokens),
      },
    };
    let chosen: ReturnType<typeof readEvidence>;
    try {
      chosen = readEvidence(response.answers, spans.length);
    } catch {
      return counted;
    }
    const candidates = Object.entries(chosen.probabilities)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([id, probability]) => ({ element: spans[Number(id) - 1]?.text.slice(0, 80) ?? id, probability: round(probability) }));
    this.trace.push({
      decision: { operation: 'EVIDENCE', confidence: chosen.confidence, candidates, answers: response.answers, fieldsWithoutValue: [], requests: 1, inputTokens, latencyMs },
      executed: false,
      elapsed_ms: counted.elapsed_ms,
    });
    const span = chosen.index !== undefined && chosen.confidence >= EVIDENCE_SURE ? spans[chosen.index] : undefined;
    if (!span) return counted;
    const link = deepLink(page.url, span, page.text);
    return { ...counted, evidence: { quote: span.text, url: page.url, ...(link && { deep_link: link }), confidence: round(chosen.confidence) } };
  }

  // Tells Jev about the dialogs the page opened since the last look, on the latest step of this call (or the next one, when
  // there is none yet). Returns a reason when a dialog we only ever decline keeps coming back: the run must end then.
  // `click` is the click that ran just before, with what the run had left unsaved on its page.
  #reportDialogs(firstStep: number, click?: { action: PageAction; path: string; unsaved?: { label: string } }): string | undefined {
    let repeated: string | undefined;
    let saveFirst: string | undefined;
    for (const dialog of this.#tab.takeDialogs()) {
      // A dialog is page content the run never observed: scrubbed here, before the cut, like every observed page.
      const message = this.#scrub(dialog.message).slice(0, DIALOG_MESSAGE_CHARS);
      this.#dialogNotes.push(`the page then ${describeDialog(dialog.type, message, dialog.accepted)}`);
      // jevway: a page asking before you leave means the run's own edit isn't saved, and a person saves first.
      const unsaved = dialog.type === 'beforeunload' && click ? this.#unsavedOn(click.path, click.unsaved) : undefined;
      if (unsaved && click) {
        const clicked = String(click.action.node ?? click.action.label);
        if (this.#leaveNoted.has(clicked)) {
          repeated ??= `Leaving the page would discard the ${unsaved} (the page asked before leaving); save it first, or ask the user whether to discard it.`;
        } else {
          this.#leaveNoted.add(clicked);
          saveFirst = `${click.action.role === 'link' ? 'this link' : 'this click'} would leave the page with ${unsaved}; save it first (a Save or Update button), or answer BLOCKED`;
        }
        continue;
      }
      const key = `${dialog.type}\n${message}`;
      const seen = (this.#dialogsSeen.get(key) ?? 0) + 1;
      this.#dialogsSeen.set(key, seen);
      // An alert's OK and the OK for a confirmed click's own confirm are no loop; a declined confirm, prompt or leave-the-page prompt that returns is.
      if (seen > 1 && !dialog.accepted) {
        repeated ??= `The page keeps asking ${message ? `"${message}" ` : ''}(${dialog.type} dialog). jevway only answers Cancel to these; ask the user how to proceed.`;
      }
    }
    const last = this.#history.length - 1;
    if (this.#dialogNotes.length && last >= firstStep) {
      const entry = this.#history[last];
      this.#history[last] = { ...entry, element: `${entry.element} ${this.#dialogNotes.splice(0).map((note) => `(${note})`).join(' ')}` };
    }
    if (saveFirst && last >= firstStep) this.#history[last] = { ...this.#history[last], not_executed: saveFirst };
    return repeated;
  }

  // What the run left unsaved on the page a click was made on: the last field typed there, else the control last ticked.
  #unsavedOn(path: string, ticked?: { label: string }) {
    const typed = this.#typedFields.filter((field) => field.path === path).at(-1);
    if (typed) return `unsaved text in "${typed.label}"`;
    return ticked ? `unsaved changes to "${ticked.label}"` : undefined;
  }

  // The reason to hand back when Jev says the page shows an error and the page has new words to quote: the page message, else
  // the lines the last action brought. An error read from text that was there before the action is not the run's doing.
  #pageError(decision: Decision, page: PageState): string | undefined {
    if ((decision.answers.page_error?.noul ?? 0) < PAGE_ERROR_STOP) return undefined;
    const said = this.#said?.path === pathOf(page.url) ? this.#said.text : undefined;
    const quote = said ?? this.#lastNewText;
    const last = this.#history.findLast((step) => !step.not_executed);
    if (!quote || !last) return undefined;
    return `The page shows an error after "${last.element}": "${quote}"; tell the user what it says, or call again with other values.`;
  }

  // A sign-in wall the run can't pass: Jev says the screen blocks the goal, it has an empty field, and no supplied value fits any empty one.
  #signInWall(decision: Decision, page: PageState): TaskSummary['wall'] {
    if ((decision.answers.sign_in_wall?.noul ?? 0) < SIGN_IN_WALL_STOP) return undefined;
    const emptyFields = page.actions.filter((action) => action.kind === 'fill' && !action.value).map((action) => action.label);
    const emptyPassword = page.passwordFields?.some((field) => !field.filled) ?? false;
    if (!emptyFields.length && !emptyPassword) return undefined;
    if (!emptyFields.every((label) => decision.fieldsWithoutValue.includes(label))) return undefined;
    return { kind: 'sign_in', origin: originOf(page.url) };
  }

  // Keeps observing a page that still looks like `before`; stops at the first change, after changeWaitMs, or when the call is stopped.
  async #awaitChange(before: string, page: PageState): Promise<PageState> {
    const deadline = performance.now() + this.#options.changeWaitMs;
    while (page.fingerprint === before && performance.now() < deadline && !this.#limit?.stopped()) {
      await (this.#limit?.pause(CHANGE_POLL_MS) ?? new Promise((resolve) => setTimeout(resolve, CHANGE_POLL_MS)));
      if (this.#limit?.stopped()) break;
      page = await this.#observe();
    }
    return page;
  }

  // A transient model error (5xx, 429, network, timeout) gets one more try; any other error ends the run.
  async #decideWithRetry(page: PageState): Promise<Decision> {
    try {
      return await this.#decide(page);
    } catch (error) {
      if (!(error instanceof ModelCallError) || !isTransientModelError(error)) throw error;
      await (this.#limit?.pause(MODEL_RETRY_MS) ?? new Promise((resolve) => setTimeout(resolve, MODEL_RETRY_MS)));
      return this.#decide(page);
    }
  }

  // One more decision on the current page, with a screenshot unless the profile is text-only; a failure is ignored so
  // the guard's own stop stands. Only worth a request when there is completion evidence to check.
  async #lastLook(page: PageState): Promise<Decision | undefined> {
    if (!this.#options.doneWhen) return undefined;
    try {
      return await this.#decide(page, { lastLook: true });
    } catch (error) {
      // A cancel or time stop is not the look failing: it ends the call.
      if (error instanceof RunStopped) throw error;
      return undefined;
    }
  }

  // One decision per step; `fallback` takes a second, screenshot-backed look at a shaky or stalled one.
  async #decide(page: PageState, { lastLook = false } = {}): Promise<Decision> {
    const { goal, values, secretKeys, doneWhen, screenshots, compactRules, elementRisk, pageRisk, imageTransport, box, minConfidence } = this.#options;
    // No request starts after a stop.
    const halt = this.#limit?.stopped();
    if (halt) throw halt;
    this.#rememberLines(page);
    const limit = this.#limit;
    // Every request carries the call's stop signal (it cancels the HTTP request, its retries and a Retry-After sleep), and
    // is raced against it as well, so a stop never waits on the model.
    const ask: Ask = limit ? (request) => limit.within(this.#ask(request, { signal: limit.signal })) : this.#ask;
    const decideOn = async (withScreenshot: boolean) => {
      const shot = withScreenshot ? this.#tab.markedScreenshot(buildActionSpace(page.actions).marks, page) : undefined;
      const screenshot = shot && (await (limit ? limit.within(shot) : shot));
      const decision = await decide(ask, {
        page: this.#withSaid(this.#withKeys(page)),
        goal,
        // An authenticator key is offered like a secret value: Jev sees its marker, never the secret.
        values: { ...values, ...Object.fromEntries([...this.#totp].map(([key, secret]) => [key, secret.base32])) },
        secretKeys,
        files: fileNames(this.#options.files),
        history: this.#history.slice(-10),
        doneWhen,
        checkCommitRisk: true,
        screenshot,
        compactRules,
        imageTransport,
        box,
        unsureBelow: minConfidence,
        ...(elementRisk && { elementRisk: 'chosen' as const, pageRisk }),
      }).catch((error) => {
        if (error instanceof RunStopped) throw error;
        // Only the model call is tagged: a failed screenshot above is a browser error and keeps its own type.
        throw new ModelCallError(messageOf(error));
      });
      this.#latencies.push(decision.latencyMs);
      this.#inputTokens += decision.inputTokens;
      if (screenshot) this.#screenshots++;
      this.#decidedOn.set(decision, page);
      return decision;
    };
    const withScreenshot = screenshots === 'always' || (lastLook && screenshots !== 'off');
    const first = await decideOn(withScreenshot);
    return screenshots === 'fallback' && !withScreenshot && this.#needsSecondLook(first, page) ? decideOn(true) : first;
  }

  #needsSecondLook(decision: Decision, page: PageState) {
    const { doneWhen } = this.#options;
    const handBack = this.#handBack(decision, page)?.[0];
    const last = this.#history.at(-1);
    return (
      handBack === 'uncertain' ||
      handBack === 'blocked' ||
      (decision.operation === 'DONE' && !!doneWhen && (decision.doneProbability ?? 0) < 0.5) ||
      isGrayZoneClick(decision) ||
      (last?.page_changed === false && last.operation !== 'WAIT')
    );
  }

  #rememberLines(page: PageState) {
    const path = pathOf(page.url);
    const seen = this.#seenLines.get(path) ?? new Set<string>();
    for (const line of linesOf(page.text)) if (seen.size < SEEN_LINES_PER_PATH) seen.add(line);
    this.#seenLines.set(path, seen);
  }

  // jevway: what the page said after the last submit is the first line of the text Jev reads. The done check judges the current
  // page's text only, so a "saved" message that scrolled away (or sits above the viewport) is no evidence unless the text carries it.
  // It stays while the run is on the path where the message appeared; the caller's page_text is never changed.
  #withSaid(page: PageState): PageState {
    if (this.#said && this.#said.path !== pathOf(page.url)) this.#said = undefined;
    if (!this.#said) return page;
    return { ...page, text: `[Page message after "${this.#said.label}"] ${this.#said.text}\n${page.text}` };
  }

  // The lines the page now shows that this run never saw on its path. The previous message of a submit doesn't count as seen, so a repeated one is quoted again.
  #saidAfter(label: string, page: PageState, textBefore: string) {
    const path = pathOf(page.url);
    const known = new Set([...(this.#seenLines.get(path) ?? []), ...linesOf(textBefore)]);
    for (const line of this.#said?.lines ?? []) known.delete(line);
    const lines = unseenLines(page.text, known);
    const text = lines.join(' ').slice(0, SUBMIT_ANSWER_CHARS);
    return text ? { label, path, lines, text } : undefined;
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
      // The box's own risk rates the control the model means, not necessarily the element under the box: with by-name judging on, the rescued element is judged by name too (unjudged counts as certain risk); with it off, only the box risk exists.
      const commitRisk = Math.max(next.commitRisk, this.#options.elementRisk ? (decision.elementRisks?.[next.match] ?? 1) : 0);
      return { ...rescued, operation: 'CLICK', action, target: next.match, commitRisk };
    }
    return this.#options.allowCoordinateClicks ? { ...rescued, operation: 'CLICK_AT' } : decision;
  }

  // A person opens the folded section they were already looking at before giving up: BLOCKED, yet the click head leans
  // toward a collapsed control. It then faces the same hand-back checks as any click, judged by name when that is on.
  // A person unsure where to go on a narrow screen opens the "+1" that says something is hidden before giving up: an
  // unsure step tries the overflow controls too, unless the screenshot-backed check already accepts the goal (that is `done`).
  #openDisclosure(decision: Decision, page: PageState): Decision {
    const blocked = decision.operation === 'BLOCKED';
    const goalMet = !!this.#options.doneWhen && !!decision.sawScreenshot && (decision.doneProbability ?? 0) >= GUARDS.doneSteady;
    const unsure = !blocked && !goalMet && this.#lowConfidence(decision) && !['WAIT', 'PRESS_ESCAPE'].includes(decision.operation);
    if (blocked ? decision.fieldsWithoutValue.length : !unsure) return decision;
    const { minConfidence, elementRisk } = this.#options;
    const clicks = buildActionSpace(page.actions).targets.CLICK ?? {};
    const favourite = blocked ? foldedFavourite(decision.answers, clicks) : undefined;
    const likely = favourite && favourite.probability >= minConfidence && !this.#opened.has(favourite.action.node!) ? favourite : undefined;
    // A person who can't find something opens the "+1" / "More" overflow first, even when it looks unlikely.
    const folded = likely ?? overflowFolds(decision.answers, clicks).find((fold) => !this.#opened.has(fold.action.node!));
    if (!folded) return decision;
    // A fold is collapsed by definition: as for any collapsed control, only its name is judged (the page-level question reads the page).
    const commitRisk = elementRisk ? (decision.elementRisks?.[folded.id] ?? 1) : (decision.commitRisk ?? 1);
    return {
      ...decision,
      via: 'disclosure' as const,
      operation: 'CLICK',
      action: folded.action,
      target: folded.id,
      // An overflow try is deliberate but not confident: it sits at the bar, so the unsure guard lets it run.
      confidence: likely ? folded.probability : minConfidence,
      targetConfidence: undefined,
      // An unsure TYPE_TEXT carried a value for its own field, not for this click.
      valueKey: undefined,
      valueConfidence: undefined,
      commitRisk,
    };
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

  // A typed or ticked change isn't done until it's saved, and a person clicks Save. Right after one, a done check under the
  // steady bar sends the DONE (or BLOCKED-as-done) back once per edit instead of stopping on an unsaved form.
  #sendBackUnsavedEdit(decision: Decision, doneProbability: number) {
    const edit = this.#unsavedEdit;
    if (!edit || edit.noted || doneProbability >= GUARDS.doneSteady) return false;
    edit.noted = true;
    this.#history.push({ operation: 'DONE', element: '', not_executed: UNSAVED_EDIT_NOTE, confidence: round(decision.confidence) });
    return true;
  }

  // The fields typed into on this path: a search box used on an earlier page isn't part of this form.
  #typedOn(path: string) {
    return [...new Set(this.#typedFields.filter((field) => field.path === path).map((field) => field.label))];
  }

  // A person who opened a menu to pick a supplied value picks it before pressing the button that sends the form: a risky click
  // elsewhere, while a menu this run opened still lists that value unpicked, is sent back once per option.
  #unpickedMenuValue(decision: Decision, page: PageState): { option: PageAction; key: string } | undefined {
    if (!isRiskyClick(decision)) return undefined;
    const menuOpen = [...this.#openedByRun].some((node) => page.actions.some((a) => a.node === node && a.expanded === 'true'));
    if (!menuOpen) return undefined;
    for (const option of page.actions) {
      if (option.kind !== 'click' || !MENU_OPTION_ROLES.includes(option.role ?? '') || option.node === decision.action?.node) continue;
      if (option.checked === 'true' || option.selected === 'true') continue;
      const key = valueKeysIn(option.label, this.#options.values).find(
        (candidate) => !this.#usedValues.has(candidate) && !this.#pickNoted.has(`${option.node}:${candidate}`),
      );
      if (key) return { option, key };
    }
    return undefined;
  }

  // What a click left a checkbox or switch showing, when it flipped it; any other click is the first one after the changes made on its path.
  #recordToggle(action: PageAction, pathBefore: string, page: PageState) {
    const label = bareLabel(action.label);
    const now =
      isToggle(action) && pathOf(page.url) === pathBefore
        ? page.actions.find((listed) => listed.kind === 'click' && listed.checked && bareLabel(listed.label) === label)
        : undefined;
    if (now?.checked && now.checked !== action.checked) {
      this.#toggled.set(toggleKey(pathBefore, label), { label, checked: now.checked, noted: false });
      return;
    }
    for (const [key, toggle] of this.#toggled) {
      if (key.startsWith(toggleKey(pathBefore, '')) && !toggle.clickedAfter) toggle.clickedAfter = label;
    }
  }

  // A change this run made on this page that nothing was clicked after, still showing what the run left.
  #unsavedToggle(page: PageState) {
    return [...this.#toggled]
      .filter(([key, toggle]) => key.startsWith(toggleKey(pathOf(page.url), '')) && !toggle.clickedAfter)
      .map(([, toggle]) => toggle)
      .find((toggle) =>
        page.actions.some((listed) => listed.kind === 'click' && listed.checked === toggle.checked && bareLabel(listed.label) === toggle.label),
      );
  }

  // A person who just flipped a box doesn't flip it back; they save, or they're done. A click on the same box (path and label), still
  // showing what the run left it as, is told so once, and handed back the second time.
  #undoesOwnToggle(decision: Decision, page: PageState) {
    const action = decision.action;
    if (decision.operation !== 'CLICK' || !action || !isToggle(action)) return undefined;
    const flipped = this.#toggled.get(toggleKey(pathOf(page.url), bareLabel(action.label)));
    return flipped?.checked === action.checked ? flipped : undefined;
  }

  // A form that came back with new text after its submit was rejected, and sending the same values again repeats the
  // rejection: the same click, on the same path, with every typed field still listed. A page that moved on (another path,
  // a wizard's next step where the fields are gone) is a new form, and a click with nothing typed before it (a list of
  // Delete buttons) says nothing about this one.
  #rejectedSubmit(decision: Decision, page: PageState): Submit | undefined {
    if (!decision.action) return undefined;
    const label = bareLabel(decision.action.label);
    const path = pathOf(page.url);
    return [...this.#submits]
      .reverse()
      .find(
        (submit) =>
          submit.label === label &&
          submit.path === path &&
          submit.answer &&
          submit.fields.length > 0 &&
          submit.fields.every((field) => page.actions.some((listed) => listed.kind === 'fill' && listed.label === field)),
      );
  }

  #spendConfirmation() {
    this.#confirmedCommit = false;
    this.#confirmTarget = undefined;
    this.#confirmedControl = undefined;
  }

  // A confirmation is for the target the user named, so it carries their words and the page must show them. A category
  // ("anything unused") names nothing on a page: this is what keeps it from deleting.
  #targetRefusal(decision: Decision, page: PageState): string | undefined {
    const label = decision.action?.label ?? 'the control boxed on the screenshot';
    const target = this.#confirmTarget?.trim();
    if (!target) return `confirm_irreversible needs confirm_target: the words from the user's request that name what "${label}" acts on.`;
    const typedHere = this.#typedFields.filter((field) => field.path === pathOf(page.url)).map((field) => field.value ?? '');
    if (showsTarget(target, decision.action?.label ?? '', [page.title, decoded(page.url), page.text, ...typedHere])) return undefined;
    const title = page.title.slice(0, CONFIRM_TITLE_CHARS);
    return `confirm_target "${target}" names nothing "${label}" acts on here (${title ? `page "${title}", ` : ''}its address, the visible text or the values typed on this page); ask the user which one they mean.`;
  }

  // Returns [status, reason] when this decision is the calling agent's to make.
  #handBack(decision: Decision, page: PageState): [TaskStatus, string] | undefined {
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
    // Waiting can't hurt, and neither can closing an open menu with the fixed Escape key: an unsure WAIT or PRESS_ESCAPE
    // just runs (the wander guard and step budget still bound both).
    if (this.#lowConfidence(decision) && !['WAIT', 'PRESS_ESCAPE'].includes(decision.operation)) {
      const confidence = Math.min(decision.confidence, decision.targetConfidence ?? 1);
      return [
        'uncertain',
        `Next step "${decision.operation} ${decision.action?.label ?? ''}" had confidence ${round(confidence)}`,
      ];
    }
    if (decision.operation === 'TYPE_TEXT' && !decision.valueKey) {
      return ['needs_input', `No supplied value fits the field "${decision.action!.label}"`];
    }
    // A confirmation answers the question about one control: another risky control is a new question, whatever the page shows.
    const confirmed = this.#confirmedControl;
    if (isRiskyClick(decision) && this.#confirmedCommit && confirmed && !sameControl(confirmed, controlOf(decision, page))) {
      const given = `The confirmation given was for ${confirmed.coordinate ? 'a click by on-screen position' : `"${confirmed.label}"`} on ${confirmed.path}, a different control, so it was not used.`;
      return ['needs_confirmation', irreversibleReason(decision, page, given)];
    }
    if (decision.operation === 'UPLOAD' && !decision.fileKey) {
      return ['needs_input', `No supplied file fits the file field "${decision.action!.label}"`];
    }
    if (isRiskyClick(decision) && this.#confirmedCommit) {
      const refusal = this.#targetRefusal(decision, page);
      if (refusal) return ['needs_confirmation', refusal];
    }
    if (isRiskyClick(decision) && !this.#confirmedCommit) {
      const rejected = this.#rejectedSubmit(decision, page);
      if (rejected) {
        return [
          'blocked',
          `"${rejected.label}" was already submitted on this page, and the page then said: "${rejected.answer}". Submitting it again would repeat the same request; tell the user what the page says.`,
        ];
      }
      return ['needs_confirmation', irreversibleReason(decision, page)];
    }
    return undefined;
  }
}

// The page title says which target the click acts on (a repository, an order), for the agent to hold against the user's words.
// It always starts `Clicking "<label>"`: agents and the job runner read the control from there.
const irreversibleReason = (decision: Decision, page: PageState, note?: string) => {
  const title = page.title.slice(0, CONFIRM_TITLE_CHARS);
  return `Clicking "${decision.action?.label ?? 'the control boxed on the screenshot'}"${title ? ` on "${title}"` : ''} looks irreversible (risk ${round(decision.commitRisk!)}).${note ? ` ${note}` : ''} Confirm only if the user's request named this action and this target; a category ("anything unused", "old ones") names no target: list the candidates and ask the user. To continue, call again with confirm_irreversible and confirm_target (the user's words naming the target).`;
};

/** A control a confirmation is about: its label on a page path, or a click by on-screen position on that path. */
interface Control {
  path: string;
  label: string;
  coordinate: boolean;
}

// Only the pathname: a single-page app rewrites its query string (filters, a peek panel) without changing the control,
// while the pathname names the object a form acts on. The full label carries a row's context, so another row's "Delete" differs.
const controlOf = (decision: Decision, page: PageState): Control => ({
  path: pathnameOf(page.url),
  label: decision.operation === 'CLICK_AT' ? '' : bareLabel(decision.action?.label ?? ''),
  coordinate: decision.operation === 'CLICK_AT',
});

// The fields a needs_input wants: the one Jev chose to type into, or every empty field a BLOCKED found no value for, in page order.
const missingFields = (decision: Decision, page: PageState) => {
  const fields: Pick<PageAction, 'label' | 'role'>[] =
    decision.operation === 'TYPE_TEXT' && decision.action
      ? [decision.action]
      : decision.fieldsWithoutValue.map((label) => page.actions.find((action) => action.kind === 'fill' && action.label === label) ?? { label });
  return fields.map((field) => ({ label: bareLabel(field.label), ...(field.role && { role: field.role }), path: pathnameOf(page.url) }));
};

const sameControl = (a: Control, b: Control) => a.path === b.path && a.label === b.label && a.coordinate === b.coordinate;

const pathnameOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

// Optional MCP/CLI arguments arrive as explicit undefined; they must not erase defaults or earlier values.
const definedOnly = <T extends object>(options: T) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;

// A risky click that ran: where it was, what had been typed, and the page's new text right after it.
interface Submit {
  label: string;
  path: string;
  fields: string[];
  textBefore: string;
  answer: string;
}

const decoded = (url: string) => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};

const bareLabel = (label: string) => label.replace(/ \(appears on hover\)$/, '');

/** Up to 3 labels, in list order and cut at 40 characters, of the listed controls inside the layer covering a target; none when nothing usable names it. */
const coveringLabels = (coverNodes: number[], page: PageState) =>
  page.actions
    .filter((listed) => listed.node !== undefined && coverNodes.includes(listed.node))
    .map((listed) => bareLabel(listed.label))
    .filter((label) => label.trim())
    .slice(0, 3)
    .map((label) => label.slice(0, 40));

// The keys of the supplied values a control's label names (case-insensitive, three characters at least, not a page-wide label).
const valueKeysIn = (label: string, values: Record<string, string>) =>
  label.length > 80
    ? []
    : Object.entries(values)
        .filter(([, value]) => value.trim().length >= 3 && label.toLowerCase().includes(value.trim().toLowerCase()))
        .map(([key]) => key);

// The URL path plus search, without the hash: the same form comes back on the same one.
const pathOf = (url: string) => {
  try {
    const { pathname, search } = new URL(url);
    return pathname + search;
  } catch {
    return url;
  }
};

// A line with no words, only digits, separators and a unit (a footer's "2ms" render time), changes on every load and says nothing the page did.
const NO_WORDS = /^[\d\s.,:%]+(ms|s|%)?$/i;

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

const linesOf = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

// The lines of `text` that are not in `known`; the reader's own password and loading lines say nothing the page did.
const unseenLines = (text: string, known: Set<string>) =>
  linesOf(text).filter((line) => !known.has(line) && !line.startsWith('Password field "') && !line.startsWith('Loading: ') && !NO_WORDS.test(line));

// The lines of the page's text now that were not there before, trimmed and joined.
const newTextOf = (text: string, before: string) => unseenLines(text, new Set(linesOf(before))).join(' ').slice(0, SUBMIT_ANSWER_CHARS);

const isSearchLike = (field: PageAction) =>
  ['searchbox', 'combobox'].includes(field.role ?? '') || SEARCH_LIKE.test(field.label);

// Typing into a field or ticking a checkbox, radio or switch changes a form without saving it; a search or filter box has
// nothing to save. A tick counts only while the control is still listed afterwards: a picker option that closes on click applied at once.
const isUnsavedEdit = (operation: string, action: PageAction | undefined, pageAfter: PageState) =>
  !!action &&
  ((operation === 'TYPE_TEXT' && !isSearchLike(action)) ||
    (operation === 'CLICK' &&
      (['checkbox', 'radio', 'switch'].includes(action.role ?? '') || action.checked !== undefined) &&
      pageAfter.actions.some((listed) => listed.node === action.node)));

// A checkbox or switch, which a second click flips back (a radio stays picked).
const isToggle = (action: PageAction) =>
  action.role !== 'radio' && (['checkbox', 'switch'].includes(action.role ?? '') || action.checked !== undefined);

// Node ids are renumbered when a save reloads the page: a control is told by where it is and what it says.
const toggleKey = (path: string, label: string) => `${path}\u0000${label}`;

const isRiskyClick = (decision: Decision) =>
  ['CLICK', 'CLICK_AT'].includes(decision.operation) && (decision.commitRisk ?? 0) >= 0.5;

const isGrayZoneClick = (decision: Decision) =>
  ['CLICK', 'CLICK_AT'].includes(decision.operation) && (decision.commitRisk ?? 0) >= GRAY_ZONE_RISK && !isRiskyClick(decision);

const contradictsDoneSpike = (decision: Decision, screenshots: ScreenshotMode) =>
  screenshots === 'fallback' && !['DONE', 'WAIT', 'BLOCKED'].includes(decision.operation) && decision.confidence >= HEAD_DISAGREES;

// What a caller reads in a step: the dialog's kind and the one answer given (see Tab.#answerDialog).
const describeDialog = (type: string, message: string, accepted: boolean) => {
  if (type === 'alert') return `showed an alert "${message}"; answered OK`;
  if (type === 'beforeunload') return 'asked whether to leave the page; stayed on it';
  return `asked "${message}" in a ${type} dialog; answered ${accepted ? 'OK (the click the caller confirmed)' : 'Cancel'}`;
};

const stuckOn = (decision: Decision) => ({
  operation: decision.operation,
  ...(decision.action && { element: decision.action.label }),
  candidates: decision.candidates,
});

// Waits and Escapes are fixed, reversible steps (exempt from the unsure hand-back too), so they don't fill the window.
const wandering = (history: { operation: string; confidence: number; not_executed?: string }[]) => {
  const executed = history
    .filter((step) => !step.not_executed && !['WAIT', 'PRESS_ESCAPE'].includes(step.operation))
    .slice(-GUARDS.wanderSteps);
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

// The hand-back for a bot wall: what it is, what made it one, whether a person was waited for, and who can pass it.
const wallReason = (wall: BotWall, { visible, waited }: { visible: boolean; waited?: number }) => {
  const seen = wall.evidence.map((e) => (e.startsWith('title ') ? e : `"${e}"`)).join(', ');
  const wait = waited === undefined ? '' : `, and nobody passed it in the ${waited} s jevway waited with the tab in front`;
  const who = visible
    ? 'A person can pass it in this tab, then continue the session.'
    : 'This browser is headless, so nobody can pass it here: a visible browser is needed (JEVWAY_BROWSER=auto or launch).';
  return `The page is a bot check (${wall.name}; seen: ${seen}) that did not clear by itself${wait}; jevway never tries to get past one. ${who}`;
};

// The hand-back for a sign-in wall no supplied value passes.
const signInReason = (origin: string, { visible, waited }: { visible: boolean; waited?: number }) => {
  const wait = waited === undefined ? '' : `, and nobody signed in during the ${waited} s jevway waited with the tab in front`;
  const what = visible
    ? 'sign in there (or pass the values), then call again.'
    : 'pass the values, or sign in with a visible browser (JEVWAY_BROWSER=auto or launch; this one is headless), then call again.';
  return `The page asks to sign in at ${origin} and no supplied value fits its fields${wait}; ${what}`;
};

// The hand-back for an SSO sign-in nobody finished while the run waited.
const ssoReason = (provider: string, origin: string, waited: number) =>
  `The page asks to sign in with ${provider} at ${origin} for another site, and nobody finished it during the ${waited} s jevway waited with the tab in front; sign in there, then call again.`;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Anything that is not a model error came from the tab (CDP, page never settling, an unconfirmed action).
const describeError = (error: unknown) =>
  `${error instanceof ModelCallError ? 'Model' : 'Browser'} error: ${messageOf(error).slice(0, 200)}`;
