import { COMMAND, runPromptsCommand } from './commands.js';
import {
  LAST_PROMPT_KEY, LIBRARY_KEY,
  deletePrompt, fillPlaceholder, hasPlaceholder, loadLibrary, recordUse, visiblePrompts,
} from './library.js';
import { DEFAULT_VIEW, PANE_ID, drawPromptsPane } from './pane.js';

function isOwnPromptText(text) {
  return typeof text === 'string' && text.trim() !== '' && !text.trimStart().startsWith('/');
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register(COMMAND);
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e);
    if (e.origin.kind === 'composer') {
      if (isOwnPromptText(e.text)) {
        try {
          await $.store.set(LAST_PROMPT_KEY, e.text);
        } catch {
        }
      }    }
    return result;
  }).catch(($, e, next) => next(e));

  on('command.run', { command: 'prompts' }, async ($, e, next) => {
    const refresh = async () => {
      const { value } = await $.state.get({ plugin: 'prompt-library', key: 'view' });
      await $.state.set({ plugin: 'prompt-library', key: 'view' }, { ...DEFAULT_VIEW, ...(value ?? {}), rev: (value?.rev ?? 0) + 1 });
    };
    return runPromptsCommand(e.args, {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      now: () => $.clock.now(),
      cwd: () => $.session.cwd(),
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      stat: (path) => $.fs.stat(path),
      refresh,
      open: async () => {
        await $.state.set({ plugin: 'prompt-library', key: 'view' }, { ...DEFAULT_VIEW });
        await $.ui.open({ id: PANE_ID, title: 'Prompts', focus: true, closeOnEscape: true, rows: 20 });
      },
    });
  }).catch(() => ({ text: '/prompts hit an error. Try again.' }));

  on('ui.render', { component: 'Pane', requestId: 'prompts' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e);
    try {
      const storeIO = { get: (key) => $.store.get(key), set: (key, value) => $.store.set(key, value) };
      const { value: held } = await $.state.get({ plugin: 'prompt-library', key: 'view' });
      const view = { ...DEFAULT_VIEW, ...(held ?? {}) };
      const list = await loadLibrary(storeIO);
      const items = visiblePrompts(list, view.query);
      const selected = items.find((p) => p.name === view.selected) ?? items[0] ?? null;

      const patch = async (changes) => {
        const { value } = await $.state.get({ plugin: 'prompt-library', key: 'view' });
        await $.state.set({ plugin: 'prompt-library', key: 'view' }, { ...DEFAULT_VIEW, ...(value ?? {}), ...changes, rev: (value?.rev ?? 0) + 1 });
      };
      const countUse = async (name) => {
        const fresh = await loadLibrary(storeIO);
        await $.store.set(LIBRARY_KEY, recordUse(fresh, name, await $.clock.now()));
      };
      const send = async (text, name) => {
        await countUse(name);
        await patch({ ...DEFAULT_VIEW });
        await $.ui.close({ id: PANE_ID });
        await $.prompt.submit({ text, asUser: true });
      };

      const act = {
        search: (query) => patch({ query, mode: 'browse', message: '' }),
        pick: async (query) => {
          const first = visiblePrompts(await loadLibrary(storeIO), query)[0];
          await patch({ query, mode: 'browse', message: '', ...(first && { selected: first.name }) });
          if (first) await $.ui.focus({ requestId: PANE_ID, key: 'send' }).catch(() => undefined);
        },
        select: (name) => patch({ selected: name, mode: 'browse', message: '' }),
        send: async () => {
          if (hasPlaceholder(selected.text)) {
            await patch({ selected: selected.name, mode: 'fill', message: '' });
            await $.ui.focus({ requestId: PANE_ID, key: 'fill' }).catch(() => undefined);
            return;
          }
          await send(selected.text, selected.name);
        },
        fill: (value) => send(fillPlaceholder(selected.text, value), selected.name),
        copy: async (press) => {
          const copied = await $.ui.copy({ text: selected.text, surface: press.surface });
          if (copied.isCopied) await countUse(selected.name);
          await patch({
            selected: selected.name,
            message: copied.isCopied ? `Copied "${selected.name}" to the clipboard.` : `Could not copy: ${copied.reason ?? 'unknown reason'}`,
          });
        },
        askDelete: () => patch({ selected: selected.name, mode: 'confirm', message: '' }),
        confirmDelete: async () => {
          const fresh = await loadLibrary(storeIO);
          await $.store.set(LIBRARY_KEY, deletePrompt(fresh, selected.name).list);
          await patch({ selected: null, mode: 'browse', message: `Deleted "${selected.name}".` });
        },
        cancel: () => patch({ mode: 'browse', message: '' }),
      };

      return drawPromptsPane($.ui.resolve(e), {
        items,
        selected,
        total: list.length,
        query: view.query,
        mode: selected ? view.mode : 'browse',
        message: view.message,
        messageColor: view.message.startsWith('Could not') ? 'error' : 'success',
        columns: e.props.bodyColumns ?? 80,
        rows: e.props.scroll?.bodyRows ?? 20,
        now: await $.clock.now(),
        act,
      });
    } catch {
      return next(e);
    }
  });
}
