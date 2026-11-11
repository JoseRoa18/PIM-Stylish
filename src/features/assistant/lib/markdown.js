// The part of Markdown an assistant's answer uses, as blocks: paragraphs,
// headings, lists (nested), tables, code, quotes and rules. Markdown.jsx draws
// them; answerTables.js turns the tables into an Excel file. An answer still
// being written (half a table) simply comes out as it stands.

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*>\s?/;

const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line) || (TABLE_ROW.test(line) && TABLE_RULE.test(next ?? ''));

export function parseMarkdown(source) {
  const src = source.replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const body = [];
      i += 1;
      while (i < src.length && !FENCE.test(src[i])) body.push(src[i++]);
      i += 1;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(src[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < src.length && TABLE_ROW.test(src[i])) rows.push(cells(src[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (ITEM.test(line)) {
      const items = [];
      const itemOf = (text) => {
        const m = text?.match(ITEM);
        return m ? { indent: m[1].length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] } : null;
      };
      // A numbered list right after a bulleted one (or the reverse) is another list.
      const sameList = (item) => !items.length || item.indent > items[0].indent || item.ordered === items[0].ordered;
      while (i < src.length) {
        const item = itemOf(src[i]);
        if (item) {
          if (!sameList(item)) break;
          items.push(item);
          i += 1;
        } else if (src[i].trim() && /^\s+/.test(src[i]) && items.length) {
          items.at(-1).text += `\n${src[i].trim()}`; // an item's own next line
          i += 1;
        } else if (!src[i].trim() && itemOf(src[i + 1]) && sameList(itemOf(src[i + 1]))) {
          i += 1; // a blank line between items
        } else break;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < src.length && QUOTE.test(src[i])) body.push(src[i++].replace(QUOTE, ''));
      blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }
    const para = [line];
    i += 1;
    while (i < src.length && src[i].trim() && !startsBlock(src[i], src[i + 1])) para.push(src[i++]);
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}
