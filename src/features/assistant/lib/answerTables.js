import { parseMarkdown } from './markdown';

// An answer's tables as an Excel file (user, 2026-11-11: "Bajar la respuesta
// a Excel"): one sheet per table, named after the heading above it, written
// by the PIM's own Excel writer (loaded when the button is pressed). A cell
// that is only a number is a number; everything else is its text, without
// the Markdown marks.

const plain = (cell) => String(cell ?? '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // a link is its text
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')
  .replace(/`([^`]+)`/g, '$1')
  .trim();

const value = (cell) => {
  const text = plain(cell);
  if (text === '—' || text === '-') return '';
  // "1,234.5" and "68" are numbers; "740 CAD", "S-611W" and "5 dic" stay text.
  return /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(text) ? Number(text.replace(/,/g, '')) : text;
};

/** The tables of an answer: [{ title, headers, rows }] — `title` is the heading above the table, when there is one. */
export function answerTables(markdown) {
  const tables = [];
  let heading = null;
  for (const block of parseMarkdown(markdown ?? '')) {
    if (block.type === 'heading') heading = plain(block.text);
    else if (block.type === 'table' && block.head.length && block.rows.length) {
      tables.push({ title: heading, headers: block.head.map(plain), rows: block.rows.map((row) => block.head.map((_, c) => value(row[c]))) });
      heading = null;
    }
  }
  return tables;
}

/** Downloads the answer's tables as one workbook; returns how many sheets it has. */
export async function downloadAnswerExcel(markdown) {
  const tables = answerTables(markdown);
  if (!tables.length) throw new Error('This answer has no table.');
  const { buildSectionedWorkbook } = await import('@/features/import/lib/sectionedXlsx');
  const sheets = tables.map((t, i) => ({
    name: (t.title || `Table ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31),
    sections: [{ title: 'Stylish PIM · Assistant', color: '8B0000', headers: t.headers }],
    rows: t.rows,
  }));
  const blob = await buildSectionedWorkbook(sheets);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Stylish_PIM_Assistant_${new Date().toLocaleDateString('en-CA')}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return sheets.length;
}
