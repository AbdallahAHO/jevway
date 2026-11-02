import { describe, expect, it } from 'vitest';
import { buildActionSpace } from '../../src/jev/action-space.ts';
import { bookingActions } from '../fakes.ts';

describe('action space', () => {
  it('gives each DOM node one index and each operation only its valid targets', () => {
    const space = buildActionSpace(bookingActions);
    expect(space.elements.map((e) => [e.index, e.label, e.operations])).toEqual([
      ['1', 'Full name', ['TYPE_TEXT', 'CLICK']],
      ['2', 'Email address', ['TYPE_TEXT']],
      ['3', 'Guests', ['SELECT']],
      ['4', 'Confirm booking and pay €412', ['CLICK']],
    ]);
    expect(Object.keys(space.targets.TYPE_TEXT!)).toEqual(['1', '2']);
    expect(Object.keys(space.targets.SELECT!)).toEqual(['3:1']);
    expect(Object.keys(space.controls)).toEqual(['WAIT']);
  });
});
