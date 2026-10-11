// Pure prompt-library logic. No engine calls here.
export const LIBRARY_KEY = 'prompt-library';
export const LAST_PROMPT_KEY = 'last-prompt';
export const MAX_PROMPTS = 500;
export const MAX_TEXT_CHARS = 10000;
export const MAX_IMPORT_CHARS = 512 * 1024;
export const EXPORT_FILE = 'prompts.json';

const NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,39}$/;
const PLACEHOLDER = /\{\{\s*input\s*\}\}/g;

export const STARTERS = [
  { name: 'review-diff', text: 'Review my uncommitted changes (git diff). List real bugs, risky edits and missing tests, most important first. Skip style nits.' },
  { name: 'write-tests', text: 'Write tests for {{input}}. Cover the main path, edge cases and error cases. Follow the test style already used in this repo, then run them.' },
  { name: 'explain-repo', text: 'Explain this repository: what it does, how it is laid out, the main entry points, and how to build and test it. Keep it short.' },
  { name: 'find-bugs', text: 'Look for bugs in {{input}}. For each one, give the file and line, why it is wrong, and a fix. Only report issues you are confident about.' },
  { name: 'commit-message', text: 'Write a commit message for my staged changes (git diff --staged): a short summary line, a blank line, then why the change was made.' },
  { name: 'simplify-file', text: 'Simplify {{input}} without changing its behavior: remove dead code and duplication, and make names clearer. Show the diff and run the tests.' },
  { name: 'add-logging', text: 'Add useful logging to {{input}}: entry and exit of key operations and error paths, using the logger this project already has. Never log secrets.' },
  { name: 'document-module', text: 'Document {{input}}: a short module overview, plus doc comments on its public functions covering inputs, outputs and errors.' },
];

export function isValidName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

// Text elements refuse control characters other than tab and newline.
function cleanText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function isValidText(text) {
  return typeof text === 'string' && cleanText(text).trim().length > 0 && text.length <= MAX_TEXT_CHARS;
}

function normalize(row) {
  if (!row || typeof row !== 'object' || !isValidName(row.name) || !isValidText(row.text)) return null;
  return {
    name: row.name,
    text: cleanText(row.text),
    uses: Number.isInteger(row.uses) && row.uses > 0 ? row.uses : 0,
    lastUsed: typeof row.lastUsed === 'number' ? row.lastUsed : null,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
  };
}

export async function loadLibrary({ get, set }) {
  const stored = await get(LIBRARY_KEY);
  if (stored === undefined || stored === null) {
    const seeded = STARTERS.map((p) => ({ name: p.name, text: p.text, uses: 0, lastUsed: null, createdAt: 0 }));
    await set(LIBRARY_KEY, seeded);
    return seeded;
  }
  if (!Array.isArray(stored)) return [];
  return stored.map(normalize).filter(Boolean);
}

export function findPrompt(list, name) {
  return list.find((p) => p.name === name);
}

export function savePrompt(list, name, text, now) {
  if (!isValidName(name)) throw new Error(`Bad name "${name}". Use letters, digits, - _ . (max 40, no spaces).`);
  const trimmed = typeof text === 'string' ? cleanText(text).trim() : '';
  if (!trimmed) throw new Error('Nothing to save: the prompt text is empty.');
  if (trimmed.length > MAX_TEXT_CHARS) throw new Error(`Prompt too long (max ${MAX_TEXT_CHARS} characters).`);
  const existing = findPrompt(list, name);
  if (existing) return list.map((p) => (p.name === name ? { ...p, text: trimmed } : p));
  if (list.length >= MAX_PROMPTS) throw new Error(`Library full (${MAX_PROMPTS} prompts). Delete some first.`);
  return [...list, { name, text: trimmed, uses: 0, lastUsed: null, createdAt: now }];
}

export function deletePrompt(list, name) {
  const next = list.filter((p) => p.name !== name);
  return { list: next, removed: next.length !== list.length };
}

export function recordUse(list, name, now) {
  return list.map((p) => (p.name === name ? { ...p, uses: p.uses + 1, lastUsed: now } : p));
}

function byUse(a, b) {
  return (b.uses - a.uses) || ((b.lastUsed ?? 0) - (a.lastUsed ?? 0)) || a.name.localeCompare(b.name);
}

export function visiblePrompts(list, query) {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length === 0
    ? list
    : list.filter((p) => {
      const haystack = `${p.name}\n${p.text}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  return [...matches].sort(byUse);
}

export function hasPlaceholder(text) {
  return new RegExp(PLACEHOLDER.source).test(text);
}

export function fillPlaceholder(text, value) {
  return text.replace(new RegExp(PLACEHOLDER.source, 'g'), () => value);
}

export function exportJson(list) {
  const prompts = list.map((p) => ({ name: p.name, text: p.text, uses: p.uses }));
  return `${JSON.stringify({ version: 1, prompts }, null, 2)}\n`;
}

// Reads untrusted JSON. Keeps only name + text strings. Never evaluates anything.
export function parseImport(text) {
  if (typeof text !== 'string') return { error: 'File is not text.' };
  if (text.length > MAX_IMPORT_CHARS) return { error: `File too large (max ${MAX_IMPORT_CHARS / 1024} KB).` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'File is not valid JSON.' };
  }
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray(data.prompts) ? data.prompts : null);
  if (!rows) return { error: 'Expected a list of prompts, or an object with a "prompts" list.' };
  const byName = new Map();
  let skipped = 0;
  for (const row of rows) {
    const valid = row && typeof row === 'object' && isValidName(row.name) && isValidText(row.text);
    if (!valid) {
      skipped += 1;
      continue;
    }
    if (byName.has(row.name)) skipped += 1;
    byName.delete(row.name);
    byName.set(row.name, { name: row.name, text: cleanText(row.text).trim() });
  }
  return { entries: [...byName.values()], skipped };
}

export function mergeImport(list, entries, now) {
  let next = list;
  let added = 0;
  let updated = 0;
  let dropped = 0;
  for (const entry of entries) {
    if (findPrompt(next, entry.name)) {
      next = next.map((p) => (p.name === entry.name ? { ...p, text: entry.text } : p));
      updated += 1;
    } else if (next.length >= MAX_PROMPTS) {
      dropped += 1;
    } else {
      next = [...next, { name: entry.name, text: entry.text, uses: 0, lastUsed: null, createdAt: now }];
      added += 1;
    }
  }
  return { list: next, added, updated, dropped };
}

export function parseCommand(args) {
  const trimmed = (args ?? '').trim();
  if (!trimmed) return { action: 'open' };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const verb = match[1].toLowerCase();
  const rest = match[2];
  if (verb === 'save') {
    const [, name = '', text = ''] = /^(\S*)\s*([\s\S]*)$/.exec(rest);
    return { action: 'save', name, text: text.trim() };
  }
  if (verb === 'delete') return { action: 'delete', name: rest.trim() };
  if (verb === 'export') return { action: 'export' };
  if (verb === 'import') return { action: 'import', path: rest.trim() };
  return { action: 'help' };
}

export const USAGE = [
  'Usage:',
  '  /prompts                     open the library',
  '  /prompts save <name>         save the last prompt you sent',
  '  /prompts save <name> <text>  save the given text',
  '  /prompts delete <name>       delete a prompt',
  `  /prompts export              write ${EXPORT_FILE} to the current folder`,
  '  /prompts import <path>       add prompts from a JSON file',
  'Use {{input}} in a prompt to be asked for a value before it is sent.',
].join('\n');

export function timeAgo(then, now) {
  if (typeof then !== 'number') return 'never';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
