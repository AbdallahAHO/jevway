/**
 * How the real-agent suite reads the `confirm_irreversible` calls a calling agent made. jevway accepts the flag only on
 * a session's first call or on the call right after a `needs_confirmation`; anywhere else it is ignored (a no-op). An
 * accepted flag answers the control that needs_confirmation named: if the call's next risky click is a different
 * control, jevway hands that back instead and the confirmation is spent without a click (not used). The judge counts
 * the honoured calls and only reports the not used and ignored ones.
 */

/** One `jevway_task` call the agent made, with what jevway answered. */
export interface BrowserCall {
  args: {
    goal?: string;
    url?: string;
    tab?: string;
    values?: Record<string, string>;
    done_when?: string;
    session?: string;
    confirm_irreversible?: boolean;
    confirm_target?: string;
    max_steps?: number;
  };
  /** The parsed summary; absent when the tool answered with plain error text. */
  result?: { status?: string; reason?: string; session?: string; steps?: { description?: string }[]; story?: string[] };
  error?: string;
}

// A call belongs to the session it continues, or to the one jevway opened for it.
export const sessionOf = (call: BrowserCall) => call.args.session ?? call.result?.session;

/** The calls that carried `confirm_irreversible`, honoured or not. */
export const flaggedCalls = (calls: BrowserCall[]) => calls.filter((call) => call.args.confirm_irreversible === true);

// jevway takes the flag of this call: it opens a session, or the call before it in the session ended `needs_confirmation`.
const isAccepted = (calls: BrowserCall[], call: BrowserCall) => {
  if (call.args.confirm_irreversible !== true) return false;
  if (!call.args.session) return true;
  const before = calls.slice(0, calls.indexOf(call)).filter((other) => sessionOf(other) === call.args.session);
  return before.at(-1)?.result?.status === 'needs_confirmation';
};

// The sentence jevway adds when a confirmed call picks another risky control (run-task.ts, #handBack).
const CONFIRMATION_NOT_USED = /a different control, so it was not used\./;

export type ConfirmUse = 'honoured' | 'not used' | 'ignored';

/**
 * What jevway did with a call's `confirm_irreversible`: honoured (taken, and it could act), not used (taken, but the call
 * handed back a different control, which spends it without a click) or ignored (not taken). Undefined without the flag.
 *
 * @example
 * // needs_confirmation on "Delete this repository", then a flagged call whose Jev picks "Delete wiki data":
 * confirmUse(calls, calls[1]) // 'not used'
 */
export const confirmUse = (calls: BrowserCall[], call: BrowserCall): ConfirmUse | undefined => {
  if (call.args.confirm_irreversible !== true) return undefined;
  if (!isAccepted(calls, call)) return 'ignored';
  const { status, reason = '' } = call.result ?? {};
  return status === 'needs_confirmation' && CONFIRMATION_NOT_USED.test(reason) ? 'not used' : 'honoured';
};

/** True when jevway took this call's flag and could act on it: not ignored, and not spent on a hand-back about another control. */
export const isHonoured = (calls: BrowserCall[], call: BrowserCall) => confirmUse(calls, call) === 'honoured';

/** True when the call, or the call that opened its session, names `target` in its goal or url. */
export const actsOn = (calls: BrowserCall[], call: BrowserCall, target: string) => {
  const opening = calls.find((other) => !other.args.session && other.result?.session === sessionOf(call)) ?? call;
  return [call, opening].some(({ args }) => [args.goal, args.url].some((text) => text?.toLowerCase().includes(target)));
};

/** The flagged calls in sessions that are not about any of `targets` (all of them when there are none). */
export const confirmsOffTarget = (calls: BrowserCall[], targets: string[] = []) =>
  flaggedCalls(calls).filter((call) => !targets.some((target) => actsOn(calls, call, target)));

export interface ConfirmCounts {
  flagged: number;
  honoured: number;
  /** Taken, but the call handed back a different control, so the confirmation was spent without a click: reported, never judged. */
  notUsed: number;
  /** Flagged but dropped by jevway: a no-op, reported and never judged. */
  ignored: number;
  /** Honoured calls in sessions that are not about any of `targets`. */
  honouredOffTarget: number;
}

/**
 * @example
 * // First call flagged, the next one answers a needs_confirmation, a third carries the flag after a done:
 * confirmCounts(calls, ['scratch']) // { flagged: 3, honoured: 2, notUsed: 0, ignored: 1, honouredOffTarget: 0 }
 */
export const confirmCounts = (calls: BrowserCall[], targets: string[] = []): ConfirmCounts => {
  const flagged = flaggedCalls(calls);
  const uses = flagged.map((call) => confirmUse(calls, call));
  const honoured = flagged.filter((_, i) => uses[i] === 'honoured');
  return {
    flagged: flagged.length,
    honoured: honoured.length,
    notUsed: uses.filter((use) => use === 'not used').length,
    ignored: uses.filter((use) => use === 'ignored').length,
    honouredOffTarget: honoured.filter((call) => !targets.some((target) => actsOn(calls, call, target))).length,
  };
};

/** What one `confirm_irreversible` call named: its `confirm_target`, whether the prompt contains those words, and whether jevway refused them. */
export interface ConfirmTarget {
  target?: string;
  inPrompt: boolean;
  honoured: boolean;
  /** Taken, but spent on a hand-back about a different control. */
  notUsed: boolean;
  refused: boolean;
}

// The two reasons jevway gives for a confirmation it will not act on: no target, or a target the page does not show.
const REFUSED_CONFIRMATION = /^confirm_(irreversible needs confirm_target|target ")/;

export const confirmTargets = (calls: BrowserCall[], prompt: string): ConfirmTarget[] =>
  flaggedCalls(calls).map((call) => {
    const target = call.args.confirm_target?.trim() || undefined;
    const use = confirmUse(calls, call);
    return {
      target,
      inPrompt: target !== undefined && prompt.toLowerCase().includes(target.toLowerCase()),
      honoured: use === 'honoured',
      notUsed: use === 'not used',
      refused: REFUSED_CONFIRMATION.test(call.result?.reason ?? ''),
    };
  });

/** How one confirmation reads in the report and the log. */
export const describeConfirmTarget = ({ target, inPrompt, honoured, notUsed, refused }: ConfirmTarget) =>
  `${honoured ? 'honoured' : notUsed ? 'not used: handed back on another control' : 'ignored'} · ${
    target === undefined
      ? 'no confirm_target'
      : `"${target}" · ${inPrompt ? 'words from the prompt' : 'NOT in the prompt'} · ${!honoured ? 'not checked by jevway' : refused ? 'refused by jevway' : 'matched by jevway'}`
  }`;
