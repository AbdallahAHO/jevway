import type { PageAction } from '../browser/tab.ts';

export type Rect = NonNullable<PageAction['rect']>;

export const centerOf = (rect: Rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

/** A Box answer: edges as fractions of the screenshot's height (top, bottom) and width (left, right). */
export interface BoxEdges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Where a Box answer sits in the viewport. The screenshot is exactly the viewport, so fractions map
 * straight to CSS pixels.
 *
 * @example
 * toViewportRect({ top: 0.7, bottom: 0.75, left: 0.1, right: 0.9 }, { w: 400, h: 800 }) // { x: 40, y: 560, w: 320, h: 40 }
 */
export const toViewportRect = (box: BoxEdges, viewport: { w: number; h: number }): Rect => ({
  x: box.left * viewport.w,
  y: box.top * viewport.h,
  w: (box.right - box.left) * viewport.w,
  h: (box.bottom - box.top) * viewport.h,
});

/** Intersection over union, 0 (apart) to 1 (identical). */
export const overlap = (a: Rect, b: Rect) => {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const shared = w * h;
  const union = a.w * a.h + b.w * b.h - shared;
  return union > 0 ? shared / union : 0;
};

// Below this a box and an element are different things; at or above it, the box points at the element.
export const MATCH_OVERLAP = 0.3;

export const contains = (rect: Rect, point: { x: number; y: number }) =>
  point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;

// Boxes often hug a whole row around a narrower button: each centre inside the other also counts.
const pointsAt = (box: Rect, element: Rect) =>
  overlap(box, element) >= MATCH_OVERLAP || (contains(box, centerOf(element)) && contains(element, centerOf(box)));

/**
 * The observed target a box points at: the best-overlapping one that counts as a match.
 * This is how a Box answer turns back into an observed id instead of a coordinate.
 *
 * @example
 * matchTarget(boxRect, { '2': acceptButton, '5': searchBar }) // { index: '2', overlap: 0.81 }
 */
export const matchTarget = (rect: Rect, targets: Record<string, PageAction>) => {
  let best = { index: undefined as string | undefined, overlap: -1 };
  let closest = 0;
  for (const [index, action] of Object.entries(targets)) {
    if (!action.rect) continue;
    const score = overlap(rect, action.rect);
    closest = Math.max(closest, score);
    if (pointsAt(rect, action.rect) && score > best.overlap) best = { index, overlap: score };
  }
  return best.index ? best : { index: undefined, overlap: closest };
};

/** A malformed or inverted box reads as no box at all. */
export const readBox = (answer: any): { edges: BoxEdges; confidence: number } | undefined => {
  const edges = answer?.box;
  const valid =
    edges &&
    ['top', 'bottom', 'left', 'right'].every((k) => typeof edges[k] === 'number' && edges[k] >= 0 && edges[k] <= 1) &&
    edges.left < edges.right &&
    edges.top < edges.bottom;
  if (!valid) return undefined;
  return { edges, confidence: typeof answer.confidence === 'number' ? answer.confidence : 0 };
};
