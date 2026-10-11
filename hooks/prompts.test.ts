import { test, expect, describe } from 'claude-code/testing';
import { LIBRARY_KEY, LAST_PROMPT_KEY, MAX_IMPORT_CHARS } from './library.js';

const PLUGIN = 'prompt-library';
const CWD = '/work';
const NOW = 1_700_000_000_000;
const PANE = {
  plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'prompts',
  props: { title: 'Prompts', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const;

const run = (args: string) => ({
  command: 'prompts', args, origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
});

type World = {
  store: Map<string, unknown>;
  files: Map<string, string>;
  writes: { path: string; text: string }[];
  reads: string[];
  submitted: any[];
  copied: string[];
  opened: any[];
  closed: string[];
  commands: string[];
};

function worldOf(on: any, store: Record<string, unknown> = {}, files: Record<string, string> = {}): World {
  const world: World = {
    store: new Map(Object.entries(store)), files: new Map(Object.entries(files)),
    writes: [], reads: [], submitted: [], copied: [], opened: [], closed: [], commands: [],
  };
  on('store.get', ($: any, e: any) => ({ value: world.store.get(e.key) }));
  on('store.set', ($: any, e: any) => { world.store.set(e.key, e.value); return { value: undefined }; });
  on('store.delete', ($: any, e: any) => { world.store.delete(e.key); return { value: undefined }; });
  on('store.keys', () => ({ value: [...world.store.keys()] }));
  on('clock.now', () => ({ value: NOW }));
  on('session.cwd', () => ({ value: CWD }));
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }));
  on('command.register', ($: any, e: any) => { world.commands.push(e.name); return { value: { command: e.name } }; });
  on('ui.open', ($: any, e: any) => { world.opened.push(e); return { value: { isPlaced: true } }; });
  on('ui.close', ($: any, e: any) => { world.closed.push(e.id); return { value: undefined }; });
  on('ui.focus', () => ({ value: {} }));
  on('ui.copy', ($: any, e: any) => { world.copied.push(e.text); return { value: { isCopied: true } }; });  on('fs.write', ($: any, e: any) => { world.writes.push({ path: e.path, text: e.text }); world.files.set(e.path, e.text); return { value: undefined }; });
  on('fs.stat', ($: any, e: any) => {
    const text = world.files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file', size: text.length, mtimeMs: 0 } };
  });
  on('fs.read', ($: any, e: any) => {
    world.reads.push(e.path);
    const text = world.files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  on('prompt.submit', ($: any, e: any) => { world.submitted.push(e); return { text: e.text }; });
  return world;
}

const names = (world: World) => ((world.store.get(LIBRARY_KEY) as any[]) ?? []).map((p) => p.name);
const prompt = (world: World, name: string) => ((world.store.get(LIBRARY_KEY) as any[]) ?? []).find((p) => p.name === name);
const shown = async (ui: any, key: string) => (await ui.find({ key }))?.text ?? '';

describe('start and composer tracking', () => {
  test('session start registers /prompts', async ($: any, on: any) => {
    const world = worldOf(on);
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true });
    expect(world.commands).toEqual(['prompts']);
  });

  test('a typed prompt is remembered; the typed prompt is remembered', async ($: any, on: any) => {
    const world = worldOf(on);
    await $.prompt.submit({ text: 'Refactor the parser', wait: false, origin: { kind: 'composer' } });
    expect(world.store.get(LAST_PROMPT_KEY)).toBe('Refactor the parser');
  });

  test('a plugin prompt is not remembered', async ($: any, on: any) => {
    const world = worldOf(on);
    await $.prompt.submit({ text: 'from a plugin', wait: false, origin: { kind: 'plugin', name: 'other' } });
    expect(world.store.get(LAST_PROMPT_KEY)).toBeUndefined();
  });
});

describe('/prompts commands', () => {
  test('save with no text uses the last typed prompt', async ($: any, on: any) => {
    const world = worldOf(on);
    await $.prompt.submit({ text: 'Make the build faster', wait: false, origin: { kind: 'composer' } });
    const { text } = await $.command.run(run('save speed'));
    expect(text).toContain('speed');
    expect(prompt(world, 'speed')).toMatchObject({ text: 'Make the build faster', uses: 0 });
    expect(names(world)).toHaveLength(9);
  });

  test('save with no last prompt says so', async ($: any, on: any) => {
    const world = worldOf(on);
    const { text } = await $.command.run(run('save speed'));
    expect(text).toMatch(/no prompt/i);
    expect(prompt(world, 'speed')).toBeUndefined();
  });

  test('save with text, bad name refused', async ($: any, on: any) => {
    const world = worldOf(on);
    await $.command.run(run('save hello Say hi to {{input}}'));
    expect(prompt(world, 'hello').text).toBe('Say hi to {{input}}');
    const { text } = await $.command.run(run('save'));
    expect(text).toMatch(/name/i);
  });

  test('delete removes, unknown says so', async ($: any, on: any) => {
    const world = worldOf(on);
    expect((await $.command.run(run('delete find-bugs'))).text).toContain('Deleted');
    expect(names(world)).not.toContain('find-bugs');
    expect((await $.command.run(run('delete nope'))).text).toMatch(/no prompt/i);
  });

  test('export writes prompts.json in cwd', async ($: any, on: any) => {
    const world = worldOf(on);
    const { text } = await $.command.run(run('export'));
    expect(world.writes.map((w) => w.path)).toEqual([`${CWD}/prompts.json`]);
    expect(JSON.parse(world.writes[0].text).prompts).toHaveLength(8);
    expect(text).toContain(`${CWD}/prompts.json`);
  });

  test('import merges good entries, skips bad, resolves relative path', async ($: any, on: any) => {
    const file = JSON.stringify({ prompts: [{ name: 'mine', text: 'Do it' }, { name: 'bad name', text: 'x' }, { name: 'write-tests', text: 'Changed' }] });
    const world = worldOf(on, {}, { [`${CWD}/in.json`]: file });
    const { text } = await $.command.run(run('import in.json'));
    expect(text).toMatch(/1 added.*1 updated.*1 skipped/);
    expect(prompt(world, 'mine').text).toBe('Do it');
    expect(prompt(world, 'write-tests').text).toBe('Changed');
  });

  test('import refuses an oversize file without reading it', async ($: any, on: any) => {
    const world = worldOf(on, {}, { '/abs/big.json': ' '.repeat(MAX_IMPORT_CHARS + 1) });
    const { text } = await $.command.run(run('import /abs/big.json'));
    expect(text).toMatch(/too large/i);
    expect(world.reads).toEqual([]);
  });

  test('import reports a missing file and bad JSON', async ($: any, on: any) => {
    worldOf(on, {}, { [`${CWD}/bad.json`]: '{nope' });
    expect((await $.command.run(run('import missing.json'))).text).toMatch(/could not read/i);
    expect((await $.command.run(run('import bad.json'))).text).toMatch(/JSON/);
    expect((await $.command.run(run('import'))).text).toMatch(/path/i);
  });

  test('bare /prompts opens the pane; unknown verb shows usage', async ($: any, on: any) => {
    const world = worldOf(on);
    await $.command.run(run(''));
    expect(world.opened[0]).toMatchObject({ id: 'prompts', focus: true, closeOnEscape: true });
    expect((await $.command.run(run('what'))).text).toContain('Usage');
  });
});

describe('the pane', () => {
  test('lists starters by use count and previews the top one', async ($: any, on: any) => {
    const world = worldOf(on);
    await $.command.run(run('save fav Favourite prompt'));
    const list = world.store.get(LIBRARY_KEY) as any[];
    world.store.set(LIBRARY_KEY, list.map((p) => (p.name === 'fav' ? { ...p, uses: 4, lastUsed: NOW - 7_200_000 } : p)));
    const ui = await $.ui.mount(PANE);
    const rows = await ui.findAll({ type: 'Button' });
    const rowKeys = rows.map((b: any) => b.key).filter((k: string) => k?.startsWith('row:'));
    expect(rowKeys).toHaveLength(9);
    expect(rowKeys[0]).toBe('row:fav');
    expect(await shown(ui, 'preview')).toContain('Favourite prompt');
    expect(await shown(ui, 'meta')).toContain('4 uses');
    expect(await shown(ui, 'meta')).toContain('2h ago');
    await ui.unmount();
  });

  test('search filters live; pressing a row selects it', async ($: any, on: any) => {
    worldOf(on);
    const ui = await $.ui.mount(PANE);
    await ui.input({ key: 'search', text: 'message', kind: 'change' });
    const rowKeys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k?.startsWith('row:'));
    expect(rowKeys).toEqual(['row:commit-message']);
    await ui.input({ key: 'search', text: '', kind: 'change' });
    await ui.press({ key: 'row:explain-repo' });
    expect(await shown(ui, 'preview')).toContain('Explain this repository');
    await ui.input({ key: 'search', text: 'zzzz', kind: 'change' });
    expect(await shown(ui, 'empty')).toContain('zzzz');
    await ui.unmount();
  });

  test('Send submits as the user, counts the use, closes the pane', async ($: any, on: any) => {
    const world = worldOf(on);
    const ui = await $.ui.mount(PANE);
    await ui.press({ key: 'row:explain-repo' });
    await ui.press({ key: 'send' });
    expect(world.submitted).toHaveLength(1);
    expect(world.submitted[0].text).toContain('Explain this repository');
    expect(world.submitted[0].origin).toMatchObject({ kind: 'plugin', asUser: true });
    expect(prompt(world, 'explain-repo')).toMatchObject({ uses: 1, lastUsed: NOW });
    expect(world.closed).toEqual(['prompts']);
    await ui.unmount();
  });

  test('a {{input}} prompt asks for the value first', async ($: any, on: any) => {
    const world = worldOf(on);
    const ui = await $.ui.mount(PANE);
    await ui.press({ key: 'row:write-tests' });
    await ui.press({ key: 'send' });
    expect(world.submitted).toEqual([]);
    expect(await ui.find({ key: 'fill' })).toBeDefined();
    await ui.input({ key: 'fill', text: 'src/parser.ts' });
    expect(world.submitted[0].text).toContain('Write tests for src/parser.ts.');
    expect(world.submitted[0].text).not.toContain('{{input}}');
    expect(prompt(world, 'write-tests').uses).toBe(1);
    await ui.unmount();
  });

  test('cancel leaves the fill step without sending', async ($: any, on: any) => {
    const world = worldOf(on);
    const ui = await $.ui.mount(PANE);
    await ui.press({ key: 'row:write-tests' });
    await ui.press({ key: 'send' });
    await ui.press({ key: 'cancel' });
    expect(await ui.find({ key: 'fill' })).toBeUndefined();
    expect(await ui.find({ key: 'send' })).toBeDefined();
    expect(world.submitted).toEqual([]);
    await ui.unmount();
  });

  test('Copy puts the text on the clipboard and counts a use', async ($: any, on: any) => {
    const world = worldOf(on);
    const ui = await $.ui.mount(PANE);
    await ui.press({ key: 'row:review-diff' });
    await ui.press({ key: 'copy' });
    expect(world.copied[0]).toContain('Review my uncommitted changes');
    expect(prompt(world, 'review-diff').uses).toBe(1);
    expect(await shown(ui, 'message')).toMatch(/copied/i);
    await ui.unmount();
  });

  test('Delete asks, then removes', async ($: any, on: any) => {
    const world = worldOf(on);
    const ui = await $.ui.mount(PANE);
    await ui.press({ key: 'row:add-logging' });
    await ui.press({ key: 'delete' });
    expect(names(world)).toContain('add-logging');
    await ui.press({ key: 'confirm-delete' });
    expect(names(world)).not.toContain('add-logging');
    expect(await ui.find({ key: 'row:add-logging' })).toBeUndefined();
    expect(await shown(ui, 'message')).toContain('add-logging');
    await ui.unmount();
  });

  test('an empty library shows a hint, no action buttons', async ($: any, on: any) => {
    worldOf(on, { [LIBRARY_KEY]: [] });
    const ui = await $.ui.mount(PANE);
    expect(await shown(ui, 'empty')).toMatch(/prompts save/);
    expect(await ui.find({ key: 'send' })).toBeUndefined();
    await ui.unmount();
  });

  test('draws at narrow and short sizes', async ($: any, on: any) => {
    worldOf(on);
    for (const [bodyColumns, bodyRows] of [[30, 8], [60, 12], [140, 40]]) {
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns, scroll: { offset: 0, bodyRows } } });
      expect(await ui.find({ key: 'search' })).toBeDefined();
      await ui.unmount();
    }
  });
});
