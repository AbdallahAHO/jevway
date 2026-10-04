import type { PageAction } from '../browser/tab.ts';

export type TargetOperation = 'CLICK' | 'TYPE_TEXT' | 'SELECT';

export interface IndexedElement {
  index: string;
  label: string;
  operations: TargetOperation[];
  role?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  options?: { index: string; label: string; value?: string }[];
}

export interface ActionSpace {
  /** One numbered row per observed DOM node — what Jev reads as page state. */
  elements: IndexedElement[];
  /** Per operation, the only targets that operation may execute. SELECT targets are `element:option`. */
  targets: Partial<Record<TargetOperation, Record<string, PageAction>>>;
  /** Page-level controls that need no target: SCROLL_DOWN, SCROLL_UP, WAIT. */
  controls: Record<string, PageAction>;
}

const OPERATION_BY_KIND = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' } as const;

/**
 * Turns a snapshot's flat action list into Jev's dynamic action space:
 * one index per element, and a separate valid-target set per operation.
 *
 * @example
 * const { elements, targets } = buildActionSpace(page.actions);
 * targets.TYPE_TEXT?.['3'] // the fill action for element [3]
 */
export const buildActionSpace = (actions: PageAction[]): ActionSpace => {
  const elements: IndexedElement[] = [];
  const indexByNode = new Map<number, string>();
  const targets: ActionSpace['targets'] = {};
  const controls: ActionSpace['controls'] = {};

  for (const action of actions) {
    if (!(action.kind in OPERATION_BY_KIND)) {
      controls[action.id.toUpperCase()] = action;
      continue;
    }
    const operation = OPERATION_BY_KIND[action.kind as keyof typeof OPERATION_BY_KIND];
    let index = indexByNode.get(action.node!);
    if (!index) {
      index = String(elements.length + 1);
      indexByNode.set(action.node!, index);
      elements.push({
        index,
        label: action.label.split(' → ')[0],
        operations: [],
        ...pick(action, ['role', 'value', 'checked', 'selected', 'expanded']),
        ...(action.kind === 'select' && { value: action.current_value ?? '', options: [] }),
      });
    }
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);

    let target = index;
    if (action.kind === 'select') {
      target = `${index}:${element.options!.length + 1}`;
      element.options!.push({ index: target, label: action.label, value: action.value });
    }
    (targets[operation] ??= {})[target] = action;
  }
  return { elements, targets, controls };
};

export const pick = <T extends object, K extends keyof T>(source: T, keys: K[]) =>
  Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])) as Pick<T, K>;
