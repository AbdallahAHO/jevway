/**
 * How the real-agent suite reads the `confirm_irreversible` calls a calling agent made. jevway honours the flag only on
 * a session's first call or on the call right after a `needs_confirmation`; anywhere else it is a no-op, so the judge
 * counts the honoured calls and only reports the ignored ones.
 */

/** One `browser_task` call the agent made, with what jevway answered. */
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
  result?: { status?: string; reason?: string; session?: string; steps?: { description?: string }[] };
  error?: string;
}

// A call belongs to the session it continues, or to the one jevway opened for it.
export const sessionOf = (call: BrowserCall) => call.args.session ?? call.result?.session;

/** The calls that carried `confirm_irreversible`, honoured or not. */
export const flaggedCalls = (calls: BrowserCall[]) => calls.filter((call) => call.args.confirm_irreversible === true);

/** True when jevway acts on the flag of this call: it opens a session, or the call before it in the session ended `needs_confirmation`. */
export const isHonoured = (calls: BrowserCall[], call: BrowserCall) => {
  if (call.args.confirm_irreversible !== true) return false;
  if (!call.args.session) return true;
  const before = calls.slice(0, calls.indexOf(call)).filter((other) => sessionOf(other) === call.args.session);
  return before.at(-1)?.result?.status === 'needs_confirmation';
};

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
  /** Flagged but dropped by jevway: a no-op, reported and never judged. */
  ignored: number;
  /** Honoured calls in sessions that are not about any of `targets`. */
  honouredOffTarget: number;
}

/**
 * @example
 * // First call flagged, the next one answers a needs_confirmation, a third carries the flag after a done:
 * confirmCounts(calls, ['scratch']) // { flagged: 3, honoured: 2, ignored: 1, honouredOffTarget: 0 }
 */
export const confirmCounts = (calls: BrowserCall[], targets: string[] = []): ConfirmCounts => {
  const flagged = flaggedCalls(calls);
  const honoured = flagged.filter((call) => isHonoured(calls, call));
  return {
    flagged: flagged.length,
    honoured: honoured.length,
    ignored: flagged.length - honoured.length,
    honouredOffTarget: honoured.filter((call) => !targets.some((target) => actsOn(calls, call, target))).length,
  };
};

/** What one `confirm_irreversible` call named: its `confirm_target`, whether the prompt contains those words, and whether jevway refused them. */
export interface ConfirmTarget {
  target?: string;
  inPrompt: boolean;
  honoured: boolean;
  refused: boolean;
}

// The two reasons jevway gives for a confirmation it will not act on: no target, or a target the page does not show.
const REFUSED_CONFIRMATION = /^confirm_(irreversible needs confirm_target|target ")/;

export const confirmTargets = (calls: BrowserCall[], prompt: string): ConfirmTarget[] =>
  flaggedCalls(calls).map((call) => {
    const target = call.args.confirm_target?.trim() || undefined;
    return {
      target,
      inPrompt: target !== undefined && prompt.toLowerCase().includes(target.toLowerCase()),
      honoured: isHonoured(calls, call),
      refused: REFUSED_CONFIRMATION.test(call.result?.reason ?? ''),
    };
  });

/** How one confirmation reads in the report and the log. */
export const describeConfirmTarget = ({ target, inPrompt, honoured, refused }: ConfirmTarget) =>
  `${honoured ? 'honoured' : 'ignored'} · ${
    target === undefined
      ? 'no confirm_target'
      : `"${target}" · ${inPrompt ? 'words from the prompt' : 'NOT in the prompt'} · ${refused ? 'refused by jevway' : 'matched by jevway'}`
  }`;
