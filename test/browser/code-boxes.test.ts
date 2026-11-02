import { describe, expect, it } from 'vitest';
import { codeCharacters, groupCodeBoxes, type CodeBoxFacts } from '../../src/browser/code-boxes.ts';
import { FRAME_ID_STRIDE } from '../../src/browser/frames.ts';
import type { PageAction } from '../../src/browser/tab.ts';

// The reader's facts for a one-character box of a 6-digit sign-in code: maxlength 1, numeric, in one form and container.
const FACTS: CodeBoxFacts = { max: 1, mode: 'numeric', otp: false, type: 'text', form: 50, within: [60, 61], name: '' };

/** A box as the reader lists it: its fill and the "Open …" click twin, side by side on one row. */
const box = (node: number, i: number, facts: Partial<CodeBoxFacts> = {}, extra: Partial<PageAction> = {}): PageAction[] => {
  const rect = { x: 100 + i * 52, y: 200, w: 44, h: 52 };
  const label = `Digit ${i + 1} of 6`;
  return [
    { id: '', kind: 'fill', node, role: 'textbox', label, value: '', rect, box: { ...FACTS, ...facts }, ...extra },
    { id: '', kind: 'click', node, role: 'textbox', label: `Open ${label}`, value: '', rect, ...extra },
  ];
};
const boxes = (count: number, facts: (i: number) => Partial<CodeBoxFacts> = () => ({}), first = 11) =>
  Array.from({ length: count }, (_, i) => box(first + i, i, facts(i))).flat();
const heading: PageAction = { id: '', kind: 'click', node: 1, role: 'link', label: 'Back to sign in' };
const verify: PageAction = { id: '', kind: 'click', node: 30, role: 'button', label: 'Verify' };
const wait: PageAction = { id: 'wait', kind: 'wait', label: 'Wait for the page to update' };
const numbered = (actions: PageAction[]) => actions.map((action, i) => (action.node === undefined ? action : { ...action, id: `e${i + 1}` }));
const page = (...parts: (PageAction | PageAction[])[]) => numbered(parts.flat());
const fills = (actions: PageAction[]) => actions.filter((action) => action.kind === 'fill');
const ungrouped = (actions: PageAction[]) => actions.map(({ box: _box, ...action }) => action);

describe('a code split into one-character boxes', () => {
  it('is one target: the first box, named for the group, holding every box and their joined value', () => {
    const actions = page(heading, boxes(6, () => ({ name: 'Verification code' })), verify, wait);
    actions[3] = { ...actions[3], value: '7' };
    actions[5] = { ...actions[5], value: '3' };
    const grouped = groupCodeBoxes(actions);
    expect(grouped).toEqual([
      { id: 'e1', kind: 'click', node: 1, role: 'link', label: 'Back to sign in' },
      {
        id: 'e2',
        kind: 'fill',
        node: 11,
        role: 'textbox',
        label: 'Verification code (6 boxes)',
        value: '73',
        boxes: [11, 12, 13, 14, 15, 16],
        // The union of the boxes: a Box answer on any box, and the step shot, take the whole group.
        rect: { x: 100, y: 200, w: 5 * 52 + 44, h: 52 },
      },
      {
        id: 'e3',
        kind: 'click',
        node: 11,
        role: 'textbox',
        label: 'Open Verification code (6 boxes)',
        value: '73',
        boxes: [11, 12, 13, 14, 15, 16],
        rect: { x: 100, y: 200, w: 5 * 52 + 44, h: 52 },
      },
      { id: 'e4', kind: 'click', node: 30, role: 'button', label: 'Verify' },
      wait,
    ]);
  });

  it('groups four PIN boxes', () => {
    const grouped = groupCodeBoxes(page(boxes(4, () => ({ name: 'Enter your PIN' })), verify));
    expect(fills(grouped)).toEqual([expect.objectContaining({ label: 'Enter your PIN (4 boxes)', boxes: [11, 12, 13, 14] })]);
  });

  it('groups boxes with no maxlength that are one character wide and numeric, tel, or one-time-code', () => {
    for (const facts of [{ mode: 'numeric' }, { mode: '', type: 'tel' }, { mode: '', type: 'number' }, { mode: '', otp: true }]) {
      const grouped = groupCodeBoxes(page(boxes(6, () => ({ max: -1, ...facts }))));
      expect(fills(grouped), JSON.stringify(facts)).toHaveLength(1);
    }
  });

  it('groups boxes each wrapped in its own element inside one container', () => {
    const grouped = groupCodeBoxes(page(boxes(6, (i) => ({ within: [70 + i, 61] }))));
    expect(fills(grouped)).toEqual([expect.objectContaining({ boxes: [11, 12, 13, 14, 15, 16] })]);
  });

  it('groups a frame\'s boxes by their frame ids', () => {
    const base = 2 * FRAME_ID_STRIDE;
    const grouped = groupCodeBoxes(page(boxes(6, () => ({}), base + 11)));
    expect(fills(grouped)).toEqual([expect.objectContaining({ node: base + 11, boxes: Array.from({ length: 6 }, (_, i) => base + 11 + i) })]);
  });

  it('carries no reader facts out, grouped or not', () => {
    for (const actions of [page(boxes(6)), page(boxes(3))]) expect(JSON.stringify(groupCodeBoxes(actions))).not.toContain('"box"');
  });

  it('is named by the words its boxes share, unless they are generic, else "Verification code"', () => {
    const named = (label: (i: number) => string) =>
      fills(groupCodeBoxes(page(boxes(6).map((action, i) => ({ ...action, label: (action.kind === 'click' ? 'Open ' : '') + label(Math.floor(i / 2)) })))))[0].label;
    expect(named((i) => `Security code character ${i + 1}`)).toBe('Security code character (6 boxes)');
    expect(named((i) => `Digit ${i + 1} of 6`)).toBe('Verification code (6 boxes)');
    expect(named(() => 'textbox')).toBe('Verification code (6 boxes)');
  });
});

describe('fields that are not a split code stay as they are', () => {
  const unchanged = (actions: PageAction[]) => expect(groupCodeBoxes(actions)).toEqual(ungrouped(actions));

  it('a date split into DD / MM / YYYY', () => {
    unchanged(page(box(11, 0, { max: 2 }), box(12, 1, { max: 2 }), box(13, 2, { max: 4 }), verify));
  });

  it('a phone number split 3 / 3 / 4', () => {
    unchanged(page(box(11, 0, { max: 3 }), box(12, 1, { max: 3 }), box(13, 2, { max: 4 })));
  });

  it('a lone maxlength=1 field (a middle initial) and three boxes', () => {
    unchanged(page(heading, box(11, 0), verify));
    unchanged(page(boxes(3)));
  });

  it('more than eight boxes', () => {
    unchanged(page(boxes(9)));
  });

  it('boxes on two rows, in two containers, or in two forms', () => {
    const twoRows = boxes(6).map((action, i) => (i >= 6 ? { ...action, rect: { ...action.rect!, y: 280 } } : action));
    unchanged(page(twoRows));
    unchanged(page(boxes(6, (i) => ({ within: i < 3 ? [60, 61] : [62, 63] }))));
    unchanged(page(boxes(6, (i) => ({ form: i < 3 ? 50 : 51 }))));
  });

  it('another field between the boxes', () => {
    const other: PageAction = { id: '', kind: 'fill', node: 40, role: 'textbox', label: 'Promo code', value: '' };
    unchanged(page(boxes(3), other, boxes(3, () => ({}), 14)));
  });

  it('narrow fields with no maxlength and nothing saying they hold a code character', () => {
    unchanged(page(boxes(6, () => ({ max: -1, mode: '' }))));
  });

  it('wide fields with no maxlength', () => {
    unchanged(page(boxes(6, () => ({ max: -1 })).map((action) => ({ ...action, rect: { ...action.rect!, w: 120 } }))));
  });

  it('boxes laid out right to left, or of very different widths', () => {
    unchanged(page(boxes(6).map((action) => ({ ...action, rect: { ...action.rect!, x: 600 - action.rect!.x } }))));
    unchanged(page(boxes(6).map((action, i) => (i < 2 ? { ...action, rect: { ...action.rect!, w: 20 } } : action))));
  });

  it('boxes shown only on hover', () => {
    unchanged(page(boxes(6).map((action) => ({ ...action, hover: true }))));
  });
});

describe('the characters a code puts into its boxes', () => {
  it('one per box, as given, or with spaces and hyphens taken out when only that fits', () => {
    expect(codeCharacters('739214', 6)).toEqual(['7', '3', '9', '2', '1', '4']);
    expect(codeCharacters('739 214', 6)).toEqual(['7', '3', '9', '2', '1', '4']);
    expect(codeCharacters('739-214', 6)).toEqual(['7', '3', '9', '2', '1', '4']);
    expect(codeCharacters('A1B2', 4)).toEqual(['A', '1', 'B', '2']);
  });

  it('none when the count differs', () => {
    expect(codeCharacters('73921', 6)).toBeUndefined();
    expect(codeCharacters('7392145', 6)).toBeUndefined();
    expect(codeCharacters('', 4)).toBeUndefined();
  });
});
