// /prompts subcommands. Engine access comes in as plain lambdas.
import {
  EXPORT_FILE, LAST_PROMPT_KEY, LIBRARY_KEY, MAX_IMPORT_CHARS, USAGE,
  deletePrompt, exportJson, findPrompt, loadLibrary, mergeImport, parseCommand, parseImport, savePrompt,
} from './library.js';

export const COMMAND = { name: 'prompts', description: 'Open your prompt library, or save / delete / import / export prompts', argumentHint: '[save|delete|export|import] …' };

function joinPath(cwd, path) {
  if (path.startsWith('/')) return path;
  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// io: { get, set, now, cwd, read, write, stat, open, refresh }
export async function runPromptsCommand(args, io) {
  const command = parseCommand(args);
  const storeIO = { get: io.get, set: io.set };

  if (command.action === 'open') {
    await io.open();
    return {};
  }
  if (command.action === 'help') return { text: USAGE };

  const list = await loadLibrary(storeIO);

  if (command.action === 'save') {
    if (!command.name) return { text: 'Give the prompt a name: /prompts save <name> [text]' };
    let text = command.text;
    if (!text) {
      text = await io.get(LAST_PROMPT_KEY);
      if (typeof text !== 'string' || !text.trim()) return { text: 'No prompt sent yet in this session. Use /prompts save <name> <text>.' };
    }
    const existed = Boolean(findPrompt(list, command.name));
    try {
      await io.set(LIBRARY_KEY, savePrompt(list, command.name, text, await io.now()));
    } catch (error) {
      return { text: error.message };
    }
    await io.refresh();
    return { text: `${existed ? 'Updated' : 'Saved'} prompt "${command.name}".` };
  }

  if (command.action === 'delete') {
    if (!command.name) return { text: 'Which one? /prompts delete <name>' };
    const { list: next, removed } = deletePrompt(list, command.name);
    if (!removed) return { text: `No prompt named "${command.name}".` };
    await io.set(LIBRARY_KEY, next);
    await io.refresh();
    return { text: `Deleted prompt "${command.name}".` };
  }

  if (command.action === 'export') {
    const path = joinPath(await io.cwd(), EXPORT_FILE);
    const isTaken = await io.stat(path).then(() => true, () => false);
    if (isTaken) return { text: `${path} already exists. Move or rename it, then export again.` };
    try {
      await io.write(path, exportJson(list));
    } catch (error) {
      return { text: `Could not write ${path}: ${error?.message ?? error}` };
    }
    return { text: `Exported ${plural(list.length, 'prompt')} to ${path}` };
  }

  if (command.action === 'import') {
    if (!command.path) return { text: 'Give a file path: /prompts import <path>' };
    const path = joinPath(await io.cwd(), command.path);
    let text;
    try {
      const stat = await io.stat(path);
      if (stat.size > MAX_IMPORT_CHARS) return { text: `File too large (max ${MAX_IMPORT_CHARS / 1024} KB): ${path}` };
      text = await io.read(path);
    } catch (error) {
      return { text: `Could not read ${path}: ${error?.message ?? error}` };
    }
    const parsed = parseImport(text);
    if (parsed.error) return { text: `Import failed: ${parsed.error}` };
    const merged = mergeImport(list, parsed.entries, await io.now());
    await io.set(LIBRARY_KEY, merged.list);
    await io.refresh();
    const dropped = merged.dropped ? `, ${merged.dropped} dropped (library full)` : '';
    return { text: `Imported from ${path}: ${merged.added} added, ${merged.updated} updated, ${parsed.skipped} skipped${dropped}.` };
  }

  return { text: USAGE };
}
