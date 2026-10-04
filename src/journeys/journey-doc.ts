import type { PageAction, PageState } from '../browser/tab.ts';
import type { PATTERNS, QaFinding, ScreenType } from './screen-judgments.ts';

/** Normalized 0–1 box of the element tapped to leave a screen (same convention as Mobbin hotspots). */
export interface Hotspot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface JourneyScreen {
  id: string;
  url: string;
  title: string;
  screenshot: string;
  capturedAt: string;
  type: ScreenType;
  typeConfidence: number;
  patterns: (keyof typeof PATTERNS)[];
  qa: QaFinding[];
  description?: string;
  insight?: string;
}

export interface JourneyStep {
  from: string;
  to: string;
  flow: string;
  action: { operation: string; label: string; value?: string };
  hotspot: Hotspot | null;
  insight?: string;
  by: 'agent' | 'autopilot';
}

export interface Flow {
  name: string;
  parent: string | null;
  screens: { screen: string; action?: string; hotspot?: Hotspot }[];
}

export interface JourneyDoc {
  site: string;
  startUrl: string;
  device: string;
  intent?: string;
  createdAt: string;
  screens: JourneyScreen[];
  steps: JourneyStep[];
  flows: Flow[];
}

export const hotspotOf = (action: PageAction, page: PageState): Hotspot | null => {
  if (!action.rect || !page.w || !page.h) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp(action.rect.x / page.w),
    y: clamp(action.rect.y / page.h),
    width: clamp(action.rect.w / page.w),
    height: clamp(action.rect.h / page.h),
  };
};

/**
 * Groups steps into named flows in first-seen order. A flow name like "Homes/Searching homes" nests under
 * "Homes". Consecutive steps chain screens; a gap (the flow resumes from another screen) starts a new segment
 * inside the same flow.
 *
 * @example
 * buildFlows([{ from: 's01', to: 's02', flow: 'Search', action: { operation: 'CLICK', label: 'Search' }, … }])
 * // [{ name: 'Search', parent: null, screens: [{ screen: 's01', action: 'Tap "Search"', hotspot }, { screen: 's02' }] }]
 */
export const buildFlows = (steps: JourneyStep[]): Flow[] => {
  const flows = new Map<string, Flow>();
  for (const step of steps) {
    const flow = flows.get(step.flow) ?? { name: step.flow, parent: parentOf(step.flow), screens: [] };
    flows.set(step.flow, flow);
    if (flow.screens.at(-1)?.screen !== step.from) flow.screens.push({ screen: step.from });
    const current = flow.screens.at(-1)!;
    // Several interactions on one screen (type, pick a suggestion, then submit) read as one card.
    current.action = current.action ? `${current.action}, then ${describeAction(step)}` : describeAction(step);
    if (step.hotspot) current.hotspot = step.hotspot;
    if (step.to !== step.from) flow.screens.push({ screen: step.to });
  }
  // Parents that only exist as a prefix still appear in the tree.
  for (const flow of [...flows.values()]) {
    let parent = flow.parent;
    while (parent && !flows.has(parent)) {
      flows.set(parent, { name: parent, parent: parentOf(parent), screens: [] });
      parent = parentOf(parent);
    }
  }
  return [...flows.values()];
};

const parentOf = (name: string) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : null);

const describeAction = (step: JourneyStep) => {
  const verb =
    { CLICK: 'Tap', TYPE_TEXT: 'Type into', SELECT: 'Choose' }[step.action.operation] ?? step.action.operation;
  return `${verb} "${step.action.label}"${step.action.value ? ` → "${step.action.value}"` : ''}`;
};
