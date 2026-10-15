import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { CdpError, type CdpConnection, type CdpListener } from './cdp.ts';
import { DEVICES, type Device } from './devices.ts';

// Atomic DOM read from browser-use/jev-ultrafast (MIT): visible text + indexed controls + freshness guards.
const READ_STATE = readFileSync(new URL('./snapshot.js', import.meta.url), 'utf8');
const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

export type ActionKind = 'click' | 'fill' | 'select' | 'scroll' | 'wait' | 'enter' | 'escape';

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
  /** Viewport CSS pixels at observation time. */
  rect?: { x: number; y: number; w: number; h: number };
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
}

/** The page moved on since it was observed; observe again and re-decide. Never a reason to guess. */
export class StalePage extends Error {}
/** The page is as observed, but the chosen target can't be reached: covered, clipped, or gone from its spot. */
export class TargetUnreachable extends StalePage {
  /** True when what sits on top is a popup layer (suggestions, a menu, a popover) that Escape can close. */
  readonly byPopup: boolean;
  constructor(message: string, byPopup = false) {
    super(message);
    this.byPopup = byPopup;
  }
}

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
  #touch = false;
  private cdp: CdpConnection;
  readonly targetId: string;
  private sessionId: string;

  private constructor(cdp: CdpConnection, targetId: string, sessionId: string) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
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
      // Output pixels are CSS pixels × scale × pixel ratio. Stay within 1024 wide and 1536 tall: models read about
      // a megapixel, and Jev rejects any side over 1568 px (a phone at 2× is 786×1704 unscaled).
      const scale = Math.min(1, 1024 / (viewport.w * pixelRatio), 1536 / (viewport.h * pixelRatio));
      return await this.screenshot({ format: 'jpeg', quality: 60, scale });
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
    const focused = await this.#evaluate(`(() => {
      const e = window.__jevFast?.nodes.get(${Number(action.node)});
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return Boolean(e) && active === e;
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

  async #viewportClip(scale: number) {
    const { cssVisualViewport } = await this.#call('Page.getLayoutMetrics');
    const { pageX, pageY, clientWidth, clientHeight } = cssVisualViewport;
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
    return tab;
  }

  async navigate(url: string) {
    await this.#call('Page.navigate', { url });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await this.#evaluate('document.readyState').catch(() => null)) === 'complete') return;
      await sleep(20);
    }
  }

  /**
   * Texts the caller supplied (task values). An off-screen link, button or row containing one is still listed, since
   * it is likely the target; clicking scrolls it into view.
   *
   * @example
   * tab.want(['u-Gy8s1dJcpm18C2qmaNcN8']); // the user link below the fold is listed on the next observe()
   */
  want(texts: string[]) {
    this.#wanted = texts.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
  }

  async observe(): Promise<PageState> {
    await this.#settleAfterInput();
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        const state = await this.#evaluate(`window.__jevWanted=${JSON.stringify(this.#wanted)};${READ_STATE}`);
        if (state) return { ...state, fingerprint: fingerprint(state) };
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
      }
      await sleep(40);
    }
    throw new StalePage('Page did not settle within 1s');
  }

  /** Clicks/selects compare the target's own guard; everything else compares the whole-page marker. */
  async fresh(page: PageState, action?: PageAction): Promise<boolean> {
    // Element-level for targeted input: busy pages (rotating banners) change the page marker constantly.
    if (action && ['click', 'select', 'fill'].includes(action.kind)) {
      const current = await this.#evaluate(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${Number(action.node)}))] : null; })()`,
      ).catch(() => null);
      return isDeepStrictEqual(current, [page.page_key, page.guards[String(action.node)]]);
    }
    return isDeepStrictEqual(await this.#evaluate(MARKER).catch(() => null), page.marker);
  }

  async act(action: PageAction, page: PageState, text?: string) {
    if (!(await this.fresh(page, action))) throw new StalePage('Page changed since this decision');
    if (action.kind === 'wait') return sleep(100);
    if (action.kind === 'enter') return this.#pressEnter(action);
    if (action.kind === 'escape') return this.dismissPopup();
    if (action.kind === 'scroll') {
      await this.#call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        // Inside the viewport on any device: centre column, lower half.
        x: Math.round(page.w / 2),
        y: Math.round(page.h * 0.6),
        deltaX: 0,
        deltaY: action.delta,
      });
    } else {
      await this.#input(action, text);
    }
    this.#afterInput = action;
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
      await this.#call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
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
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }

  // A control that appears only on hover: move the pointer onto where it sits, then wait for it to show. Pointer move
  // only (no click, no focus), so a touch screen, which has no hover, skips it.
  async #revealByHover(action: PageAction) {
    const node = `window.__jevFast?.nodes.get(${Number(action.node)})`;
    const centre = await this.#evaluate(`(() => {
      const e = ${node};
      if (!e?.isConnected) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!centre) throw new TargetUnreachable('Target changed or is covered');
    await this.#call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y });
    for (let waited = 0; waited <= 500; waited += 50) {
      const shown = await this.#evaluate(`${node}?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true`);
      if (shown) return;
      await sleep(50);
    }
    throw new TargetUnreachable('Hovering did not reveal the control');
  }

  async #input(action: PageAction, text?: string) {
    if (action.hover && !this.#touch) await this.#revealByHover(action);
    const target = await this.#evaluate(`(${RESOLVE_TARGET})(${JSON.stringify(action)})`).catch((error) => {
      if (action.kind === 'select') throw new Error('Dropdown execution was interrupted; inspect before retrying.');
      throw error;
    });
    if (!target || target.covered) {
      if (action.kind === 'select') throw new Error('Dropdown execution was not confirmed; inspect before retrying.');
      throw new TargetUnreachable('Target changed or is covered', Boolean(target?.byPopup));
    }
    if (action.kind === 'select') return;
    if (this.#touch) {
      await this.#call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] });
      await this.#call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.#call('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
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

  // Read-only wait: two animation frames, or visible autocomplete options (≤200ms) after typing into a combobox.
  async #settleAfterInput() {
    const action = this.#afterInput;
    this.#afterInput = undefined;
    if (!action || action.kind === 'wait') return;
    await this.#call('Runtime.evaluate', {
      expression: `(${SETTLE})(${JSON.stringify(action)})`,
      awaitPromise: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async #evaluate(expression: string): Promise<any> {
    const response = await this.#call('Runtime.evaluate', { expression, returnByValue: true }).catch((error) => {
      throw error instanceof CdpError ? new StalePage(error.message) : error;
    });
    if (response.exceptionDetails) throw new StalePage('Document changed during evaluation');
    return response.result?.value;
  }

  #call(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fingerprint = (state: Omit<PageState, 'fingerprint'> & { scroll?: unknown }) =>
  createHash('sha256')
    .update(JSON.stringify([state.url, state.text, state.actions, state.scroll]))
    .digest('hex');

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

// Resolves the observed node, rejects hidden/disabled/covered targets, and applies native selects in-page.
const RESOLVE_TARGET = `action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const point=()=>{ const r=window.__jevFast.clickRect(e), x=r.x+r.width/2, y=r.y+r.height/2;
    return r.width && r.height && x>=0 && y>=0 && x<innerWidth && y<innerHeight && e.contains((${DEEP_HIT})(x,y)) ? {x,y} : null; };
  // A target clipped by a scrolling sidebar or list is scrolled just into view once, as a person would.
  let at=point();
  if (!at) { e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}); at=point(); }
  if (!at) {
    // Say what covers it: a popup layer can be closed with Escape, anything else can't be helped from here.
    const r=window.__jevFast.clickRect(e), hit=(${DEEP_HIT})(r.x+r.width/2, r.y+r.height/2);
    return {covered:true, byPopup:Boolean(hit?.closest('[role="listbox"],[role="menu"],[role="dialog"]:not([aria-modal="true"]),[role="tooltip"],[data-radix-popper-content-wrapper],[cmdk-list]'))};
  }
  const {x,y}=at;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
}`;

const SETTLE = `action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
})`;
