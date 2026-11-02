import type { PageAction } from './tab.ts';

/** What the reader (snapshot.js) notes about a short text input that may be one box of a code split into boxes. */
export interface CodeBoxFacts {
  /** The input's `maxlength`; -1 when it has none. */
  max: number;
  /** Its `inputmode`, '' when unset. */
  mode: string;
  /** `autocomplete="one-time-code"`. */
  otp: boolean;
  type: string;
  /** Its form, as a key unique within one read; 0 outside a form. */
  form: number;
  /** Its parent and grandparent, as keys unique within one read. */
  within: number[];
  /** The group's own name where the reader found one around the box: an aria name, a legend, a short line before it. */
  name: string;
}

const MIN_BOXES = 4;
const MAX_BOXES = 8;
// One character fits in a box this wide at any common font size; a field for a word is wider.
const ONE_CHARACTER_PX = 64;
const CODE_MODES = ['numeric', 'decimal', 'text', 'tel'];
const CODE_TYPES = ['tel', 'number'];
// Words a box's own label shares with its neighbours that name no field ("Digit 1 of 6").
const GENERIC_WORDS = /^(?:digit|character|char|box|number|input|field|code|otp|pin|textbox|spinbutton)s?$/i;
const FALLBACK_NAME = 'Verification code';

type Box = PageAction & { box: CodeBoxFacts; rect: NonNullable<PageAction['rect']> };

const holdsOneCharacter = (action: PageAction): action is Box => {
  const { box, rect } = action;
  if (action.kind !== 'fill' || !box || !rect || action.hover) return false;
  if (box.max === 1) return true;
  return box.max < 0 && rect.w <= ONE_CHARACTER_PX && (CODE_MODES.includes(box.mode) || CODE_TYPES.includes(box.type) || box.otp);
};

const centreY = (box: Box) => box.rect.y + box.rect.h / 2;

// One form, one container (every box in the same parent, or each wrapped once in the same grandparent), one row, read
// left to right, all about the same width.
const joins = (run: Box[], next: Box) => {
  const [first] = run;
  const last = run.at(-1)!;
  const widths = [...run, next].map((box) => box.rect.w);
  return (
    next.box.form === first.box.form &&
    [0, 1].some((level) => run.every((box) => box.box.within[level] === next.box.within[level])) &&
    Math.abs(centreY(next) - centreY(first)) <= first.rect.h / 2 &&
    next.rect.x > last.rect.x &&
    Math.max(...widths) <= Math.min(...widths) * 1.5
  );
};

// Runs of one-character boxes that follow one another among the listed fields; another field between them ends a run.
const runsOf = (actions: PageAction[]) => {
  const runs: Box[][] = [];
  let run: Box[] = [];
  for (const action of actions) {
    if (action.kind !== 'fill') continue;
    if (holdsOneCharacter(action) && run.length && joins(run, action)) {
      run.push(action);
      continue;
    }
    if (run.length) runs.push(run);
    run = holdsOneCharacter(action) ? [action] : [];
  }
  if (run.length) runs.push(run);
  return runs.filter((boxes) => boxes.length >= MIN_BOXES && boxes.length <= MAX_BOXES);
};

// "Security code character 3" → "Security code character": a box's label without its place in the group.
const stemOf = (label: string) =>
  label
    .replace(/\d+/g, ' ')
    .replace(/\bof\b/gi, ' ')
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .replace(/\s+/g, ' ');

const nameOf = (run: Box[]) => {
  if (run[0].box.name) return run[0].box.name;
  const stems = new Set(run.map((box) => stemOf(box.label)));
  const [stem] = stems;
  return stems.size === 1 && stem && !GENERIC_WORDS.test(stem) ? stem : FALLBACK_NAME;
};

const unionOf = (run: Box[]) => {
  const left = Math.min(...run.map((box) => box.rect.x));
  const top = Math.min(...run.map((box) => box.rect.y));
  const right = Math.max(...run.map((box) => box.rect.x + box.rect.w));
  const bottom = Math.max(...run.map((box) => box.rect.y + box.rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
};

const withoutFacts = ({ box: _box, ...action }: PageAction): PageAction => action;

/**
 * A code split into one-character boxes (4–8 `maxlength=1` boxes, or narrow numeric/one-time-code ones with no
 * `maxlength`, following one another in one form and container, left to right on one row) becomes one `fill` target on
 * its first box: `boxes` lists every box, `value` joins their values, `rect` covers them all, and the label is the
 * group's name with the count. The other boxes and their `Open …` clicks are not listed. The reader's facts are removed
 * from every action, and element ids are renumbered when anything was grouped.
 *
 * @example
 * groupCodeBoxes(snapshot.actions) // [{ kind: 'fill', node: 11, label: 'Verification code (6 boxes)', boxes: [11, …, 16], … }, …]
 */
export const groupCodeBoxes = (actions: PageAction[]): PageAction[] => {
  const runs = runsOf(actions);
  if (!runs.length) return actions.some((action) => action.box) ? actions.map(withoutFacts) : actions;
  const groupOf = new Map<number, { first: number; boxes: number[]; label: string; value: string; rect: NonNullable<PageAction['rect']> }>();
  for (const run of runs) {
    const group = {
      first: run[0].node!,
      boxes: run.map((box) => box.node!),
      label: `${nameOf(run)} (${run.length} boxes)`,
      value: run.map((box) => box.value ?? '').join(''),
      rect: unionOf(run),
    };
    for (const node of group.boxes) groupOf.set(node, group);
  }
  let next = 0;
  return actions.flatMap((action) => {
    const group = action.node === undefined ? undefined : groupOf.get(action.node);
    if (group && action.node !== group.first) return [];
    const { label, value, boxes, rect } = group ?? {};
    const listed = group ? { ...withoutFacts(action), label: action.kind === 'click' ? `Open ${label}` : label!, value, boxes, rect } : withoutFacts(action);
    return [action.node === undefined ? listed : { ...listed, id: `e${++next}` }];
  });
};

/**
 * The characters a code puts into `count` boxes, one each: the text as given, or without its spaces and hyphens when
 * only that fits ("739 214" into 6 boxes). Undefined when neither fits.
 *
 * @example
 * codeCharacters('739-214', 6) // ['7', '3', '9', '2', '1', '4']
 */
export const codeCharacters = (text: string, count: number): string[] | undefined => {
  for (const form of [text, text.replace(/[\s-]/g, '')]) {
    const characters = [...form];
    if (characters.length === count) return characters;
  }
  return undefined;
};
