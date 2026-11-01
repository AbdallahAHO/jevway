import { centerOf, contains, type Rect } from '../jev/box.ts';
import { CdpError, type CdpConnection } from './cdp.ts';
import type { PageAction, PageState } from './tab.ts';

// jev-browse: every frame is read with the same reader (snapshot.js), each in an isolated world of its own, so ids, guards and
// the input counter live where the frame's elements live. The main frame keeps the main world, exactly as before frames.

/** Each frame owns a range of element ids this wide; the main frame is range 0, so its ids are what they always were. */
export const FRAME_ID_STRIDE = 1_000_000;
// A frame read that takes longer than this is skipped: a slow third-party frame must not hold up or end the run.
const FRAME_READ_MS = 1_500;
// Caps against pages full of ad and tracking frames.
const MAX_FRAMES = 10;
const MAX_PLACED = 20;
const MAX_DEPTH = 3;
// A frame showing less than this on screen (tracking pixels, collapsed widgets) is not read.
const MIN_SIDE = 16;
// The page text keeps its cap; frames get the room the main text leaves, but at least this much when they have text.
const TEXT_CAP = 6000;
const FRAME_TEXT_FLOOR = 1000;
const PASSWORD_FIELDS_CAP = 5;
const WORLD = 'jev-browse';
const OBJECTS = 'jev-browse-frames';

/**
 * The first element id of a frame's range.
 *
 * @example
 * idBaseFor(0) // 0: the main frame
 * idBaseFor(2) // 2_000_000
 */
export const idBaseFor = (slot: number) => slot * FRAME_ID_STRIDE;

/**
 * The id range an element id belongs to: 0 for the main frame, so a node routes to the frame that holds it.
 *
 * @example
 * idBaseOf(2_000_017) // 2_000_000
 */
export const idBaseOf = (node: number) => node - (node % FRAME_ID_STRIDE);

/** One step from a frame up to its parent: where the frame's content starts and which part of it shows, in the parent's viewport. */
export interface FrameLevel {
  origin: { x: number; y: number };
  clip: Rect;
}

/** Where a frame sits in the page's viewport and the part of it that shows there. */
export interface FramePlacement {
  offset: { x: number; y: number };
  region: Rect;
}

/**
 * A frame's offset and visible region in the viewport, from its levels outermost first. Offsets compound through nested
 * frames; each level's visible part is clipped by the one around it. Both are read viewport-relative, so a scrolled page
 * or frame is already counted.
 *
 * @example
 * framePlacement([{ origin: { x: 100, y: 50 }, clip: { x: 100, y: 50, w: 600, h: 400 } }], { w: 1000, h: 800 })
 * // { offset: { x: 100, y: 50 }, region: { x: 100, y: 50, w: 600, h: 400 } }
 */
export const framePlacement = (levels: FrameLevel[], viewport: { w: number; h: number }): FramePlacement => {
  let offset = { x: 0, y: 0 };
  let region: Rect = { x: 0, y: 0, w: viewport.w, h: viewport.h };
  for (const { origin, clip } of levels) {
    region = intersect(region, { ...clip, x: clip.x + offset.x, y: clip.y + offset.y });
    offset = { x: offset.x + origin.x, y: offset.y + origin.y };
  }
  return { offset, region };
};

const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};

/**
 * A frame's element actions in viewport coordinates, each recording its frame. A control the parent hides (clipped, or
 * below the page's fold) is dropped, as off-screen controls of the page are. One the reader listed off-screen inside the
 * frame itself (a wanted row, a sideways column) is kept: clicking scrolls it in. The frame's scroll and wait controls are
 * dropped; the page has its own.
 *
 * @example
 * placeFrameActions(frameState.actions, { w: frameState.w, h: frameState.h }, framePlacement(levels, page), frameId)
 */
export const placeFrameActions = (
  actions: PageAction[],
  frame: { w: number; h: number },
  { offset, region }: FramePlacement,
  frameId: string,
): PageAction[] =>
  actions.flatMap((action) => {
    if (action.node === undefined || !action.rect) return [];
    const rect = { ...action.rect, x: action.rect.x + offset.x, y: action.rect.y + offset.y };
    const local = centerOf(action.rect);
    const insideFrame = local.x >= 0 && local.y >= 0 && local.x < frame.w && local.y < frame.h;
    if (insideFrame && !contains(region, centerOf(rect))) return [];
    return [{ ...action, rect, frame: frameId }];
  });

/** What one frame contributes to the page, its actions already placed in the viewport. */
export interface FrameSnapshot {
  id: string;
  /** How the page text names the frame: the owner's title, the frame document's title, or its host. */
  label: string;
  actions: PageAction[];
  text: string;
  passwordFields: { name: string; filled: boolean }[];
  page_key: unknown;
  /** The frame document's start time and URL: a page-level action is stale once a frame has navigated. */
  identity: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
}

type MainState = Pick<PageState, 'text' | 'actions' | 'guards' | 'omitted_actions' | 'passwordFields'>;

const passwordLine = (field: { name: string; filled: boolean }, first: boolean) =>
  `Password field "${field.name}": ${field.filled ? 'filled' : 'empty'}` + (first ? ' (passwords are typed by the user, not by you)' : '');

/**
 * Joins the frames' snapshots to the main frame's, as one page:
 * - element ids `e1…` continue across frames, the 250 cap counts them all, and the page's scroll and wait stay last;
 * - frame text follows the main text under `[Frame: <label>]`, within the same 6000 characters (frames get at least
 *   1000 when they have text);
 * - password fields of every frame are described first, filled or empty only, at most 5 in all.
 * With no frame text and no frame password field, the main text is returned untouched.
 *
 * @example
 * const merged = mergeFrames(mainState, [paymentFrame]); // merged.actions: e1 "Back to cart" … e4 "Pay"
 */
export const mergeFrames = (main: MainState, frames: FrameSnapshot[]) => {
  const pageControls = main.actions.filter((action) => action.node === undefined);
  const elements = [...main.actions.filter((action) => action.node !== undefined), ...frames.flatMap((frame) => frame.actions)];
  const omitted_actions =
    main.omitted_actions + frames.reduce((sum, frame) => sum + frame.omitted_actions, 0) + Math.max(0, elements.length - 250);
  const actions = [...elements.slice(0, 250).map((action, i) => ({ ...action, id: `e${i + 1}` })), ...pageControls];

  // Password lines lead each reader's text; split them off so every frame's go first.
  const mainFields = main.passwordFields ?? [];
  const mainLines = main.text.split('\n');
  const mainBody = mainLines.slice(mainFields.length).join('\n');
  const sections = frames.flatMap((frame) => {
    const body = frame.text.split('\n').slice(frame.passwordFields.length).join('\n');
    return body.trim() ? [`[Frame: ${frame.label}]\n${body}`] : [];
  });
  const passwordFields = [...mainFields, ...frames.flatMap((frame) => frame.passwordFields)].slice(0, PASSWORD_FIELDS_CAP);
  const added = passwordFields.slice(mainFields.length);
  let text = main.text;
  if (sections.length || added.length) {
    const head = [...mainLines.slice(0, mainFields.length), ...added.map((field, i) => passwordLine(field, !mainFields.length && !i))].join('\n');
    const framesText = sections.join('\n');
    const budget = TEXT_CAP - (head ? head.length + 1 : 0);
    const frameRoom = framesText ? Math.min(framesText.length, Math.max(FRAME_TEXT_FLOOR, budget - mainBody.length - 1)) : 0;
    const mainRoom = Math.max(0, budget - (framesText ? frameRoom + 1 : 0));
    text = [head, mainBody.slice(0, mainRoom), framesText.slice(0, frameRoom)].filter(Boolean).join('\n');
  }

  return {
    actions,
    text,
    passwordFields,
    guards: Object.assign({}, main.guards, ...frames.map((frame) => frame.guards)),
    omitted_actions,
    frames: frames.map(({ id, page_key, identity }) => ({ id, page_key, identity })),
  };
};

/** A frame of the page, and the protocol session that owns it (the page's, or an out-of-process frame's own). */
export interface FrameTarget {
  id: string;
  parentId: string;
  sessionId: string;
  url: string;
  base: number;
}

interface OwnerLevel extends FrameLevel {
  sessionId: string;
  objectId: string;
  title: string;
}

type Covered = { covered: true; coverNodes: number[] };

/**
 * The frames of one tab: finds them (same-process frames in the frame tree, out-of-process ones through auto-attach),
 * reads each in its isolated world, places them in the viewport and checks nothing covers them.
 *
 * @example
 * const frames = new Frames(cdp, sessionId, INPUT_COUNTER);
 * await frames.watch();
 * const snapshots = await frames.read({ w: 1120, h: 780 }, READ_STATE, []);
 */
export class Frames {
  #cdp: CdpConnection;
  #sessionId: string;
  #counter: string;
  #touch = false;
  #mainFrameId = '';
  #viewport = { w: 0, h: 0 };
  /** Out-of-process frames attached so far, by target id (= frame id). */
  #children = new Map<string, { sessionId: string; parentFrameId?: string }>();
  #known = new Map<string, FrameTarget>();
  #bases = new Map<string, number>();
  #contexts = new Map<string, number>();
  #objectSessions = new Set<string>();

  constructor(cdp: CdpConnection, sessionId: string, counter: string) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#counter = counter;
  }

  /** Registers the input counter in every frame's world before its scripts, and attaches out-of-process frames as they come. */
  async watch() {
    this.#cdp.onEvent((method, params, sessionId) => this.#onEvent(method, params, sessionId));
    await this.#send('Page.addScriptToEvaluateOnNewDocument', { source: this.#counter, worldName: WORLD }, this.#sessionId);
    await this.#autoAttach(this.#sessionId);
  }

  /** Mobile emulation taps with touch events; out-of-process frames get the same setting. */
  set touch(enabled: boolean) {
    this.#touch = enabled;
    for (const { sessionId } of this.#children.values()) void this.#emulateTouch(sessionId);
  }

  /** The frame holding an element id: undefined for the main frame and for a frame no longer on the page. */
  ofNode(node: number) {
    const base = idBaseOf(node);
    return base ? [...this.#known.values()].find((frame) => frame.base === base) : undefined;
  }

  /** Every frame worth reading, in frame-tree order: loaded (not empty or about:blank), at most 3 levels deep. */
  async list(): Promise<FrameTarget[]> {
    const { frameTree } = await this.#send('Page.getFrameTree', {}, this.#sessionId);
    this.#mainFrameId = frameTree.frame.id;
    const found = new Map<string, Omit<FrameTarget, 'base'>>();
    const walk = (node: any, sessionId: string) => {
      for (const child of node.childFrames ?? []) {
        found.set(child.frame.id, { id: child.frame.id, parentId: node.frame.id, sessionId, url: child.frame.url });
        walk(child, sessionId);
      }
    };
    walk(frameTree, this.#sessionId);
    for (const [id, { sessionId, parentFrameId }] of this.#children) {
      const tree = await this.#send('Page.getFrameTree', {}, sessionId).catch(() => null);
      if (!tree || !parentFrameId) continue;
      found.set(id, { id, parentId: parentFrameId, sessionId, url: tree.frameTree.frame.url });
      walk(tree.frameTree, sessionId);
    }
    const depth = (frame: Omit<FrameTarget, 'base'> | undefined, level = 1): number =>
      !frame || level > MAX_DEPTH ? Infinity : frame.parentId === this.#mainFrameId ? level : depth(found.get(frame.parentId), level + 1);
    this.#known = new Map();
    for (const frame of found.values()) {
      if (depth(frame) <= MAX_DEPTH) this.#known.set(frame.id, { ...frame, base: this.#baseOf(frame.id) });
    }
    return [...this.#known.values()].filter((frame) => frame.url && frame.url !== 'about:blank');
  }

  /**
   * Reads every visible frame with `script` (the snapshot), places its actions in the viewport and drops those the parent
   * covers. A frame that is hidden, too small, too slow or failing is skipped; this never throws for a frame.
   */
  async read(viewport: { w: number; h: number }, script: string, wanted: string[]): Promise<FrameSnapshot[]> {
    this.#viewport = viewport;
    await this.#releaseObjects();
    const frames = await this.list().catch(() => []);
    const read: { snapshot: FrameSnapshot; at: { x: number; y: number } }[] = [];
    for (const frame of frames.slice(0, MAX_PLACED)) {
      if (read.length >= MAX_FRAMES) break;
      const one = await withTimeout(this.#readOne(frame, script, wanted), FRAME_READ_MS + 500).catch(() => null);
      if (one) read.push(one);
    }
    // In reading order: top to bottom, then left to right.
    return read.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x).map(({ snapshot }) => snapshot);
  }

  async #readOne(frame: FrameTarget, script: string, wanted: string[]) {
    const levels = await this.#levels(frame);
    if (!levels) return null;
    const placement = framePlacement(levels, this.#viewport);
    if (placement.region.w < MIN_SIDE || placement.region.h < MIN_SIDE) return null;
    const response = await this.evaluate(
      frame,
      `window.__jevIdBase=${frame.base};window.__jevWanted=${JSON.stringify(wanted)};${script}`,
      { timeout: FRAME_READ_MS },
    );
    const state = response.exceptionDetails ? null : response.result?.value;
    if (!state) return null;
    const placed = placeFrameActions(state.actions, { w: state.w, h: state.h }, placement, frame.id);
    // On-screen controls must be on top in every document around the frame: a banner or sheet over the frame hides them.
    const shown = placed.filter((action) => contains(placement.region, centerOf(action.rect!)));
    const onTop = await this.#hits(levels, shown.map((action) => centerOf(action.rect!)));
    const covered = new Set(shown.filter((_, i) => !onTop[i]));
    const snapshot: FrameSnapshot = {
      id: frame.id,
      label: levels.at(-1)!.title || String(state.title || '').slice(0, 60) || hostOf(frame.url),
      actions: placed.filter((action) => !covered.has(action)),
      text: state.text,
      passwordFields: state.passwordFields ?? [],
      page_key: state.page_key,
      identity: state.marker?.slice(0, 2),
      guards: state.guards,
      omitted_actions: state.omitted_actions ?? 0,
    };
    return { snapshot, at: placement.offset };
  }

  /** Sum of `script` (the placeholder count) over the listed frames; a frame that fails counts 0. */
  async countPlaceholders(script: string): Promise<number> {
    let total = 0;
    for (const frame of (await this.list().catch(() => [])).slice(0, MAX_FRAMES)) {
      const response = await withTimeout(this.evaluate(frame, script, { timeout: FRAME_READ_MS }), FRAME_READ_MS + 500).catch(() => null);
      total += Number(response?.result?.value) || 0;
    }
    return total;
  }

  /** True while every frame read at observe time still shows the same document. */
  async sameDocuments(frames: { id: string; identity: unknown }[]): Promise<boolean> {
    for (const { id, identity } of frames) {
      const frame = this.#known.get(id);
      if (!frame) return false;
      const response = await this.evaluate(frame, '[performance.timeOrigin, location.href]').catch(() => null);
      if (JSON.stringify(response?.result?.value) !== JSON.stringify(identity)) return false;
    }
    return true;
  }

  /** Where the frame's content starts in the viewport now, or null when it no longer shows. */
  async offsetOf(frame: FrameTarget) {
    const levels = await this.#levels(frame);
    return levels ? framePlacement(levels, this.#viewport).offset : null;
  }

  /**
   * A point in the frame, in viewport coordinates, checked like a click target in every document around the frame: it
   * must show (not clipped by the parent) and land on the frame there. Otherwise says what covers it, by observed ids.
   */
  async toViewport(frame: FrameTarget, point: { x: number; y: number }): Promise<{ x: number; y: number } | Covered> {
    const levels = await this.#levels(frame);
    if (!levels) return { covered: true, coverNodes: [] };
    const { offset, region } = framePlacement(levels, this.#viewport);
    const at = { x: point.x + offset.x, y: point.y + offset.y };
    if (!contains(region, at)) return { covered: true, coverNodes: [] };
    let parentOffset = { x: 0, y: 0 };
    for (const level of levels) {
      const { result } = await this.#send(
        'Runtime.callFunctionOn',
        { objectId: level.objectId, functionDeclaration: COVER_AT, arguments: [{ value: at.x - parentOffset.x }, { value: at.y - parentOffset.y }], returnByValue: true },
        level.sessionId,
      );
      if (result?.value) return { covered: true, coverNodes: result.value.coverNodes ?? [] };
      parentOffset = { x: parentOffset.x + level.origin.x, y: parentOffset.y + level.origin.y };
    }
    return at;
  }

  /**
   * Waits two animation frames in the frame. Chrome routes a press into a frame by what was last painted, so a frame
   * that has just loaded, not yet drawn, would let the press fall through to the page around it.
   */
  async painted(frame: FrameTarget) {
    const frames = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
    await withTimeout(this.evaluate(frame, frames, { awaitPromise: true }), 500).catch(() => undefined);
  }

  /** Runs `expression` in the frame's isolated world; a world lost to a navigation is made again once. */
  async evaluate(frame: FrameTarget, expression: string, extra: Record<string, unknown> = {}): Promise<any> {
    const key = `${frame.sessionId}:${frame.id}`;
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.#context(frame);
      try {
        return await this.#send('Runtime.evaluate', { expression, contextId, returnByValue: true, ...extra }, frame.sessionId);
      } catch (error) {
        if (attempt || !(error instanceof CdpError) || !/context/i.test(error.message)) throw error;
        this.#contexts.delete(key);
      }
    }
  }

  // Outermost first: for each document from the page down to the frame's parent, the owner <iframe> there.
  async #levels(frame: FrameTarget): Promise<OwnerLevel[] | null> {
    const levels: OwnerLevel[] = [];
    for (let current = frame; ; ) {
      const atTop = current.parentId === this.#mainFrameId;
      const parent = atTop ? undefined : this.#known.get(current.parentId);
      if (!atTop && !parent) return null;
      const sessionId = parent?.sessionId ?? this.#sessionId;
      const { backendNodeId } = await this.#send('DOM.getFrameOwner', { frameId: current.id }, sessionId);
      // The page's own world for the main frame (its observed ids live there), the isolated world for a frame.
      const contextId = parent ? await this.#context(parent) : undefined;
      const { object } = await this.#send(
        'DOM.resolveNode',
        { backendNodeId, objectGroup: OBJECTS, ...(contextId && { executionContextId: contextId }) },
        sessionId,
      );
      this.#objectSessions.add(sessionId);
      const { result } = await this.#send(
        'Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration: OWNER_PLACE, returnByValue: true },
        sessionId,
      );
      if (!result?.value) return null;
      levels.unshift({ ...result.value, sessionId, objectId: object.objectId });
      if (!parent) return levels;
      current = parent;
    }
  }

  // For each viewport point: true when every document around the frame has the frame on top there.
  async #hits(levels: OwnerLevel[], points: { x: number; y: number }[]): Promise<boolean[]> {
    const onTop = points.map(() => true);
    if (!points.length) return onTop;
    let parentOffset = { x: 0, y: 0 };
    for (const level of levels) {
      const local = points.map(({ x, y }) => [x - parentOffset.x, y - parentOffset.y]);
      const { result } = await this.#send(
        'Runtime.callFunctionOn',
        { objectId: level.objectId, functionDeclaration: HITS, arguments: [{ value: local }], returnByValue: true },
        level.sessionId,
      );
      (result?.value ?? []).forEach((hit: boolean, i: number) => (onTop[i] &&= hit));
      parentOffset = { x: parentOffset.x + level.origin.x, y: parentOffset.y + level.origin.y };
    }
    return onTop;
  }

  async #context(frame: FrameTarget): Promise<number> {
    const key = `${frame.sessionId}:${frame.id}`;
    const known = this.#contexts.get(key);
    if (known) return known;
    const { executionContextId } = await this.#send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD }, frame.sessionId);
    // A frame that was there before this tab attached never ran the new-document script: register the counter now.
    await this.#send('Runtime.evaluate', { expression: this.#counter, contextId: executionContextId }, frame.sessionId).catch(() => undefined);
    this.#contexts.set(key, executionContextId);
    return executionContextId;
  }

  #baseOf(frameId: string) {
    if (!this.#bases.has(frameId)) this.#bases.set(frameId, idBaseFor(this.#bases.size + 1));
    return this.#bases.get(frameId)!;
  }

  async #releaseObjects() {
    for (const sessionId of this.#objectSessions) {
      await this.#send('Runtime.releaseObjectGroup', { objectGroup: OBJECTS }, sessionId).catch(() => undefined);
    }
    this.#objectSessions.clear();
  }

  #owns(sessionId?: string) {
    return sessionId === this.#sessionId || [...this.#children.values()].some((child) => child.sessionId === sessionId);
  }

  #onEvent(method: string, params: any, sessionId?: string) {
    if (!this.#owns(sessionId)) return;
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') void this.#adopt(params);
    if (method === 'Target.detachedFromTarget') {
      for (const [id, child] of this.#children) if (child.sessionId === params.sessionId) this.#children.delete(id);
    }
    // A new document in a frame has a new world; the old context id is gone with it.
    if (method === 'Page.frameNavigated' || method === 'Page.frameDetached') {
      const frameId = params.frame?.id ?? params.frameId;
      for (const key of this.#contexts.keys()) if (key.endsWith(`:${frameId}`)) this.#contexts.delete(key);
    }
  }

  // An out-of-process frame waits for us before running its scripts, so the counter is in place first; it is always resumed.
  async #adopt({ sessionId, targetInfo, waitingForDebugger }: any) {
    this.#children.set(targetInfo.targetId, { sessionId, parentFrameId: targetInfo.parentFrameId });
    try {
      await this.#send('Page.enable', {}, sessionId);
      await this.#send('Page.addScriptToEvaluateOnNewDocument', { source: this.#counter, worldName: WORLD }, sessionId);
      await this.#send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => undefined);
      await this.#emulateTouch(sessionId);
      await this.#autoAttach(sessionId);
    } catch {
      // A frame that went away while being set up; nothing to read.
    } finally {
      if (waitingForDebugger) await this.#send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    }
  }

  #emulateTouch(sessionId: string) {
    const enabled = this.#touch;
    return this.#send('Emulation.setTouchEmulationEnabled', { enabled, maxTouchPoints: enabled ? 5 : 1 }, sessionId).catch(() => undefined);
  }

  #autoAttach(sessionId: string) {
    return this.#send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }] },
      sessionId,
    );
  }

  #send(method: string, params: Record<string, unknown>, sessionId: string) {
    return this.#cdp.send(method, params, sessionId);
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`frame did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
};

// Run on the owner <iframe> in its parent document. Null when the frame is not something a person sees: hidden, inert,
// aria-hidden (except by the modal library's own marker, as the snapshot reads it), or outside the open modal. Otherwise
// where its content box starts and the part of it the parent's viewport and scroll boxes leave visible.
const OWNER_PLACE = `function () {
  const e = this, seen = { checkOpacity: true, checkVisibilityCSS: true };
  if (!e.isConnected || !e.checkVisibility(seen) || e.closest('[inert]')) return null;
  for (let h = e.closest('[aria-hidden="true"]'); h; h = h.parentElement?.closest('[aria-hidden="true"]'))
    if (h.getAttribute('data-aria-hidden') !== 'true') return null;
  const modals = [...document.querySelectorAll('[aria-modal="true"],dialog')].filter(
    (m) => (m.tagName !== 'DIALOG' || m.matches(':modal')) && m.checkVisibility(seen) && m.getBoundingClientRect().width > 0);
  if (modals.length && !modals.some((m) => m.contains(e))) return null;
  const r = e.getBoundingClientRect(), s = getComputedStyle(e), px = (v) => parseFloat(v) || 0;
  const x = r.x + e.clientLeft + px(s.paddingLeft), y = r.y + e.clientTop + px(s.paddingTop);
  let left = Math.max(x, 0), top = Math.max(y, 0),
    right = Math.min(x + e.clientWidth - px(s.paddingLeft) - px(s.paddingRight), innerWidth),
    bottom = Math.min(y + e.clientHeight - px(s.paddingTop) - px(s.paddingBottom), innerHeight);
  for (let p = e.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (getComputedStyle(p).overflow === 'visible') continue;
    const c = p.getBoundingClientRect();
    left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
  }
  return { origin: { x, y }, clip: { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) },
    title: (e.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
}`;

// The element at a point, through open shadow roots (as tab.ts DEEP_HIT): an <iframe> inside a web component still counts.
const DEEP_HIT = `(x, y) => {
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}`;

// Run on the owner <iframe>: for each point (in this document's viewport), whether the frame is what a press there hits.
const HITS = `function (points) {
  const deepHit = ${DEEP_HIT};
  return points.map(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && deepHit(x, y) === this);
}`;

// Run on the owner <iframe>: null when a press at the point reaches the frame; otherwise the observed ids in the fixed,
// sticky or modal layer on top there (as the cover check in tab.ts names them).
const COVER_AT = `function (x, y) {
  const deepHit = ${DEEP_HIT};
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { coverNodes: [] };
  const hit = deepHit(x, y);
  if (hit === this) return null;
  const isLayer = (n) => ['fixed', 'sticky'].includes(getComputedStyle(n).position) ||
    ['dialog', 'alertdialog'].includes(n.getAttribute('role')) || n.getAttribute('aria-modal') === 'true';
  let layer = hit;
  while (layer && layer !== document.body && !isLayer(layer)) layer = layer.parentElement;
  const nodes = window.__jevFast?.nodes;
  return { coverNodes: layer && layer !== document.body && nodes ? [...nodes].filter(([, n]) => layer.contains(n)).map(([id]) => id) : [] };
}`;
