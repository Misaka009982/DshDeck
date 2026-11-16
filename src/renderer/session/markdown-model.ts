export type InlinePart = { readonly kind: 'text' | 'strong' | 'em' | 'code' | 'strike' | 'link' | 'attachment'; readonly text: string };
export type MarkdownBlock =
  | { readonly kind: 'paragraph' | 'notice'; readonly text: string }
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'quote'; readonly blocks: readonly MarkdownBlock[] }
  | { readonly kind: 'rule' }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly { readonly text: string; readonly checked?: boolean }[] }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly align: readonly ('left' | 'center' | 'right')[]; readonly rows: readonly (readonly string[])[] };
const MAX_CHARS = 131072;
const MAX_BLOCKS = 1000;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u;
const LIST = /^( {0,3})([-+*]|\d{1,6}[.)])\s+(.*)$/u;
const QUOTE = /^ {0,3}> ?(.*)$/u;
const RULE = /^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/u;

/** 有界展示型 Markdown；没有 HTML 节点，也不携带可自动请求的图片地址。 */
export function markdownBlocks(raw: string, depth = 0): readonly MarkdownBlock[] {
  const source = raw.slice(0, MAX_CHARS).replace(/\r\n?/gu, '\n'); const lines = source.split('\n');
  const blocks: MarkdownBlock[] = []; let index = 0;
  while (index < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[index] ?? '';
    if (line.trim() === '') { index++; continue; }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```'; const closing = new RegExp(`^ {0,3}${marker[0] ?? '`'}{${marker.length},}\\s*$`, 'u');
      const text: string[] = []; index++;
      while (index < lines.length && !closing.test(lines[index] ?? '')) text.push(lines[index++] ?? '');
      if (index < lines.length) index++;
      blocks.push({ kind: 'code', language: (fence[2] ?? '').trim().slice(0, 64), text: text.join('\n') }); continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) { blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' }); index++; continue; }
    if (RULE.test(line)) { blocks.push({ kind: 'rule' }); index++; continue; }
    if (QUOTE.test(line) && depth < 4) {
      const text: string[] = [];
      while (index < lines.length) { const quoted = QUOTE.exec(lines[index] ?? ''); if (quoted === null) break; text.push(quoted[1] ?? ''); index++; }
      blocks.push({ kind: 'quote', blocks: markdownBlocks(text.join('\n'), depth + 1) }); continue;
    }
    const list = LIST.exec(line);
    if (list !== null) {
      const ordered = /^\d/u.test(list[2] ?? ''); const items: { text: string; checked?: boolean }[] = [];
      while (index < lines.length && items.length < 200) {
        const item = LIST.exec(lines[index] ?? '');
        if (item === null || /^\d/u.test(item[2] ?? '') !== ordered) break;
        let text = item[3] ?? ''; const checkbox = /^\[([ xX])\]\s+(.*)$/u.exec(text);
        if (checkbox !== null && !ordered) { text = checkbox[2] ?? ''; items.push({ text, checked: checkbox[1]?.toLowerCase() === 'x' }); }
        else items.push({ text });
        index++;
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(list[2] ?? '1', 10) : 1, items }); continue;
    }
    const align = tableAlignment(lines[index + 1] ?? '');
    if (line.includes('|') && align !== null) {
      const head = tableCells(line); const rows: string[][] = []; index += 2;
      while (index < lines.length && rows.length < 200 && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        const cells = tableCells(lines[index++] ?? ''); rows.push(head.map((_cell, cell) => cells[cell] ?? ''));
      }
      blocks.push({ kind: 'table', head, align: head.map((_cell, cell) => align[cell] ?? 'left'), rows }); continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim() === '' || FENCE.test(next) || HEADING.test(next) || RULE.test(next) || LIST.test(next)
        || (depth < 4 && QUOTE.test(next)) || next.includes('|') && tableAlignment(lines[index + 1] ?? '') !== null) break;
      paragraph.push(next); index++;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  if (raw.length > MAX_CHARS || index < lines.length) blocks.push({ kind: 'notice', text: '当前显示已达本机展示上限；完整内容可在原网页查看。' });
  return blocks;
}
export function inlineParts(text: string): readonly InlinePart[] {
  const pattern = /(`{1,3})([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|(!?)\[([^\[\]\n]{0,2048})\]\(([^()\n]{0,8192})\)/gu;
  const parts: InlinePart[] = []; let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, match.index) });
    if (match[2] !== undefined) parts.push({ kind: 'code', text: match[2] });
    else if (match[3] !== undefined || match[4] !== undefined) parts.push({ kind: 'strong', text: match[3] ?? match[4] ?? '' });
    else if (match[5] !== undefined) parts.push({ kind: 'strike', text: match[5] });
    else if (match[6] !== undefined || match[7] !== undefined) parts.push({ kind: 'em', text: match[6] ?? match[7] ?? '' });
    else if (match[8] === '!') parts.push({ kind: 'attachment', text: `图片${match[9] === '' ? '' : `：${match[9] ?? ''}`}（原网页查看）` });
    else parts.push({ kind: 'link', text: `${match[9] ?? ''}${match[10] === '' ? '' : ` (${match[10] ?? ''})`}` });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}
function tableCells(line: string): string[] {
  const source = line.trim().replace(/^\|/u, '').replace(/\|$/u, ''); const cells: string[] = [];
  let cell = ''; let code = false;
  for (let index = 0; index < source.length; index++) {
    const value = source[index] ?? '';
    if (value === '\\' && source[index + 1] === '|') { cell += '|'; index++; }
    else if (value === '`') { code = !code; cell += value; }
    else if (value === '|' && !code) { cells.push(cell.trim()); cell = ''; }
    else cell += value;
  }
  cells.push(cell.trim()); return cells;
}
function tableAlignment(line: string): ('left' | 'center' | 'right')[] | null {
  const cells = tableCells(line);
  if (cells.length === 0 || cells.some(cell => !/^:?-{3,}:?$/u.test(cell))) return null;
  return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
}
