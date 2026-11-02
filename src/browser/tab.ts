import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { CdpError, type CdpConnection, type CdpListener } from './cdp.ts';
import { DEVICES, type Device } from './devices.ts';
import { TabDownloads, type Download } from './downloads.ts';
import { Frames, idBaseOf, mergeFrames, whenAborted, type FrameTarget } from './frames.ts';
import { messageNames } from './words.ts';

// Atomic DOM read from browser-use/jev-ultrafast (MIT): visible text + indexed controls + freshness guards.
const READ_STATE = readFileSync(new URL('./snapshot.js', import.meta.url), 'utf8');
const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;
// How long observe() keeps retrying a page that is still changing, and what a call that got no reply at all looks like.
const OBSERVE_DEADLINE_MS = 2_000;
const TIMED_OUT = /timed out after/;
// jevway: a page drawn as pulsing placeholders has not loaded what the user came for, so reading it now invites a click on
// whatever chrome is listed. The wait is capped, and a page that keeps pulsing is named as loading.
const PLACEHOLDERS_MIN = 3;
const PLACEHOLDERS_WAIT_MS = 1_500;
const PLACEHOLDERS_POLL_MS = 100;
// On-screen elements with no text of their own that run an endless animation: skeleton blocks and spinners, 0 once loaded.
const COUNT_PLACEHOLDERS = `(() => {
  const targets = new Set(document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime === Infinity)
    .map((a) => a.effect?.target));
  let count = 0;
  for (const el of targets) {
    if (!el?.getBoundingClientRect || (el.textContent || '').trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) count++;
  }
  return count;
})()`;

export type ActionKind = 'click' | 'fill' | 'select' | 'upload' | 'scroll' | 'wait' | 'enter' | 'escape';
/** Actions that target no element and are reversible: the loop may run them on a page that changed since the decision. */
export const PAGE_LEVEL_KINDS: ActionKind[] = ['wait', 'escape', 'scroll', 'enter'];

export interface PageAction {
  id: string;
  kind: ActionKind;
  label: string;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  /** Shown only while the pointer is over its container; the pointer is moved onto it before the click. */
  hover?: boolean;
  delta?: number;
  /** A scroll's wheel point: the centre of the visible part of the pane it scrolls (viewport CSS pixels, from DOM rects). */
  at?: { x: number; y: number };
  /** Viewport CSS pixels at observation time. */
  rect?: { x: number; y: number; w: number; h: number };
  /** The frame (protocol frame id) holding the element; absent in the main document. */
  frame?: string;
  /** An upload target that is a drop zone with no file input: the file is dropped onto it. */
  drop?: boolean;
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  /** Viewport size in CSS pixels. */
  w: number;
  h: number;
  actions: PageAction[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
  fingerprint: string;
  /** Visible password fields as `{ name, filled }`: whether each has dots in it, never its value. */
  passwordFields?: { name: string; filled: boolean }[];
  /** The frames read into this state, with what their freshness checks compare. */
  frames?: { id: string; page_key: unknown; identity: unknown }[];
}

/** A native dialog the page opened and how this tab answered it. */
export interface DialogRecord {
  /** `alert`, `confirm`, `prompt` or `beforeunload`. */
  type: string;
  message: string;
  /** True for an alert's OK and for the confirm a confirmed click opened (see `Tab.armConfirm`); every other dialog is declined. */
  accepted: boolean;
}

/** The page moved on since it was observed; observe again and re-decide. Never a reason to guess. */
export class StalePage extends Error {}
/** The page is as observed, but the chosen target can't be reached: covered, clipped, or gone from its spot. */
export class TargetUnreachable extends StalePage {
  /** True when what sits on top is a popup layer (suggestions, a menu, a popover) that Escape can close. */
  readonly byPopup: boolean;
  /** Observed node ids inside the fixed, sticky or modal layer on top of the target, so the run can name its controls. */
  readonly coverNodes: number[];
  constructor(message: string, byPopup = false, coverNodes: number[] = []) {
    super(message);
    this.byPopup = byPopup;
    this.coverNodes = coverNodes;
  }
}

/** The browser took the press but the page never received it, so nothing was clicked. Not a StalePage: it is never retried blind. */
export class InputNotDelivered extends Error {}

/**
 * One browser tab driven through observed actions only.
 * Model output selects an observed action id; it never becomes a selector, coordinate or script.
 *
 * @example
 * const tab = await Tab.open(cdp, 'https://en.wikipedia.org');
 * const page = await tab.observe();
 * await tab.act(page.actions[0], page);
 */
export class Tab {
  #afterInput: PageAction | undefined;
  #wanted: string[] = [];
  /** The caller declared files to upload: file inputs are listed, and a native file picker is intercepted. */
  #files = false;
  #touch = false;
  #dialogs: DialogRecord[] = [];
  /** The phrases the next confirm dialog must name to get OK; set only around a click the caller confirmed. */
  #confirmArm: string[] | undefined;
  /** The device this tab emulates, for a tab it opens. */
  #device: Device | undefined;
  /** Page tabs this tab opened (target=_blank, window.open) that the run has not taken yet, oldest first. */
  #opened: string[] = [];
  /** Every page tab this tab opened, taken or not: a download one of them starts is this tab's. */
  #openedEver = new Set<string>();
  #downloads: TabDownloads;
  #closed = false;
  #unsubscribe: (() => void)[] = [];
  /** The running call's stop signal: the waits after an input end early on it (see `stopSignal`). */
  #stop: AbortSignal | undefined;
  private cdp: CdpConnection;
  readonly targetId: string;
  private sessionId: string;
  #frames: Frames;

  private constructor(cdp: CdpConnection, targetId: string, sessionId: string) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.#frames = new Frames(cdp, sessionId, INPUT_COUNTER);
    this.#downloads = new TabDownloads(cdp, (frameId) => frameId === targetId || this.#openedEver.has(frameId) || this.#frames.holds(frameId));
  }

  /**
   * Opens a background tab so the user's visible tab stays put. `newWindow` keeps the page rendering
   * unthrottled in the user's own Chrome, which screenshots need.
   */
  static async open(
    cdp: CdpConnection,
    url: string,
    { device = DEVICES.desktop, newWindow = false }: { device?: Device; newWindow?: boolean } = {},
  ): Promise<Tab> {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
      ...(newWindow && { newWindow: true, width: device.width + 40, height: device.height + 120 }),
    });
    const tab = await Tab.attach(cdp, targetId);
    await tab.emulate(device);
    await tab.navigate(url);
    return tab;
  }

  /** Viewport, pixel ratio, UA and touch. Mobile devices tap with touch events instead of mouse clicks. */
  async emulate(device: Device) {
    const { width, height, deviceScaleFactor, mobile, userAgent } = device;
    await this.#call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
    await this.#call('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    if (userAgent) await this.#call('Emulation.setUserAgentOverride', { userAgent });
    this.#touch = mobile;
    this.#device = device;
    this.#frames.touch = mobile;
  }

  /** Viewport screenshot as base64. `scale` < 1 makes a light preview for the agent. */
  async screenshot({
    format = 'png',
    quality,
    scale,
  }: { format?: 'png' | 'jpeg'; quality?: number; scale?: number } = {}) {
    const clip = scale ? await this.#viewportClip(scale) : undefined;
    const { data } = await this.#call('Page.captureScreenshot', {
      format,
      ...(quality && { quality }),
      ...(clip && { clip }),
    });
    return data as string;
  }

  /**
   * Viewport JPEG with each mark drawn as a numbered box, so a vision model can tie what it sees to an
   * element index. The overlay is removed before this returns, so it never meets a freshness check or input.
   * `sharp` is for people (step recordings): native pixel ratio at high quality, never sent to a model.
   * The model image is sized from the viewport captured now (a page can zoom out to fit after it was observed, so
   * `viewport` is only the observed size) and checked after capture: it never leaves with a side over its limit.
   *
   * @example
   * const jpeg = await tab.markedScreenshot(buildActionSpace(page.actions).marks, page);
   */
  async markedScreenshot(
    marks: { label: string; node?: number; rect: NonNullable<PageAction['rect']> }[],
    viewport: { w: number; h: number },
    { sharp = false } = {},
  ) {
    const pixelRatio = Number(await this.#evaluate('devicePixelRatio')) || 1;
    await this.#evaluate(`(${DRAW_MARKS})(${JSON.stringify(marks)})`);
    try {
      // Rendered at 2× CSS pixels whatever the screen: Chrome re-rasterises at the clip scale, so text stays crisp.
      if (sharp) return await this.screenshot({ format: 'jpeg', quality: 90, scale: 2 / pixelRatio });
      // Output pixels are CSS pixels × scale × pixel ratio. Models read about a megapixel, and Jev rejects any side
      // over 1568 px (a phone at 2× is 786×1704 unscaled), so stay within 1024 wide and 1536 tall.
      const { clientWidth, clientHeight } = await this.#cssViewport();
      const scale = Math.min(1, MODEL_IMAGE.width / (clientWidth * pixelRatio), MODEL_IMAGE.height / (clientHeight * pixelRatio));
      const jpeg = await this.screenshot({ format: 'jpeg', quality: 60, scale });
      const size = jpegSize(jpeg);
      const overshoot = size ? Math.max(size.width / MODEL_IMAGE.width, size.height / MODEL_IMAGE.height) : 1;
      if (overshoot <= 1) return jpeg;
      // The page resized between measuring and capturing: shrink by the overshoot and capture once more.
      return await this.screenshot({ format: 'jpeg', quality: 60, scale: (scale / overshoot) * 0.99 });
    } finally {
      await this.#evaluate(`document.getElementById('${MARKS_ID}')?.remove()`).catch(() => undefined);
    }
  }

  /**
   * Closes an open popup (suggestions, a menu) that covers the page: Escape, then leave the focused field and press
   * outside. Fixed keys and events only, never a target from the model, so it needs no freshness check.
   */
  async dismissPopup() {
    // Escape goes to whatever has focus; focus is never moved first, since focusing a search bar re-opens its list.
    const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await this.#call('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    // Lists that ignore Escape close on blur or an outside press: a synthetic press on the page body hits no control.
    await this.#evaluate(PRESS_OUTSIDE).catch(() => undefined);
    this.#afterInput = undefined;
  }

  // A fixed Enter key into the field just typed into, only while that exact field still has focus.
  async #pressEnter(action: PageAction) {
    // In a frame, the frame itself must have the page's focus too, or the key would go elsewhere.
    const frame = this.#frameOf(action.node);
    const focused = await this.#evaluateFor(frame, `(() => {
      const e = window.__jevFast?.nodes.get(${Number(action.node)});
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return Boolean(e) && active === e${frame ? ' && document.hasFocus()' : ''};
    })()`);
    if (!focused) throw new StalePage('The typed field lost focus');
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.#call('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
    await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  /** Raw protocol access for diagnostics (console, network) scoped to this tab. */
  send(method: string, params: Record<string, unknown> = {}) {
    return this.#call(method, params);
  }

  onEvent(listener: CdpListener) {
    return this.cdp.onEvent((method, params, sessionId) => {
      if (sessionId === this.sessionId) listener(method, params, sessionId);
    });
  }

  async evaluate(expression: string): Promise<any> {
    return this.#evaluate(expression);
  }

  async #cssViewport() {
    const { cssVisualViewport } = await this.#call('Page.getLayoutMetrics');
    return cssVisualViewport as { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  }

  async #viewportClip(scale: number) {
    const { pageX, pageY, clientWidth, clientHeight } = await this.#cssViewport();
    return { x: pageX, y: pageY, width: clientWidth, height: clientHeight, scale };
  }

  /** Reuses an existing tab whose URL contains `urlPart`, e.g. the page chrome-devtools is inspecting. */
  static async find(cdp: CdpConnection, urlPart: string): Promise<Tab> {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((info: any) => info.type === 'page' && info.url.includes(urlPart));
    if (!target) throw new Error(`No open tab URL contains "${urlPart}"`);
    return Tab.attach(cdp, target.targetId);
  }

  static async attach(cdp: CdpConnection, targetId: string): Promise<Tab> {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, targetId, sessionId);
    // Keep rAF, menus and autocomplete rendering in a background tab.
    await tab.#call('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Registered ahead of the page's own scripts, so its listeners cannot hide a press from ours; the open document gets it
    // too. Chrome only runs a new-document script for a session with Page enabled.
    await tab.#call('Page.enable');
    await tab.#call('Page.addScriptToEvaluateOnNewDocument', { source: INPUT_COUNTER });
    await tab.#call('Runtime.evaluate', { expression: INPUT_COUNTER }).catch(() => undefined);
    // Every frame gets the same counter in its own world, and out-of-process frames are attached as they appear.
    await tab.#frames.watch();
    tab.#unsubscribe.push(
      tab.onEvent((method, params) => {
        if (method === 'Page.javascriptDialogOpening') tab.#answerDialog(params);
      }),
    );
    // jevway: a tab this tab opens is noted by its opener id; discovery only reports targets, so a tab anyone else
    // opened (the user's own, in their Chrome) is never attached, read or changed.
    tab.#unsubscribe.push(
      cdp.onEvent((method, params, sessionId) => {
        const info = params?.targetInfo;
        if (method === 'Target.targetCreated' && info?.type === 'page' && info.openerId === targetId) {
          tab.#opened.push(info.targetId);
          tab.#openedEver.add(info.targetId);
        }
        if (method === 'Target.targetDestroyed' && params?.targetId === targetId) tab.#closed = true;
        if (method === 'Target.detachedFromTarget' && params?.sessionId === tab.sessionId && !sessionId) tab.#closed = true;
      }),
    );
    tab.#unsubscribe.push(tab.#downloads.watch());
    await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
    return tab;
  }

  /** True once this tab's target was closed or detached: it can't be read again. */
  get closed() {
    return this.#closed;
  }

  /** The tabs this tab opened since the last call, oldest first (target ids). */
  takeOpened(): string[] {
    return this.#opened.splice(0);
  }

  /**
   * Drives a tab this tab opened with the same setup (`Tab.attach`), plus this tab's device, wanted values and
   * confirmation arm, once its first real document has loaded. The input counter is evaluated on that document again:
   * a popup that loaded before it was attached never got it from the new-document script.
   *
   * @example
   * const [opened] = tab.takeOpened();
   * if (opened) tab = await tab.follow(opened);
   */
  /**
   * Lends the running call's stop signal (caller cancel, time budget) to this tab's waits: a followed tab's address
   * and load, a scroll's settle poll and frame reads end early on it. Inputs never take it, so one under way finishes.
   *
   * @example
   * tab.stopSignal = limit.signal; // while a call runs; undefined after
   */
  set stopSignal(signal: AbortSignal | undefined) {
    this.#stop = signal;
  }

  async follow(targetId: string): Promise<Tab> {
    // A dialog the tab raised before it was followed freezes it, and Page.enable never re-sends it (probed): rather than
    // wait out every 30 s protocol timeout, the follow fails as a browser error, which ends the run `blocked`.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frozen = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CdpError(`The new tab did not answer within ${FOLLOW_MS / 1000} s: it may be showing a dialog it raised before jevway could answer it`)),
        FOLLOW_MS,
      );
    });
    let next: Tab;
    try {
      next = await Promise.race([this.#setUpFollowed(targetId), frozen]);
    } finally {
      clearTimeout(timer);
    }
    // Set up, its dialogs are answered from here on. A popup is created on about:blank and then navigates: wait for its URL, then for it to load.
    const stop = whenAborted(this.#stop);
    try {
      const begun = Date.now();
      // A stop answers null, which ends the wait as if the address had come.
      const address = () => Promise.race([next.#evaluate('location.href').catch(() => 'about:blank'), stop.promise]);
      while (Date.now() - begun < POPUP_URL_MS && (await address()) === 'about:blank') await Promise.race([sleep(50), stop.promise]);
    } finally {
      stop.release();
    }
    await next.#waitForLoad(Date.now() + 15_000);
    await next.#evaluate(INPUT_COUNTER).catch(() => undefined);
    return next;
  }

  // The protocol calls that a dialog raised before the follow would freeze: attach (with its dialog answer), device, values.
  async #setUpFollowed(targetId: string): Promise<Tab> {
    const next = await Tab.attach(this.cdp, targetId);
    if (this.#device) await next.emulate(this.#device);
    next.want([], { files: this.#files });
    next.#wanted = this.#wanted;
    next.#confirmArm = this.#confirmArm;
    next.#stop = this.#stop;
    return next;
  }

  // jevway: an open dialog freezes the page for every protocol call, so it is answered at once, with the choice that
  // changes nothing: OK for an alert (its only button), Cancel for confirm and prompt, Stay for beforeunload. The one
  // exception is the confirm dialog a confirmed click opens, when its message names the confirmed target or the control:
  // that is the same action asking again. Any other dialog, including one the same click opens about something else, is declined.
  #answerDialog({ type, message }: { type: string; message?: string }) {
    const armed = type === 'confirm' ? this.#confirmArm : undefined;
    // The arm covers the first confirm after it, named or not.
    if (type === 'confirm') this.#confirmArm = undefined;
    const accepted = type === 'alert' || (armed !== undefined && messageNames(message ?? '', armed));
    this.#dialogs.push({ type, message: message ?? '', accepted });
    void this.#call('Page.handleJavaScriptDialog', { accept: accepted }).catch(() => undefined);
  }

  /**
   * One shot, for a click the caller confirmed: the next confirm dialog gets OK if its message names one of `phrases`
   * (the confirmed target, the clicked control). Prompts and leave-the-page guards are never accepted.
   */
  armConfirm(phrases: string[]) {
    this.#confirmArm = phrases;
  }

  /** Takes the arm back; the run does so when the step that armed it is over. */
  disarmConfirm() {
    this.#confirmArm = undefined;
  }

  /** The dialogs the page opened (and this tab answered) since the last call, oldest first. */
  takeDialogs(): DialogRecord[] {
    return this.#dialogs.splice(0);
  }

  async navigate(url: string) {
    await this.#call('Page.navigate', { url });
    await this.#waitForLoad(Date.now() + 15_000);
  }

  async #waitForLoad(deadline: number) {
    const stop = whenAborted(this.#stop);
    try {
      while (Date.now() < deadline && !this.#stop?.aborted) {
        // A frozen renderer never answers: the wait ends at its deadline (or a stop), not after one more 30 s protocol call.
        const state = await Promise.race([
          this.#evaluate('document.readyState').catch(() => null),
          sleep(deadline - Date.now()).then(() => null),
          stop.promise,
        ]);
        if (state === 'complete') return;
        await Promise.race([sleep(20), stop.promise]);
      }
    } finally {
      stop.release();
    }
  }

  /**
   * Texts the caller supplied (task values). An off-screen link, button or row containing one is still listed, since
   * it is likely the target; clicking scrolls it into view.
   *
   * @example
   * tab.want(['u-Gy8s1dJcpm18C2qmaNcN8']); // the user link below the fold is listed on the next observe()
   */
  want(texts: string[], { files = false }: { files?: boolean } = {}) {
    this.#wanted = texts.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
    // jevway: with files declared, a click on a styled "Upload" button must never open an OS dialog in the user's
    // Chrome: the picker is intercepted (and left unanswered); UPLOAD sets the file on the field instead.
    if (files && !this.#files) void this.#call('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    this.#files = files;
    this.#frames.files = files;
  }

  /**
   * Sets a declared file on an observed file input (hidden ones too, in the page or in a frame), or drops it onto an
   * observed drop zone, after the same element-level freshness check as a click. The path comes from the caller's
   * `files`, never from the model or `values`.
   *
   * @example
   * await tab.upload(page.actions.find((a) => a.kind === 'upload')!, page, '/Users/ada/me.png');
   */
  async upload(action: PageAction, page: PageState, path: string) {
    if (!(await this.fresh(page, action))) throw new StalePage('Page changed since this decision');
    if (action.drop) return this.#drop(action, path);
    // A frame's node lives in the frame's own world, and its file is set through the session that owns the frame.
    const frame = this.#frameOf(action.node);
    const expression = `(() => { const e = window.__jevFast?.nodes.get(${Number(action.node)}); return e?.isConnected && e.matches('input[type=file]:not(:disabled)') ? e : null; })()`;
    const { result } = await (frame ? this.#frames.evaluate(frame, expression, { returnByValue: false }) : this.#call('Runtime.evaluate', { expression })).catch(
      (error) => {
        throw error instanceof CdpError && !TIMED_OUT.test(error.message) ? new StalePage(error.message) : error;
      },
    );
    if (!result?.objectId) throw new TargetUnreachable('The file field is gone or disabled');
    await this.cdp.send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId }, frame?.sessionId ?? this.sessionId);
    this.#afterInput = action;
  }

  // A drop zone with no file input: a trusted drag of the file onto its visible centre, checked to have reached the page.
  async #drop(action: PageAction, path: string) {
    const frame = this.#frameOf(action.node);
    const resolved = await this.#evaluateFor(frame, `(${RESOLVE_TARGET})(${JSON.stringify(action)})`);
    if (!resolved || resolved.covered) throw new TargetUnreachable('Target changed or is covered', Boolean(resolved?.byPopup), resolved?.coverNodes ?? []);
    const target = frame ? await this.#frames.toViewport(frame, resolved) : resolved;
    if ('covered' in target) throw new TargetUnreachable('Target changed or is covered', false, target.coverNodes);
    await this.#evaluateFor(frame, WATCH_DROP);
    const data = { items: [], files: [path], dragOperationsMask: DRAG_COPY };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await this.#call('Input.dispatchDragEvent', { type, x: target.x, y: target.y, data });
    if (!(await this.#evaluateFor(frame, 'window.__jevDropped===true'))) throw new TargetUnreachable('The drop zone did not take the file');
    this.#afterInput = action;
  }

  /**
   * The downloads this tab (its page, its frames, a tab it opened) started since the last call, after waiting up to
   * `waitMs` for those still running; the run's stop signal ends the wait early.
   *
   * @example
   * await tab.downloadsAfterInput(); // [{ name: 'invoice-1042.pdf', state: 'completed', bytes: 86016, filePath, staged: true, … }]
   */
  downloadsAfterInput({ waitMs = DOWNLOAD_WAIT_MS }: { waitMs?: number } = {}): Promise<Download[]> {
    return this.#downloads.settle({ waitMs, signal: this.#stop });
  }

  /** The page as a PDF (its print styles, backgrounds included); headless and headed Chrome both print. */
  async pdf(): Promise<Buffer> {
    const { data } = await this.#call('Page.printToPDF', { printBackground: true });
    return Buffer.from(data, 'base64');
  }

  async observe(): Promise<PageState> {
    if (this.#closed) throw new StalePage('The tab was closed');
    const begun = Date.now();
    await this.#settleAfterInput();
    const placeholders = await this.#waitOutPlaceholders(begun);
    const started = Date.now();
    for (let attempt = 0; attempt < 25 && Date.now() - started < OBSERVE_DEADLINE_MS; attempt++) {
      try {
        const main = await this.#evaluate(`window.__jevWanted=${JSON.stringify(this.#wanted)};window.__jevFiles=${this.#files};${READ_STATE}`);
        if (main) {
          const state = await this.#withFrames(main);
          const named = placeholders ? { ...state, text: `Loading: ${placeholders} placeholder blocks on screen\n${state.text}` } : state;
          return { ...named, fingerprint: fingerprint(named) };
        }
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
      }
      await sleep(40);
    }
    throw new StalePage(`Page did not settle within ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  // The main frame's state with every readable frame joined in (ids, text, password fields); unchanged on a page without them.
  async #withFrames(main: Omit<PageState, 'fingerprint'>): Promise<Omit<PageState, 'fingerprint'>> {
    const frames = await this.#frames.read({ w: main.w, h: main.h }, READ_STATE, this.#wanted, this.#stop).catch(() => []);
    return frames.length ? { ...main, ...mergeFrames(main, frames) } : main;
  }

  // Polls the placeholder count from `since` until fewer than PLACEHOLDERS_MIN pulse (returns 0) or the cap runs out
  // (returns how many still do, for the loading line).
  async #waitOutPlaceholders(since: number): Promise<number> {
    for (;;) {
      const count = await this.#countPlaceholders();
      if (count < PLACEHOLDERS_MIN) return 0;
      const left = PLACEHOLDERS_WAIT_MS - (Date.now() - since);
      if (left <= 0) return count;
      await sleep(Math.min(PLACEHOLDERS_POLL_MS, left));
    }
  }

  async #countPlaceholders(): Promise<number> {
    try {
      const main = Number(await this.#evaluate(COUNT_PLACEHOLDERS)) || 0;
      return main + (await this.#frames.countPlaceholders(COUNT_PLACEHOLDERS));
    } catch (error) {
      // A page mid-navigation is read by the retry loop; a call that timed out stays a browser error.
      if (error instanceof StalePage) return 0;
      throw error;
    }
  }

  /** Clicks/selects compare the target's own guard; everything else compares the whole-page marker. */
  async fresh(page: PageState, action?: PageAction): Promise<boolean> {
    // Element-level for targeted input: busy pages (rotating banners) change the page marker constantly.
    if (action && ['click', 'select', 'fill', 'upload'].includes(action.kind)) {
      if (action.node !== undefined && idBaseOf(action.node)) return this.#freshInFrame(page, action);
      const current = await this.#evaluate(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${Number(action.node)}))] : null; })()`,
      ).catch(() => null);
      return isDeepStrictEqual(current, [page.page_key, page.guards[String(action.node)]]);
    }
    if (!isDeepStrictEqual(await this.#evaluate(MARKER).catch(() => null), page.marker)) return false;
    // A frame's text may tick (ads, clocks) without making a wait or scroll wrong; only a frame that navigated does.
    return !page.frames?.length || this.#frames.sameDocuments(page.frames);
  }

  // A target in a frame: the main page's key, the frame's own key and the target's guard must all be as observed.
  async #freshInFrame(page: PageState, action: PageAction): Promise<boolean> {
    const frame = this.#frames.ofNode(action.node!);
    const observed = frame && page.frames?.find((read) => read.id === frame.id);
    if (!frame || !observed) return false;
    const [main, current] = await Promise.all([
      this.#evaluate('window.__jevFast?.pageKey() ?? null').catch(() => null),
      this.#evaluateIn(
        frame,
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${Number(action.node)}))] : null; })()`,
      ).catch(() => null),
    ]);
    return isDeepStrictEqual([main, current], [page.page_key, [observed.page_key, page.guards[String(action.node)]]]);
  }

  /** Runs one observed action. A scroll resolves to how far it moved the page (see `#scroll`). */
  async act(
    action: PageAction,
    page: PageState,
    text?: string,
    { evenIfChanged = false }: { evenIfChanged?: boolean } = {},
  ): Promise<{ scrolled?: number } | void> {
    // Only a page-level action may skip the check, and only when the loop asks: Enter still needs its field focused (#pressEnter).
    const skipCheck = evenIfChanged && PAGE_LEVEL_KINDS.includes(action.kind);
    if (!skipCheck && !(await this.fresh(page, action))) throw new StalePage('Page changed since this decision');
    if (action.kind === 'wait') return sleep(100);
    if (action.kind === 'enter') return this.#pressEnter(action);
    if (action.kind === 'escape') return this.dismissPopup();
    let outcome: { scrolled?: number } | undefined;
    if (action.kind === 'scroll') outcome = await this.#scroll(action, page);
    else await this.#input(action, text);
    this.#afterInput = action;
    return outcome;
  }

  // jevway: the wheel goes where the reader found the pane that scrolls (or the fixed point on a page whose document
  // scrolls), and the offsets before and after say whether it moved anything. The wheel lands asynchronously, so the
  // offsets are polled until they stop moving: 500 ms with no movement means nothing moved, 1.5 s at most.
  async #scroll(action: PageAction, page: PageState): Promise<{ scrolled?: number }> {
    const offsets = async () => Number(await this.#evaluate(SCROLL_OFFSETS).catch(() => NaN));
    const start = await offsets();
    await this.#call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      // Inside the viewport on any device: centre column, lower half.
      x: action.at?.x ?? Math.round(page.w / 2),
      y: action.at?.y ?? Math.round(page.h * 0.6),
      deltaX: 0,
      deltaY: action.delta,
    });
    if (Number.isNaN(start)) return {};
    let last = start;
    // The wheel has gone out: a stop ends only the poll, and the distance so far is reported.
    const stop = whenAborted(this.#stop);
    try {
      for (const begun = Date.now(); Date.now() - begun < 1_500; ) {
        await Promise.race([sleep(50), stop.promise]);
        if (this.#stop?.aborted) break;
        const now = await offsets();
        if (Number.isNaN(now)) return {};
        if (now === last && (now !== start || Date.now() - begun >= 500)) break;
        last = now;
      }
    } finally {
      stop.release();
    }
    return { scrolled: Math.round(Math.abs(last - start)) };
  }

  /**
   * Opt-in click at a viewport point, for controls the DOM reader can't report (canvas, iframes). The page
   * must be unchanged since observation and the point must land on a visible, enabled element in the viewport.
   * Returns what was hit, for the step record.
   *
   * @example
   * const hit = await tab.clickAt({ x: 320, y: 410 }, page); // 'canvas'
   */
  async clickAt(point: { x: number; y: number }, page: PageState): Promise<string> {
    if (!(await this.fresh(page))) throw new StalePage('Page changed since this decision');
    const hit = await this.#evaluate(`(${HIT_TEST})(${Number(point.x)}, ${Number(point.y)})`);
    if (!hit) throw new TargetUnreachable('Nothing visible and enabled at that point');
    const { x, y } = point;
    if (this.#touch) {
      await this.#call('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, radiusX: 6, radiusY: 6, force: 1 }],
      });
      await sleep(TAP_MS);
      await this.#call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.#call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    }
    this.#afterInput = undefined;
    return String(hit);
  }

  async close() {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#closed = true;
    this.#frames.stop();
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }

  // A control that appears only on hover: move the pointer onto where it sits, then wait for it to show. Pointer move
  // only (no click, no focus), so a touch screen takes it too: touch emulation applies :hover, and a tap could activate the
  // container.
  async #revealByHover(action: PageAction) {
    const node = `window.__jevFast?.nodes.get(${Number(action.node)})`;
    const frame = this.#frameOf(action.node);
    const centre = await this.#evaluateFor(frame, `(() => {
      const e = ${node};
      if (!e?.isConnected) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    const offset = frame ? await this.#frames.offsetOf(frame) : { x: 0, y: 0 };
    if (!centre || !offset) throw new TargetUnreachable('Target changed or is covered');
    await this.#call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x + offset.x, y: centre.y + offset.y });
    for (let waited = 0; waited <= 500; waited += 50) {
      const shown = await this.#evaluateFor(frame, `${node}?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true`);
      if (shown) return;
      await sleep(50);
    }
    throw new TargetUnreachable('Hovering did not reveal the control');
  }

  async #input(action: PageAction, text?: string) {
    if (action.hover) await this.#revealByHover(action);
    const frame = this.#frameOf(action.node);
    const resolved = await this.#evaluateFor(frame, `(${RESOLVE_TARGET})(${JSON.stringify(action)})`).catch((error) => {
      if (action.kind === 'select') throw new Error('Dropdown execution was interrupted; inspect before retrying.');
      throw error;
    });
    if (!resolved || resolved.covered) {
      if (action.kind === 'select') throw new Error('Dropdown execution was not confirmed; inspect before retrying.');
      throw new TargetUnreachable('Target changed or is covered', Boolean(resolved?.byPopup), resolved?.coverNodes ?? []);
    }
    if (action.kind === 'select') return;
    // The point inside a frame, moved into the viewport and checked against whatever covers the frame in the page around it.
    const target = frame ? await this.#frames.toViewport(frame, resolved) : resolved;
    if ('covered' in target) throw new TargetUnreachable('Target changed or is covered', false, target.coverNodes);
    target.focused = resolved.focused;
    // Focused in the page already: a press on the field's plain decoration would only take the focus away again.
    if (!target.focused) {
      if (frame) await this.#frames.painted(frame);
      const before = await this.#pressesReceived(frame);
      if (this.#touch) {
        await this.#call('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: target.x, y: target.y, radiusX: 6, radiusY: 6, force: 1 }],
        });
        await sleep(TAP_MS);
        await this.#call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await this.#call('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
        }
      }
      // The counter was registered before the page's scripts, so only a browser that never delivered the press leaves it
      // unchanged. The press is never repeated here: a delivered click we failed to see must not run twice.
      if (!(await this.#pageReceivedPress(before, frame))) {
        throw new InputNotDelivered(
          `The page received no input from the click on "${action.label.slice(0, 60)}": the browser dropped it, so nothing was clicked. Retry the call or check the browser.`,
        );
      }
    }
    if (action.kind !== 'fill') return;
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    await this.#call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers,
      commands: ['selectAll'],
    });
    await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers });
    // Real key events per character: autocompletes such as Booking's ignore a one-shot insertText. A line break
    // as a key event would be Enter (a form submit), so text with line breaks is inserted in one go instead.
    if (!text || /[\r\n]/.test(text)) return void (await this.#call('Input.insertText', { text: text ?? '' }));
    for (const char of text) {
      await this.#call('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char });
      await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    }
  }

  // The trusted presses this document (the frame's, for a target in a frame) has received so far; undefined when it can't be
  // read (no counter, navigated away). A press never crosses a frame boundary, so it is counted where it landed.
  async #pressesReceived(frame?: FrameTarget): Promise<string | undefined> {
    return this.#evaluateFor(frame, READ_INPUT).catch(() => undefined);
  }

  // False only while the count stays what it was before the press, after a short grace for a busy page. An unreadable
  // count or a new document means the press was delivered or can't be judged, so it never blocks.
  async #pageReceivedPress(before: string | undefined, frame?: FrameTarget) {
    if (before === undefined) return true;
    for (let attempt = 0; attempt < INPUT_READS; attempt++) {
      if (attempt) await sleep(INPUT_POLL_MS);
      if ((await this.#pressesReceived(frame)) !== before) return true;
    }
    return false;
  }

  // Read-only wait: two animation frames, or visible autocomplete options (≤200ms) after typing into a combobox.
  async #settleAfterInput() {
    const action = this.#afterInput;
    this.#afterInput = undefined;
    if (!action || action.kind === 'wait') return;
    const frame = action.node !== undefined && idBaseOf(action.node) ? this.#frames.ofNode(action.node) : undefined;
    const settle = { expression: `(${SETTLE})(${JSON.stringify(action)})`, awaitPromise: true, returnByValue: true };
    await (frame ? this.#frames.evaluate(frame, settle.expression, settle) : this.#call('Runtime.evaluate', settle)).catch((error) => {
      // Settling is best effort, but a page that does not answer at all is a browser error, not a reason to wait again.
      if (error instanceof CdpError && TIMED_OUT.test(error.message)) throw error;
    });
  }

  async #evaluate(expression: string): Promise<any> {
    const response = await this.#call('Runtime.evaluate', { expression, returnByValue: true }).catch((error) => {
      // A protocol error mid-navigation means the page moved on. A call that timed out means it stopped answering (a
      // frozen renderer): that must end the call as a browser error, not be retried as "changed" 25 times at 30 s each.
      throw error instanceof CdpError && !TIMED_OUT.test(error.message) ? new StalePage(error.message) : error;
    });
    if (response.exceptionDetails) throw new StalePage('Document changed during evaluation');
    return response.result?.value;
  }

  // The frame holding an observed node: undefined for the main document. A node whose frame has gone is stale.
  #frameOf(node?: number): FrameTarget | undefined {
    if (node === undefined || !idBaseOf(node)) return undefined;
    const frame = this.#frames.ofNode(node);
    if (!frame) throw new StalePage('The frame holding this target is gone');
    return frame;
  }

  // In the main document, or in the frame's isolated world with the same errors as #evaluate.
  #evaluateFor(frame: FrameTarget | undefined, expression: string): Promise<any> {
    return frame ? this.#evaluateIn(frame, expression) : this.#evaluate(expression);
  }

  async #evaluateIn(frame: FrameTarget, expression: string): Promise<any> {
    const response = await this.#frames.evaluate(frame, expression).catch((error) => {
      throw error instanceof CdpError && !TIMED_OUT.test(error.message) ? new StalePage(error.message) : error;
    });
    if (response.exceptionDetails) throw new StalePage('Document changed during evaluation');
    return response.result?.value;
  }

  #call(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// What a model image may measure in output pixels.
const MODEL_IMAGE = { width: 1024, height: 1536 };

/**
 * Width and height of a JPEG, read from its start-of-frame marker. Null when the bytes are not a JPEG.
 *
 * @example
 * jpegSize(await tab.screenshot({ format: 'jpeg' })); // { width: 393, height: 852 }
 */
export const jpegSize = (base64: string) => {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let at = 2; at + 9 <= bytes.length; ) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Start of frame 0-15 except the table markers DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    // Fill bytes between segments, then a segment whose length counts its own two bytes.
    at += marker === 0xff ? 1 : 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
};

// How long setting up a followed tab may take before it counts as frozen; its load wait is capped apart, below.
const FOLLOW_MS = 5_000;
// How long a followed tab may stay on about:blank before it is read as it is (a popup a script writes into).
const POPUP_URL_MS = 3_000;

// A finger's tap lasts tens of milliseconds; a zero-length tap made some widgets open and close at once.
const TAP_MS = 60;

// Counts the pointer presses the page really received (trusted events only, so our synthetic outside press never counts).
const INPUT_COUNTER = `(() => {
  if (window.__jevInput !== undefined) return;
  window.__jevInput = 0;
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
    window.addEventListener(type, (event) => { if (event.isTrusted) window.__jevInput++; }, true);
  }
})()`;
// The count with its document's start time: a page that navigated restarts at 0, which must not read as "no input".
const READ_INPUT = `window.__jevInput === undefined ? undefined : performance.timeOrigin + ':' + window.__jevInput`;
// A dropped press is judged only after this many reads, INPUT_POLL_MS apart, so a slow main thread isn't mistaken for it.
const INPUT_READS = 4;
const INPUT_POLL_MS = 40;

const fingerprint = (state: Omit<PageState, 'fingerprint'> & { scroll?: unknown }) =>
  createHash('sha256')
    .update(JSON.stringify([state.url, state.text, state.actions, state.scroll]))
    .digest('hex');

// How far everything on the page is scrolled, summed: it changes whichever pane the wheel moved.
const SCROLL_OFFSETS = `(() => {
  let sum = scrollY;
  for (const e of document.querySelectorAll('*')) if (e.scrollTop) sum += e.scrollTop;
  return sum;
})()`;

// The element at a point, looking through open shadow roots (a plain elementFromPoint stops at the host).
const DEEP_HIT = `(x, y) => {
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}`;

// Numbered boxes in a closed shadow root: invisible to the snapshot's text walk and to page scripts.
// Covered elements (under a popover or sheet) get no box, so a number never sits on something else.
const MARKS_ID = '__jev_marks';
const DRAW_MARKS = `marks => {
  document.getElementById('${MARKS_ID}')?.remove();
  const onTop = ({ node, rect: { x, y, w, h } }) => {
    const e = window.__jevFast?.nodes.get(node);
    const hit = (${DEEP_HIT})(x + w / 2, y + h / 2);
    return !e || !hit || e === hit || e.contains(hit) || hit.contains(e) || (e.labels && [...e.labels].some((l) => l.contains(hit)));
  };
  marks = marks.filter(onTop);
  const host = document.createElement('div');
  host.id = '${MARKS_ID}';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  for (const { label, rect: { x, y, w, h } } of marks) {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;outline:2px solid #e11d48;outline-offset:-1px';
    const tag = document.createElement('span');
    tag.textContent = label;
    tag.style.cssText = 'position:absolute;left:-1px;top:' + (y < 18 ? 0 : -18) + 'px;background:#e11d48;color:#fff;font:bold 14px/18px system-ui,sans-serif;padding:0 4px';
    box.append(tag);
    root.append(box);
  }
  document.documentElement.append(host);
  return true;
}`;

// What a coordinate click would land on; null outside the viewport or on hidden/disabled content.
const HIT_TEST = `(x, y) => {
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  const e = (${DEEP_HIT})(x, y);
  if (!e || e.closest(':disabled,[aria-disabled="true"],[inert]')) return null;
  if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
  const name = (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || '').trim().replace(/\\s+/g, ' ');
  return (name || e.tagName.toLowerCase()).slice(0, 80);
}`;

const PRESS_OUTSIDE = `(() => {
  document.activeElement?.blur();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    const Event = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    document.body.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true }));
  }
})()`;

// Same list as the snapshot's `interactive`: a field box holds no control but the one it frames.
const INTERACTIVE =
  'a,button,input,select,textarea,[contenteditable="true"],' +
  ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'combobox'].map((role) => `[role="${role}"]`).join(',');

// Controls whose visible field is the box a person taps; toggles and buttons keep their own box however small.
const FIELD_LIKE =
  'input:not([type="checkbox"],[type="radio"],[type="button"],[type="submit"],[type="reset"],[type="image"]),textarea,' +
  '[contenteditable="true"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="spinbutton"]';

// Resolves the observed node, rejects hidden/disabled/covered targets, and applies native selects in-page.
// How long a step waits for the downloads it started to finish.
const DOWNLOAD_WAIT_MS = 30_000;
// Input.dispatchDragEvent's operation mask for a copy, as a file dragged from the desktop offers.
const DRAG_COPY = 1;
// Notes a drop reaching the document (in the target's world): a page that refuses the drag never gets one.
const WATCH_DROP = `(() => { window.__jevDropped = false; window.addEventListener('drop', () => { window.__jevDropped = true; }, { capture: true, once: true }); return true; })()`;

const RESOLVE_TARGET = `action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  // The centre of the visible box first, then four more points inside it; a hit must still land inside the target.
  const point=()=>{ const r=window.__jevFast.clickRect(e);
    if (!r.width || !r.height) return null;
    for (const [px,py] of [[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]]) {
      const x=r.x+r.width*px, y=r.y+r.height*py;
      if (x>=0 && y>=0 && x<innerWidth && y<innerHeight && e.contains((${DEEP_HIT})(x,y))) return {x,y};
    }
    return null; };
  // A text field or combobox: what a person sees and taps is the field around it, not the input inside.
  const own=e.getBoundingClientRect();
  const tiny=(own.width<12 || own.height<12) && e.matches(${JSON.stringify(FIELD_LIKE)});
  // The field box: the nearest ancestor (3 levels at most) that holds no other control and is at least as big as the input.
  const fieldBox=()=>{
    for (let p=e.parentElement, up=0; p && up<3 && p!==document.body && p!==document.documentElement; p=p.parentElement, up++) {
      // Another control in here means this is a toolbar or a row, not one field: give up rather than climb.
      if (p.matches(${JSON.stringify(INTERACTIVE)}) ||
          [...p.querySelectorAll(${JSON.stringify(INTERACTIVE)})].some(o=>o!==e && !e.contains(o) && o.type!=='hidden')) return null;
      const r=p.getBoundingClientRect();
      if (r.width<Math.max(own.width,12) || r.height<Math.max(own.height,12)) continue;
      // Only this nearest box is tried: its centre must hit the box itself, never a banner or sheet over it.
      const x=r.x+r.width/2, y=r.y+r.height/2;
      return x>=0 && y>=0 && x<innerWidth && y<innerHeight && p.contains((${DEEP_HIT})(x,y)) ? {x,y} : null;
    }
    return null; };
  // A fill gets focus on the input itself (a fixed operation, like a select's value); a click taps the field box.
  const throughField=()=>{ const at=fieldBox();
    if (!at || action.kind!=='fill') return at;
    e.focus();
    return e.matches(':focus') ? {...at, focused:true} : null; };
  // A tiny input goes through its field box first; a fill the field's own decoration covers (magnifier, clear) goes there last.
  const reach=()=>(tiny ? throughField() : null) || point() || (action.kind==='fill' ? throughField() : null);
  // A target clipped by a scrolling sidebar or list is scrolled just into view once, as a person would.
  let at=reach();
  if (!at) { e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}); at=reach(); }
  if (!at) {
    // Say what covers it: a popup layer can be closed with Escape, anything else can't be helped from here.
    const r=window.__jevFast.clickRect(e), hit=(${DEEP_HIT})(r.x+r.width/2, r.y+r.height/2);
    // The layer on top (fixed, sticky or modal, like a cookie banner): the ids of the observed nodes inside it, the target's own excluded.
    const isLayer=n=>['fixed','sticky'].includes(getComputedStyle(n).position) ||
      ['dialog','alertdialog'].includes(n.getAttribute('role')) || n.getAttribute('aria-modal')==='true';
    let layer=hit;
    while (layer && layer!==document.body && !isLayer(layer)) layer=layer.parentElement;
    const coverNodes=layer && layer!==document.body
      ? [...window.__jevFast.nodes].filter(([,n])=>n!==e && layer.contains(n)).map(([id])=>id) : [];
    return {covered:true, coverNodes, byPopup:Boolean(hit?.closest('[role="listbox"],[role="menu"],[role="dialog"]:not([aria-modal="true"]),[role="tooltip"],[data-radix-popper-content-wrapper],[cmdk-list]'))};
  }
  const {x,y,focused}=at;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y,focused};
}`;

const SETTLE = `action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false, extended=false;
  const started=performance.now();
  const finish=()=>{stopped=true;resolve()};
  let deadline=setTimeout(finish,autocomplete ? 200 : 50);
  // jevway: a menu or popover fading in is read as hover-only until it has opened, and a person waits for it too. The wait
  // is capped at 400 ms, and endless animations (spinners, pulsing dots) don't count.
  const animating=()=>document.getAnimations().some(a=>a.playState==='running' && a.effect?.getComputedTiming().endTime!==Infinity);
  const ready=()=>{
    if (stopped) return;
    const moving=animating();
    if (moving && !extended) {
      extended=true;
      clearTimeout(deadline);
      deadline=setTimeout(finish,Math.max(0,400-(performance.now()-started)));
    }
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && !moving && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
})`;
