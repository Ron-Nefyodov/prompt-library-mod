// Draws the /prompts pane. Pure: elements and actions come in, a tree goes out.
import { hasPlaceholder, timeAgo } from './library.js';

export const PANE_ID = 'prompts';
export const DEFAULT_VIEW = { query: '', selected: null, mode: 'browse', message: '', rev: 0 };

const NARROW_COLUMNS = 60;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function shorten(text, width) {
  if (width <= 1) return '';
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function previewText(text, width, lines) {
  const budget = Math.max(20, width * lines);
  const kept = text.split('\n').slice(0, lines).join('\n');
  return kept.length > budget || kept.length < text.length ? `${kept.slice(0, budget - 1).trimEnd()}…` : kept;
}

function usesLabel(uses) {
  return uses === 1 ? '1 use' : `${uses} uses`;
}

function windowAround(items, selectedIndex, size) {
  if (items.length <= size) return { start: 0, end: items.length };
  const start = clamp(selectedIndex - Math.floor(size / 2), 0, items.length - size);
  return { start, end: start + size };
}

function listRows(el, model, width, maxRows) {
  const { Box, Text, Button } = el;
  const { items, selected } = model;
  const selectedIndex = Math.max(0, items.indexOf(selected));
  const room = Math.max(1, maxRows);
  const { start, end } = windowAround(items, selectedIndex, room);
  const rows = [];
  if (start > 0) rows.push(Text({ dimColor: true, children: [`  ↑ ${start} more`] }));
  for (const item of items.slice(start, end)) {
    const isSelected = item === selected;
    const count = `${item.uses}×`;
    rows.push(Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text(isSelected ? { color: 'claude', bold: true, children: ['▸ '] } : { children: ['  '] }),
            Button({
              key: `row:${item.name}`,
              label: shorten(item.name, width - count.length - 4),
              plain: true,
              dimColor: !isSelected,
              onPress: () => model.act.select(item.name),
            }),
          ],
        }),
        Text({ dimColor: true, children: [count] }),
      ],
    }));
  }
  if (end < items.length) rows.push(Text({ dimColor: true, children: [`  ↓ ${items.length - end} more`] }));
  return Box({ flexDirection: 'column', width, flexShrink: 0, children: rows });
}

function previewBox(el, model, width, lines) {
  const { Box, Text } = el;
  const { selected, now } = model;
  const meta = [usesLabel(selected.uses), `last used ${timeAgo(selected.lastUsed, now)}`];
  if (hasPlaceholder(selected.text)) meta.push('asks for {{input}}');
  return Box({
    flexDirection: 'column',
    flexGrow: 1,
    borderStyle: 'round',
    borderColor: 'subtle',
    paddingX: 1,
    children: [
      Text({ bold: true, color: 'claude', wrap: 'truncate-end', children: [selected.name] }),
      Box({ key: 'meta', children: [Text({ dimColor: true, wrap: 'truncate-end', children: [meta.join(' · ')] })] }),
      Box({ key: 'preview', marginTop: 1, children: [Text({ wrap: 'wrap', children: [previewText(selected.text, Math.max(10, width - 4), lines)] })] }),
    ],
  });
}

function actionRow(el, model) {
  const { Box, Text, Button, Input } = el;
  const { selected, mode, act } = model;
  if (mode === 'fill') {
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text({ dimColor: true, children: ['Value for '] }),
            Text({ color: 'suggestion', children: ['{{input}}'] }),
            Text({ dimColor: true, children: [` in ${selected.name}`] }),
          ],
        }),
        Box({
          flexDirection: 'row',
          gap: 2,
          children: [
            Box({ flexGrow: 1, children: [Input({ key: 'fill', label: '› ', placeholder: 'e.g. src/app.ts', submitLabel: 'send', autoFocus: true, onSubmit: (value) => act.fill(value) })] }),
            Button({ key: 'cancel', label: 'Cancel', dimColor: true, onPress: () => act.cancel() }),
          ],
        }),
      ],
    });
  }
  if (mode === 'confirm') {
    return Box({
      flexDirection: 'row',
      gap: 2,
      children: [
        Text({ color: 'warning', children: [`Delete "${selected.name}"?`] }),
        Button({ key: 'confirm-delete', label: 'Delete', variant: 'primary', autoFocus: true, onPress: () => act.confirmDelete() }),
        Button({ key: 'cancel', label: 'Keep', onPress: () => act.cancel() }),
      ],
    });
  }
  return Box({
    flexDirection: 'row',
    gap: 2,
    children: [
      Button({ key: 'send', label: hasPlaceholder(selected.text) ? 'Send…' : 'Send', variant: 'primary', onPress: () => act.send() }),
      Button({ key: 'copy', label: 'Copy', onPress: (press) => act.copy(press) }),
      Button({ key: 'delete', label: 'Delete', dimColor: true, onPress: () => act.askDelete() }),
    ],
  });
}

function footer(el, model) {
  const { Box, Text } = el;
  if (model.message) {
    return Box({ key: 'message', children: [Text({ color: model.messageColor ?? 'success', children: [model.message] })] });
  }
  return Text({ dimColor: true, wrap: 'truncate-end', children: ['tab move · enter choose · esc close'] });
}

// model: { items, selected, total, query, mode, message, columns, rows, now, act }
export function drawPromptsPane(el, model) {
  const { Box, Text, Input } = el;
  const columns = Math.max(20, model.columns - 2);
  const rows = Math.max(6, model.rows);
  const isNarrow = columns < NARROW_COLUMNS;
  const counter = model.query ? `${model.items.length}/${model.total}` : `${model.total}`;

  const header = Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 1,
    children: [
      Box({
        flexGrow: 1,
        children: [Input({
          key: 'search',
          label: '⌕ ',
          placeholder: 'Search prompts',
          value: model.query,
          submitLabel: 'pick',
          ...(model.mode === 'browse' && { autoFocus: true }),
          onInput: (value) => model.act.search(value),
          onSubmit: (value) => model.act.pick(value),
        })],
      }),
      Text({ dimColor: true, children: [counter] }),
    ],
  });

  if (!model.selected) {
    const hint = model.total === 0
      ? 'Library is empty. Add one with /prompts save <name> <text>.'
      : `No prompts match "${model.query}".`;
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      gap: 1,
      children: [header, Box({ key: 'empty', children: [Text({ dimColor: true, children: [hint] })] }), footer(el, model)],
    });
  }

  const actionRows = model.mode === 'fill' ? 2 : 1;
  const chromeRows = 1 + 1 + actionRows + 1 + 2;
  let body;
  if (isNarrow) {
    const previewLines = clamp(Math.floor((rows - chromeRows) / 3), 1, 6);
    const listRoom = Math.max(2, rows - chromeRows - previewLines - 5);
    body = Box({
      flexDirection: 'column',
      children: [listRows(el, model, columns, listRoom), previewBox(el, model, columns, previewLines)],
    });
  } else {
    const listWidth = clamp(Math.floor(columns * 0.36), 22, 34);
    const room = Math.max(3, rows - chromeRows);
    body = Box({
      flexDirection: 'row',
      gap: 1,
      children: [listRows(el, model, listWidth, room), previewBox(el, model, columns - listWidth - 1, Math.max(2, room - 5))],
    });
  }

  return Box({
    flexDirection: 'column',
    paddingX: 1,
    children: [
      header,
      Box({ marginTop: 1, children: [body] }),
      Box({ marginTop: 1, children: [actionRow(el, model)] }),
      footer(el, model),
    ],
  });
}
