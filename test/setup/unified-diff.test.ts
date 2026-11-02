import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/setup/unified-diff.ts';

describe('the diff setup shows before editing a config file', () => {
  it('shows the fewest changed lines, with up to three lines of context', () => {
    const before = ['{', '  "mcpServers": {', '    "other": {', '      "command": "other"', '    }', '  }', '}', ''].join('\n');
    const after = [
      '{',
      '  "mcpServers": {',
      '    "other": {',
      '      "command": "other"',
      '    },',
      '    "jevway": {',
      '      "command": "npx"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(unifiedDiff(before, after, '~/.cursor/mcp.json')).toBe(
      [
        '--- ~/.cursor/mcp.json',
        '+++ ~/.cursor/mcp.json',
        '@@ -2,6 +2,9 @@',
        '   "mcpServers": {',
        '     "other": {',
        '       "command": "other"',
        '+    },',
        '+    "jevway": {',
        '+      "command": "npx"',
        '     }',
        '   }',
        ' }',
        '',
      ].join('\n'),
    );
  });

  it('a new file is diffed against /dev/null', () => {
    expect(unifiedDiff(undefined, '{\n  "a": 1\n}\n', '~/x.json')).toBe(
      ['--- /dev/null', '+++ ~/x.json', '@@ -0,0 +1,3 @@', '+{', '+  "a": 1', '+}', ''].join('\n'),
    );
  });

  it('keeps distant changes in separate hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 2\n', 'line two\n').replace('line 19', 'line nineteen');
    const hunks = unifiedDiff(before, after, 'f').split('\n').filter((line) => line.startsWith('@@'));
    expect(hunks).toEqual(['@@ -1,5 +1,5 @@', '@@ -16,5 +16,5 @@']);
  });

  it('prints removed lines before the lines that replace them, and leaves out a count of 1', () => {
    expect(unifiedDiff('{"a":1}\n', '{\n  "a": 1\n}\n', 'f')).toBe(['--- f', '+++ f', '@@ -1 +1,3 @@', '-{"a":1}', '+{', '+  "a": 1', '+}', ''].join('\n'));
  });

  it('is empty when nothing changes', () => {
    expect(unifiedDiff('same\n', 'same\n', 'f')).toBe('');
  });
});
