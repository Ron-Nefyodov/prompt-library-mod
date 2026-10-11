import { test, expect, describe } from 'claude-code/testing';
import {
  STARTERS, LIBRARY_KEY, MAX_IMPORT_CHARS, MAX_PROMPTS, MAX_TEXT_CHARS,
  loadLibrary, isValidName, savePrompt, deletePrompt, recordUse, findPrompt,
  visiblePrompts, hasPlaceholder, fillPlaceholder, exportJson, parseImport,
  mergeImport, parseCommand, timeAgo,
} from './library.js';

const NOW = 1_000_000_000_000;

function memoryStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key: string) => data[key],
    set: async (key: string, value: unknown) => { data[key] = value; },
  };
}

describe('starters', () => {
  test('eight starters, valid names, unique', async () => {
    expect(STARTERS).toHaveLength(8);
    const names = STARTERS.map((p: any) => p.name);
    expect(new Set(names).size).toBe(8);
    for (const name of names) expect(isValidName(name)).toBe(true);
    for (const p of STARTERS) expect(p.text.length).toBeGreaterThan(10);
  });

  test('cover the design list', async () => {
    const names = STARTERS.map((p: any) => p.name).join(' ');
    for (const word of ['review', 'test', 'explain', 'bug', 'commit', 'simplify', 'logging', 'document']) {
      expect(names).toContain(word);
    }
  });

  test('first load seeds the starters once', async () => {
    const store = memoryStore();
    const first = await loadLibrary(store);
    expect(first).toHaveLength(8);
    expect(store.data[LIBRARY_KEY]).toHaveLength(8);
    expect(first.every((p: any) => p.uses === 0)).toBe(true);
  });

  test('a saved empty library stays empty', async () => {
    const store = memoryStore({ [LIBRARY_KEY]: [] });
    expect(await loadLibrary(store)).toEqual([]);
  });

  test('a corrupt stored value drops bad rows', async () => {
    const store = memoryStore({ [LIBRARY_KEY]: [{ name: 'ok', text: 'fine' }, { name: 3 }, 'x'] });
    const list = await loadLibrary(store);
    expect(list.map((p: any) => p.name)).toEqual(['ok']);
    expect(list[0].uses).toBe(0);
  });
});

describe('names', () => {
  test('accepts short words, refuses spaces and junk', async () => {
    expect(isValidName('fix-bug_2.v')).toBe(true);
    expect(isValidName('')).toBe(false);
    expect(isValidName('has space')).toBe(false);
    expect(isValidName('a'.repeat(41))).toBe(false);
    expect(isValidName(42 as any)).toBe(false);
  });
});

describe('crud', () => {
  test('save adds, save again replaces text and keeps uses', async () => {
    let list = savePrompt([], 'a', 'one', NOW);
    expect(list).toEqual([{ name: 'a', text: 'one', uses: 0, lastUsed: null, createdAt: NOW }]);
    list = recordUse(list, 'a', NOW + 5);
    list = savePrompt(list, 'a', 'two', NOW + 10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ text: 'two', uses: 1, lastUsed: NOW + 5 });
  });

  test('save trims text and refuses bad input', async () => {
    expect(savePrompt([], 'a', '  hi  ', NOW)[0].text).toBe('hi');
    expect(() => savePrompt([], 'bad name', 'x', NOW)).toThrow();
    expect(() => savePrompt([], 'a', '   ', NOW)).toThrow();
    expect(() => savePrompt([], 'a', 'x'.repeat(MAX_TEXT_CHARS + 1), NOW)).toThrow();
  });

  test('save refuses past the cap', async () => {
    const full = Array.from({ length: MAX_PROMPTS }, (_, i) => ({ name: `p${i}`, text: 't', uses: 0, lastUsed: null, createdAt: NOW }));
    expect(() => savePrompt(full, 'new', 'x', NOW)).toThrow();
    expect(savePrompt(full, 'p1', 'y', NOW)).toHaveLength(MAX_PROMPTS);
  });

  test('delete removes by name and says if it did', async () => {
    const list = savePrompt(savePrompt([], 'a', 'x', NOW), 'b', 'y', NOW);
    expect(deletePrompt(list, 'a')).toEqual({ list: [list[1]], removed: true });
    expect(deletePrompt(list, 'zz').removed).toBe(false);
  });

  test('recordUse counts and stamps', async () => {
    const list = recordUse(recordUse(savePrompt([], 'a', 'x', NOW), 'a', NOW + 1), 'a', NOW + 2);
    expect(list[0]).toMatchObject({ uses: 2, lastUsed: NOW + 2 });
    expect(findPrompt(list, 'a')?.uses).toBe(2);
    expect(findPrompt(list, 'b')).toBeUndefined();
  });
});

describe('search and sort', () => {
  const list = [
    { name: 'alpha', text: 'Review the diff', uses: 1, lastUsed: NOW, createdAt: NOW },
    { name: 'beta', text: 'Write tests', uses: 5, lastUsed: NOW, createdAt: NOW },
    { name: 'gamma', text: 'review tests', uses: 1, lastUsed: NOW + 1, createdAt: NOW },
    { name: 'delta', text: 'other', uses: 0, lastUsed: null, createdAt: NOW },
  ];

  test('sorts by uses, then last used, then name', async () => {
    expect(visiblePrompts(list, '').map((p: any) => p.name)).toEqual(['beta', 'gamma', 'alpha', 'delta']);
  });

  test('filters on name and text, every word, any case', async () => {
    expect(visiblePrompts(list, 'REVIEW').map((p: any) => p.name)).toEqual(['gamma', 'alpha']);
    expect(visiblePrompts(list, 'review tests').map((p: any) => p.name)).toEqual(['gamma']);
    expect(visiblePrompts(list, 'del').map((p: any) => p.name)).toEqual(['delta']);
    expect(visiblePrompts(list, 'nothing-here')).toEqual([]);
  });
});

describe('placeholder', () => {
  test('detects and fills every {{input}}', async () => {
    expect(hasPlaceholder('Explain {{input}}')).toBe(true);
    expect(hasPlaceholder('Explain {{ input }}')).toBe(true);
    expect(hasPlaceholder('Explain this')).toBe(false);
    expect(fillPlaceholder('a {{input}} b {{ input }}', 'X')).toBe('a X b X');
  });

  test('a value with $ patterns is inserted as typed', async () => {
    expect(fillPlaceholder('cost {{input}}', "$& $1 $$")).toBe("cost $& $1 $$");
  });
});

describe('export and import', () => {
  const list = [{ name: 'a', text: 'one', uses: 3, lastUsed: NOW, createdAt: NOW }];

  test('export writes name, text and uses', async () => {
    expect(JSON.parse(exportJson(list))).toEqual({ version: 1, prompts: [{ name: 'a', text: 'one', uses: 3 }] });
  });

  test('import round-trips an export', async () => {
    const parsed = parseImport(exportJson(list));
    expect(parsed).toEqual({ entries: [{ name: 'a', text: 'one' }], skipped: 0 });
  });

  test('import takes a bare array and skips bad entries', async () => {
    const text = JSON.stringify([
      { name: 'ok', text: 'fine' },
      { name: 'bad name', text: 'x' },
      { name: 'empty', text: '  ' },
      { name: 'long', text: 'x'.repeat(MAX_TEXT_CHARS + 1) },
      { name: 'num', text: 5 },
      null,
      'str',
      { name: 'ok', text: 'dup wins last' },
    ]);
    expect(parseImport(text)).toEqual({ entries: [{ name: 'ok', text: 'dup wins last' }], skipped: 7 });
  });

  test('import refuses bad JSON, wrong shape and oversize', async () => {
    expect(parseImport('{nope').error).toMatch(/JSON/);
    expect(parseImport('{"x":1}').error).toMatch(/prompts/);
    expect(parseImport('"str"').error).toMatch(/prompts/);
    expect(parseImport(' '.repeat(MAX_IMPORT_CHARS + 1)).error).toMatch(/large/);
  });

  test('import never runs or keeps foreign fields', async () => {
    const parsed = parseImport(JSON.stringify([{ name: 'x', text: 'y', uses: 999, run: 'rm -rf /', __proto__: { a: 1 } }]));
    expect(parsed.entries).toEqual([{ name: 'x', text: 'y' }]);
  });

  test('merge adds new, updates text of existing, keeps uses, caps size', async () => {
    const merged = mergeImport(list, [{ name: 'a', text: 'new' }, { name: 'b', text: 'two' }], NOW + 1);
    expect(merged.added).toBe(1);
    expect(merged.updated).toBe(1);
    expect(merged.list.find((p: any) => p.name === 'a')).toMatchObject({ text: 'new', uses: 3 });

    const full = Array.from({ length: MAX_PROMPTS }, (_, i) => ({ name: `p${i}`, text: 't', uses: 0, lastUsed: null, createdAt: NOW }));
    const capped = mergeImport(full, [{ name: 'extra', text: 'x' }], NOW);
    expect(capped).toMatchObject({ added: 0, dropped: 1 });
    expect(capped.list).toHaveLength(MAX_PROMPTS);
  });
});

describe('command args', () => {
  test('parses each form', async () => {
    expect(parseCommand('')).toEqual({ action: 'open' });
    expect(parseCommand('  ')).toEqual({ action: 'open' });
    expect(parseCommand('save foo')).toEqual({ action: 'save', name: 'foo', text: '' });
    expect(parseCommand('save foo  Fix the {{input}}\nnow ')).toEqual({ action: 'save', name: 'foo', text: 'Fix the {{input}}\nnow' });
    expect(parseCommand('delete foo')).toEqual({ action: 'delete', name: 'foo' });
    expect(parseCommand('export')).toEqual({ action: 'export' });
    expect(parseCommand('import ./my prompts.json')).toEqual({ action: 'import', path: './my prompts.json' });
    expect(parseCommand('bogus')).toEqual({ action: 'help' });
  });
});

describe('time ago', () => {
  test('reads short', async () => {
    expect(timeAgo(null, NOW)).toBe('never');
    expect(timeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });
});
