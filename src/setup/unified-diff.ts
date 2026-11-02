type Line = { op: ' ' | '-' | '+'; text: string };

const CONTEXT = 3;

const linesOf = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

// Longest common subsequence, table-driven: config files are small enough for O(n·m).
const lineOps = (before: string[], after: string[]): Line[] => {
  const common = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const ops: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      ops.push({ op: ' ', text: before[i++] });
      j++;
    } else if (j < after.length && (i === before.length || common[i][j + 1] >= common[i + 1][j])) {
      ops.push({ op: '+', text: after[j++] });
    } else {
      ops.push({ op: '-', text: before[i++] });
    }
  }
  return ops;
};

// Index ranges of `ops` to show: every change plus its context, merging ranges that touch.
const hunkRanges = (ops: Line[]) => {
  const ranges: [number, number][] = [];
  ops.forEach(({ op }, index) => {
    if (op === ' ') return;
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(ops.length, index + CONTEXT + 1);
    const last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });
  return ranges;
};

// `@@ -start,count` uses the line before the hunk as its start when the side is empty, as diff does.
const side = (start: number, count: number) => `${count ? start + 1 : start},${count}`;

/**
 * A unified diff of two texts with three lines of context, as `diff -u` prints it; `before` undefined is a new file
 * (`--- /dev/null`). Empty when nothing changes.
 *
 * @example
 * unifiedDiff('{}\n', '{\n  "a": 1\n}\n', '~/.cursor/mcp.json')
 * // '--- ~/.cursor/mcp.json\n+++ ~/.cursor/mcp.json\n@@ -1 +1,3 @@ …'
 */
export const unifiedDiff = (before: string | undefined, after: string, path: string) => {
  const ops = lineOps(linesOf(before ?? ''), linesOf(after));
  const ranges = hunkRanges(ops);
  if (!ranges.length) return '';
  const hunks = ranges.map(([start, end]) => {
    const prior = ops.slice(0, start);
    const shown = ops.slice(start, end);
    const oldStart = prior.filter(({ op }) => op !== '+').length;
    const newStart = prior.filter(({ op }) => op !== '-').length;
    const oldCount = shown.filter(({ op }) => op !== '+').length;
    const newCount = shown.filter(({ op }) => op !== '-').length;
    return [`@@ -${side(oldStart, oldCount)} +${side(newStart, newCount)} @@`, ...shown.map(({ op, text }) => `${op}${text}`)];
  });
  return [`--- ${before === undefined ? '/dev/null' : path}`, `+++ ${path}`, ...hunks.flat(), ''].join('\n');
};
