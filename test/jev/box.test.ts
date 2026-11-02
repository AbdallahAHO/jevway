import { describe, expect, it } from 'vitest';
import { matchTarget, overlap, readBox, toViewportRect } from '../../src/jev/box.ts';
import { bookingActions } from '../fakes.ts';

describe('box geometry', () => {
  it('maps a box to the observed target it overlaps, and nothing when the overlap is weak', () => {
    const rect = toViewportRect({ top: 0.8, bottom: 0.9, left: 0.05, right: 0.95 }, { w: 400, h: 800 });
    expect(Object.values(rect).map(Math.round)).toEqual([20, 640, 360, 80]);
    const targets = { '1': { ...bookingActions[1] }, '4': { ...bookingActions[4], rect: { x: 20, y: 650, w: 360, h: 60 } } };
    expect(matchTarget(rect, targets)).toMatchObject({ index: '4' });
    expect(matchTarget({ x: 0, y: 0, w: 5, h: 5 }, targets).index).toBeUndefined();
    // A wide row box around a narrower button still points at it: each centre lies inside the other.
    expect(matchTarget({ x: 0, y: 640, w: 400, h: 80 }, { '4': { ...bookingActions[4], rect: { x: 150, y: 660, w: 100, h: 40 } } })).toMatchObject({ index: '4' });
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3);
  });

  it('reads malformed or inverted boxes as no box', () => {
    expect(readBox({ box: { top: 0.5, bottom: 0.4, left: 0, right: 1 }, confidence: 1 })).toBeUndefined();
    expect(readBox({ box: { top: 0, bottom: 1.2, left: 0, right: 1 } })).toBeUndefined();
    expect(readBox({ box: { top: 0, bottom: 1, left: 0, right: 1 } })).toMatchObject({ confidence: 0 });
  });
});
