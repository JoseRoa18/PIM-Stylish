import { supabase } from '@/lib/supabase';
import { startTask } from '@/lib/taskProgress';
import { excelFileName, loadExcelSheet } from './excelSpec';

// An Excel file the assistant prepared, downloaded (user, 2026-11-12:
// "agrégale la función de crear documentos en Excel"). The card holds only
// the file's DESCRIPTION (assistant_files.spec). Here every sheet read from a
// table is read from the PIM with THIS PERSON'S session — so the file holds
// what they may see, as it is at this moment — and written by the PIM's own
// Excel writer (loaded now, like every exporter). A download is a slow thing:
// it runs under a progress card.

const BAND = '8B0000'; // the assistant's files (the answer's tables use the same)
const WRITER_FORMATS = new Set(['money', 'percent', 'link']); // the others are how a value is read, not a cell style

/** The database's API read with the person's session: (path, wantCount) => { rows, total }. */
async function readTable(path, wantCount) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Your session has expired. Sign in again.');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      ...(wantCount ? { Prefer: 'count=exact' } : {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // What the person may not see is said plainly; anything else keeps the database's reason.
    if (res.status === 401 || res.status === 403) throw new Error('your account may not read this data.');
    let reason = text;
    try {
      const body = JSON.parse(text);
      reason = [body.message, body.details].filter(Boolean).join(' — ');
    } catch { /* not JSON: the raw text */ }
    throw new Error(`the PIM could not read it (${res.status}): ${String(reason).slice(0, 300)}`);
  }
  const range = res.headers.get('content-range') ?? '';
  return { rows: JSON.parse(text), total: /\/(\d+)$/.test(range) ? Number(range.split('/')[1]) : null };
}

const count = (n) => Number(n).toLocaleString('en-US');

/**
 * Fills the file and hands it to the browser to save.
 * Returns { rows, sheets, name } — what was written.
 */
export async function downloadAssistantFile(file) {
  const task = startTask(`Excel — ${file.title}`, { detail: 'Reading the PIM…' });
  try {
    const specs = file.spec?.sheets ?? [];
    if (!specs.length) throw new Error('This file has no sheet.');
    const reading = task.part(0, 0.7);
    const sheets = [];
    let rows = 0;
    for (const [i, sheet] of specs.entries()) {
      const part = reading.part(i / specs.length, (i + 1) / specs.length);
      const data = await loadExcelSheet(sheet, readTable, {
        onRows: (done, total) => part.count(done, total, `Reading "${sheet.name}" — ${count(done)} of ${count(total)} rows`),
      }).catch((err) => {
        throw new Error(`Sheet "${sheet.name}": ${err.message}`);
      });
      part.progress(1);
      rows += data.rows.length;
      sheets.push({
        name: sheet.name,
        sections: [{ title: file.title, color: BAND, headers: data.headers }],
        rows: data.rows,
        formats: data.formats.map((format) => (WRITER_FORMATS.has(format) ? format : null)),
      });
    }

    const { buildSectionedWorkbook } = await import('@/features/import/lib/sectionedXlsx');
    const blob = await buildSectionedWorkbook(sheets, { task: task.part(0.7, 1) });
    const name = excelFileName(file.title, new Date().toLocaleDateString('en-CA'));
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    task.finish(`Downloaded — ${count(rows)} ${rows === 1 ? 'row' : 'rows'}`);
    return { rows, sheets: sheets.length, name };
  } catch (err) {
    task.fail(err);
    throw err;
  }
}
